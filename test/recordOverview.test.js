const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecordOverview, loadRecordOverview } = require('../src/recordOverview');
const { unsignedPayload } = require('./helpers/apiHarness');
const { ApiError } = require('../src/apiError');
const { SqlDocuments } = require('../src/sqlDocuments');
const { SqlRevisions } = require('../src/sqlRevisions');

const now = new Date('2026-10-14T12:00:00Z');
const viewer = {id:'viewer',roles:[],employeeCode:'1234567',identityProvider:'employee-code',isActive:true};
const admin = {id:'admin',roles:['admin'],isActive:true};
const record = { ...unsignedPayload,id:'PCN-2026-0001',version:'0000000000000001',status:'submitted',createdAt:'2026-10-01T12:00:00Z',updatedAt:'2026-10-12T12:00:00Z',
  internalReview:{docs:{hazardousReport:true},signoff:{gscTet:{approved:true}}}};
const assigned = {displayName:'Assigned Checker',email:'private@example.test',mailProfile:{secret:true},employeeCode:'7654321',roles:['gsc'],department:'gscTet',signingStep:'checked',isActive:true};
const clean = {scanStatus:'clean',requirementName:'hazardousReport'};

test('overview uses workflow rules, minimal assignees and actual saved-age provenance', () => {
  const result = buildRecordOverview(record,admin,[assigned], [clean], now);
  assert.equal(result.dashboard.action.signingStep,'checked');
  assert.deepEqual(result.dashboard.action.people,[{displayName:'Assigned Checker'}]);
  assert.equal(result.dashboard.documents.state,'ready');
  assert.equal(result.dashboard.documents.completeCount,1);
  assert.equal(result.dashboard.pending.source,'updatedAt');
  assert.equal(result.dashboard.pending.ageDays,2);
  assert.equal(result.dashboard.pending.overdue,null);
  assert.equal(result.dashboard.progress.completedSignatures,1);
  assert.ok(result.dashboard.progress.totalSignatures>1);
  assert.equal(JSON.stringify(result.dashboard).includes('private@example.test'),false);
  const readOnly=buildRecordOverview(record,viewer,[assigned],[clean],now).dashboard.action;
  assert.equal(readOnly.canAct,false); assert.deepEqual(readOnly.people,[]);
});

test('deleted, quarantined, missing and unknown documents never appear ready', () => {
  for (const files of [[],[{...clean,deletedAt:'2026-10-13'}],[{...clean,scanStatus:'quarantined'}],[{...clean,scanStatus:'pendingScan'}]]) {
    const info = buildRecordOverview(record,admin,[],files,now).dashboard;
    assert.equal(info.documents.state,'missing');
    assert.equal(info.documents.ready,false);
    assert.equal(info.pending.needsAttention,true);
    assert.equal(info.documents.missing[0].key,'hazardousReport');
  }
  const unknown=buildRecordOverview(record,admin,[],null,now).dashboard;
  assert.equal(unknown.documents.state,'unknown');
  assert.equal(unknown.documents.ready,null);
  assert.equal(unknown.pending.needsAttention,true);
});

test('overdue requires explicit valid review deadline and active record; desiredStart never creates a deadline', () => {
  assert.equal(buildRecordOverview({...record,desiredStart:'2026-01-01'},admin,[],[],now).dashboard.pending.overdue,null);
  assert.equal(buildRecordOverview({...record,reviewDueAt:'2026-10-13T12:00:00Z'},admin,[],[],now).dashboard.pending.overdue,true);
  assert.equal(buildRecordOverview({...record,reviewDueAt:'not a date'},admin,[],[],now).dashboard.pending.overdue,null);
  assert.equal(buildRecordOverview({...record,status:'approved',reviewDueAt:'2026-10-01'},admin,[],[],now).dashboard.pending.overdue,false);
  const missing=buildRecordOverview({...record,createdAt:undefined,updatedAt:undefined},admin,[],[],now).dashboard.pending;
  assert.equal(missing.since,null); assert.equal(missing.ageDays,null); assert.equal(missing.source,'unknown');
  assert.equal(buildRecordOverview({...record,reviewDueAt:'2026-02-31'},admin,[],[],now).dashboard.pending.reviewDueAt,null);
  assert.equal(buildRecordOverview({...record,updatedAt:'2026-10-12T02:00:00+07:00'},admin,[],[],now).dashboard.pending.since,'2026-10-11T19:00:00.000Z');
});

test('supplier names remain restricted and active assignees require correct signing permission', () => {
  const supplier={id:'supplier',roles:['supplier'],isActive:true};
  assert.deepEqual(buildRecordOverview(record,supplier,[assigned],[clean],now).dashboard.action.people,[]);
  const users=[assigned,{...assigned,displayName:'Disabled',isActive:false},{...assigned,displayName:'Wrong role',roles:['supplier']}];
  assert.deepEqual(buildRecordOverview(record,admin,users,[clean],now).dashboard.action.people,[{displayName:'Assigned Checker'}]);
});

test('loader reads scoped list first and batches documents and accounts once', async () => {
  const calls=[];
  const result=await loadRecordOverview({service:{async list(filters,user){calls.push(['list',user.id]);return [record];}},
    authService:{repository:{async listUsers(){calls.push(['users']);return [assigned];}}},
    documents:{async listForRecords(ids){calls.push(['documents',ids]);return new Map([[record.id,{parentVersion:record.version,attachments:[clean]}]]);}}},admin,{},now);
  assert.deepEqual(calls,[['list','admin'],['users'],['documents',[record.id]]]);
  assert.equal(result.items[0].dashboard.documents.state,'ready'); assert.equal(result.generatedAt,now.toISOString());
});

