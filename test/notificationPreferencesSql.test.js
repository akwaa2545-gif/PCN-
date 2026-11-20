const test=require('node:test');
const assert=require('node:assert/strict');
const {SqlNotificationPreferences}=require('../src/sqlNotificationPreferences');
const {defaultNotificationPreferences}=require('../src/notificationPreferences');
const {settingsVersion}=require('../src/mailRouting');
const {SqlPcnRepository}=require('../src/sqlPcnRepository');
const {PcnService}=require('../src/pcnService');
const {normalizeMailRouting}=require('../src/mailRouting');
const {readNotificationPreferenceUsers}=require('../src/notificationPreferenceUsers');
const user={id:'00000000-0000-4000-8000-000000000001',version:'0000000000000001',sessionSecurityStamp:'stamp'};
const initial={schemaVersion:2,groups:[{key:'department.gscTet.prepared',label:'GSC',emails:'manual@example.test',recipients:[]}],legacyGroups:[]};
const payload=()=>({schemaVersion:1,version:settingsVersion(initial),rules:defaultNotificationPreferences().rules});
function pool(options={}) {
  const calls=[];let stored=structuredClone(initial);
  const request=()=>{const inputs={};return {input(key,type,value){inputs[key]=value;return this;},async query(statement){
    calls.push({statement,inputs});
    if(statement.includes('sp_getapplock'))return {recordset:[{LockResult:0}]};
    if(statement.includes('SELECT IsActive,SecurityStamp,AccessVersion'))return {recordset:[{IsActive:true,SecurityStamp:options.stale?'changed':'stamp',AccessVersion:Buffer.from(user.version,'hex')}]};
    if(statement.includes('RoleName')&&!statement.includes('MailProfileJson'))return {recordset:[{IsActive:true,RoleName:options.role||'admin',DepartmentKey:options.department,SigningStep:null}]};
    if(statement.includes('MailProfileJson'))return {recordset:[]};
    if(statement.includes('SELECT SettingsJson'))return {recordset:[{SettingsJson:options.corrupt||JSON.stringify(stored)}]};
    if(statement.includes('UPDATE pcn.NotificationSettings')) {if(options.writeFailure)throw new Error('write failed');stored=JSON.parse(inputs.json);return {recordset:[],rowsAffected:[1]};}
    if(statement.includes('INSERT pcn.AuditLogs')&&options.auditFailure)throw new Error('audit failed');
    return {recordset:[],rowsAffected:[1]};
  }};};
  const tx={request,async begin(){calls.push('begin');},async commit(){calls.push('commit');},async rollback(){calls.push('rollback');}};
  return {request,transaction:()=>tx,calls,stored:()=>stored};
}
test('SQL preference save merges routing unchanged, rechecks actor and role, audits under one transaction',async()=>{
  const db=pool(),adapter=new SqlNotificationPreferences(db);
  const before=await adapter.get();assert.equal(before.version,settingsVersion(initial));
  const saved=await adapter.save(payload(),'user:admin',user);
  assert.equal(saved.options.types.length,6);assert.equal(saved.updatedBy,'user:admin');assert.ok(saved.updatedAt);
  assert.deepEqual(db.stored().groups,initial.groups);assert.deepEqual(db.stored().legacyGroups,[]);
  assert.equal(db.calls.at(-1),'commit');
  const write=db.calls.find(call=>call.statement?.includes('UPDATE pcn.NotificationSettings'));
  assert.doesNotMatch(write.statement,/manual@example/);assert.match(db.calls.find(call=>call.statement?.includes('SELECT SettingsJson')&&call.statement.includes('UPDLOCK')).statement,/HOLDLOCK/);
  assert.ok(db.calls.find(call=>call.statement?.includes('INSERT pcn.AuditLogs')));
  await assert.rejects(adapter.save(payload(),'user:admin',user),{statusCode:409});
});
test('SQL preference save rolls back stale actors, lost admin, corrupt settings, write and audit failures',async()=>{
  for(const [options,error] of [[{stale:true},{statusCode:401}],[{role:'reviewer'},{statusCode:403}],[{corrupt:'{'},{statusCode:503}],
    [{writeFailure:true},/write failed/],[{auditFailure:true},/audit failed/]]) {
    const db=pool(options);await assert.rejects(new SqlNotificationPreferences(db).save(payload(),'actor',user),error);
    assert.equal(db.calls.at(-1),'rollback');
  }
  const db=pool();await assert.rejects(new SqlNotificationPreferences(db).save(payload(),'actor'),{statusCode:401});assert.deepEqual(db.calls,[]);
});

test('repository delegates preferences and ordinary mail routing saves preserve the current policy authoritatively',async()=>{
  const db=pool(),repository=new SqlPcnRepository(db);
  const preferences=await repository.saveNotificationPreferences(payload(),'actor',user);
  const current=db.stored();
  const edited={schemaVersion:2,groups:[],legacyGroups:[],notificationPreferences:{malicious:true}};
  const returned=await repository.saveNotificationSettings(edited,'actor',preferences.version,user);
  assert.deepEqual(returned.notificationPreferences,current.notificationPreferences);
  assert.deepEqual(db.stored().notificationPreferences,current.notificationPreferences);
  assert.deepEqual(db.stored().groups,[]);
  const snapshot=await repository.getNotificationPreferences();
  assert.equal(snapshot.version,settingsVersion(db.stored()));
  await assert.rejects(repository.saveNotificationPreferences({...payload(),version:preferences.version},'actor',user),{statusCode:409});
});

test('mail routing service preserves preference metadata in non-SQL adapters',async()=>{
  let stored={...initial,notificationPreferences:defaultNotificationPreferences()};
  const repository={async getNotificationSettings(){return structuredClone(stored);},async saveNotificationSettings(value,actor,expected){assert.equal(expected,settingsVersion(stored));stored=structuredClone(value);}};
  const service=new PcnService(repository);const view=normalizeMailRouting(stored);
  await service.updateNotificationSettings({schemaVersion:2,version:view.version,groups:view.groups},'actor',{roles:['admin']});
  assert.deepEqual(stored.notificationPreferences,defaultNotificationPreferences());
});

test('policy identity reads retain inactive and unverified accounts for exclusions without exposing them as choices',async()=>{
  const id='00000000-0000-4000-8000-000000000002';let query;
  const users=await readNotificationPreferenceUsers({request(){return {async query(statement){query=statement;return {recordset:[
    {Id:id,EmployeeCode:'0012345',DisplayName:'Inactive recipient',IsActive:0,IdentityProvider:'pcn-local',Email:'old@example.test',MailProfileJson:'{',RoleName:'qa'},
    {Id:id,IsActive:0,IdentityProvider:'pcn-local',RoleName:'reviewer'}]};}};}});
  assert.equal(users.length,1);assert.equal(users[0].isActive,false);assert.equal(users[0].email,'old@example.test');
  assert.deepEqual(users[0].roles,['qa','reviewer']);assert.equal(users[0].mailProfile,null);
  assert.doesNotMatch(query,/WHERE u\.IsActive=1/);
});