test('roleless and supplier overview never reads privileged accounts',async()=>{
  for(const user of [viewer,{id:'supplier',roles:['supplier'],isActive:true}]){
    let calls=0;
    const context={service:{async list(){return [record];}},authService:{repository:{async listUsers(){calls++;throw new Error('No account lookup allowed');}}}};
    const result=await loadRecordOverview(context,user,{},now);
    assert.equal(calls,0);assert.deepEqual(result.items[0].dashboard.action.people,[]);
  }
});

test('loader marks storage failures unknown, but authorization failures propagate', async () => {
  const context={service:{async list(){return [record];}},authService:{repository:{async listUsers(){return [];}}}};
  assert.equal((await loadRecordOverview(context,admin,{},now)).items[0].dashboard.documents.state,'unknown');
  assert.equal((await loadRecordOverview({...context,documents:{async listForRecords(){throw new Error('offline');}}},admin,{},now)).items[0].dashboard.documents.state,'unknown');
  await assert.rejects(loadRecordOverview({...context,documents:{async listForRecords(){throw new ApiError(403,'Denied');}}},admin,{},now),{statusCode:403});
  await assert.rejects(loadRecordOverview({...context,documents:{async listForRecords(){throw {status:401};}}},admin,{},now),{status:401});
});

test('SQL batch document lookup validates ids and binds chunks without bytes', async () => {
  const calls=[];
  const pool={request(){const bindings=[];return {input(name,type,value){bindings.push([name,value]);return this;},async query(statement){calls.push({bindings,statement});return {recordset:bindings.map(([,PcnCode])=>({PcnCode,Id:'file',ScanStatus:'clean',RequirementName:'hazardousReport'}))};}};}};
  const store=new SqlDocuments(pool);
  const ids=Array.from({length:401},(_,index)=>`PCN-2026-${String(index+1).padStart(4,'0')}`);
  const result=await store.listForRecords(ids);
  assert.deepEqual(calls.map(call=>call.bindings.length),[400,1]);
  assert.equal(result.get(ids[400]).attachments[0].scanStatus,'clean');
  for(const call of calls){assert.match(call.statement,/DeletedAt IS NULL/);assert.doesNotMatch(call.statement,/\bBytes\b|SELECT \*/i);assert.equal(call.statement.includes(ids[0]),false);}
  await assert.rejects(store.listForRecords(['PCN-2026-0001\';DROP TABLE pcn.PcnRequests']),{statusCode:400});
  assert.equal(calls.length,2);
});

test('scoped loader uses stored current-status transition and rejects mixed document versions',async()=>{
  const context={service:{async list(){return [record];}},authService:{repository:{async listUsers(){return [];}}},
    repository:{async getStatusTimings(ids){assert.deepEqual(ids,[record.id]);return new Map([[record.id,{parentVersion:record.version,status:'submitted',since:'2026-10-03T12:00:00Z'}]]);}},
    documents:{async listForRecords(){return new Map([[record.id,{parentVersion:'0000000000000002',attachments:[clean]}]]);}}};
  const result=(await loadRecordOverview(context,admin,{},now)).items[0].dashboard;
  assert.equal(result.pending.source,'status_transition'); assert.equal(result.pending.ageDays,11);
  assert.equal(result.documents.state,'unknown');
  const changed=(await loadRecordOverview({...context,repository:{async getStatusTimings(){return new Map([[record.id,{parentVersion:'0000000000000002',status:'submitted',since:'2026-10-03T12:00:00Z'}]]);}}},admin,{},now)).items[0].dashboard.pending;
  assert.equal(changed.source,'updatedAt'); assert.equal(changed.ageDays,2);
});

test('SQL status timing batch is parameterized metadata only, includes baseline continuity and parent version',async()=>{
  const calls=[];
  const source={request(){const values=[];return {input(name,type,value){values.push(value);return this;},async query(statement){calls.push({values,statement});return {recordset:[{PcnCode:record.id,RowVersion:Buffer.from(record.version,'hex'),Status:'submitted',Since:new Date('2026-10-03T12:00:00Z')}]};}};}};
  const result=await new SqlRevisions().statusTimings(source,[record.id]);
  assert.equal(result.get(record.id).parentVersion,record.version);
  assert.equal(result.get(record.id).since,'2026-10-03T12:00:00.000Z');
  assert.deepEqual(calls[0].values,[record.id]);
  assert.match(calls[0].statement,/IsBaseline/); assert.match(calls[0].statement,/LAG\(/i);
  assert.match(calls[0].statement,/DeletedAt IS NULL/); assert.doesNotMatch(calls[0].statement,/SnapshotJson|ChangesJson/);
});

test('status batches are bounded, empty lists read nothing, and legacy baselines use honest fallback',async()=>{
  const calls=[];
  const source={request(){const ids=[];return {input(name,type,value){ids.push(value);return this;},async query(statement){calls.push(ids);return {recordset:[]};}};}};
  const revisions=new SqlRevisions();
  await revisions.statusTimings(source,[]);
  assert.equal(calls.length,0);
  await revisions.statusTimings(source,Array.from({length:401},(_,i)=>`PCN-2026-${String(i+1).padStart(4,'0')}`));
  assert.deepEqual(calls.map(batch=>batch.length),[400,1]);
  await assert.rejects(revisions.statusTimings(source,['invalid']),{statusCode:400});
  const context={service:{async list(){return [record];}},authService:{repository:{async listUsers(){return [];}}},
    repository:{async getStatusTimings(){return new Map([[record.id,{parentVersion:record.version,status:record.status,since:null}]]);}}};
  assert.equal((await loadRecordOverview(context,admin,{},now)).items[0].dashboard.pending.source,'updatedAt');
  await assert.rejects(loadRecordOverview({...context,repository:{async getStatusTimings(){throw new ApiError(403,'Denied');}}},admin,{},now),{statusCode:403});
});
