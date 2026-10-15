const test = require('node:test');
const assert = require('node:assert/strict');
const {create}=require('../create-autosave');
const vm=require('node:vm');
const fs=require('node:fs');

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function clock(){let now=0,next=0;const jobs=new Map();return {now:()=>now,setTimeout:(fn,delay)=>{jobs.set(++next,{fn,at:now+delay});return next;},clearTimeout:id=>jobs.delete(id),async advance(ms){now+=ms;for(const [id,job]of jobs)if(job.at<=now){jobs.delete(id);job.fn();}await tick();}};}
function fixture(overrides={}){const time=clock();let document={supplierName:'A'};const writes=[],saved=[],statuses=[];let version=0;const saver=create({read:()=>document,serialize:({supplierName})=>({supplierName,status:'draft'}),write:async(payload,meta)=>{writes.push({payload,meta});return {record:{...payload,id:'PCN-1',version:++version,status:'draft'}};},onSaved:value=>saved.push(value),onStatus:value=>statuses.push(value),clientDraftKey:'stable-uuid',...time,...overrides});return {saver,time,writes,saved,statuses,set:value=>{document=value;}};}

test('autosave does not write on open, debounces, reuses draft id and throttles automatic saves',async()=>{
  const f=fixture();await f.time.advance(20000);assert.equal(f.writes.length,0);
  f.saver.markDirty();await f.time.advance(1499);assert.equal(f.writes.length,0);await f.time.advance(1);assert.equal(f.writes.length,1);
  assert.equal(f.writes[0].meta.clientDraftKey,'stable-uuid');
  f.set({supplierName:'B'});f.saver.markDirty();await f.time.advance(1500);assert.equal(f.writes.length,1);await f.time.advance(8500);assert.equal(f.writes.length,2);
  assert.equal(f.writes[1].meta.id,'PCN-1');assert.equal(f.writes[1].meta.version,1);
  f.saver.stop();
});

test('single flight preserves edits during save and reports the snapshot actually saved',async()=>{
  let resolve;const f=fixture({write:(payload)=>new Promise(done=>{resolve=()=>done({record:{...payload,id:'PCN-1',version:1,status:'draft'}});})});
  f.saver.markDirty();const saving=f.saver.flush({force:true});await tick();
  f.set({supplierName:'B'});f.saver.markDirty();resolve();await saving;
  assert.equal(f.saved[0].snapshot.supplierName,'A');assert.equal(f.saver.getState().dirty,true);
  f.saver.stop();
});

test('test document creation flag travels as metadata while content serializer excludes it',async()=>{
  const f=fixture({serialize:({supplierName})=>({supplierName,status:'draft'})});
  f.set({supplierName:'TEST supplier',isTestDocument:true});f.saver.markDirty();await f.saver.flush({force:true});
  assert.equal(f.writes[0].meta.testDocument,true);
  assert.equal(f.writes[0].payload.isTestDocument,undefined);
  f.saver.stop();
});

test('idempotently reused POST adopts canonical baseline and PATCHes differing latest document',async()=>{
  const writes=[];const f=fixture({write:async(payload,meta)=>{writes.push({payload,meta});return writes.length===1?{record:{supplierName:'Older',status:'draft',id:'PCN-1',version:5},reused:true}:{record:{...payload,id:'PCN-1',version:6,status:'draft'}};}});
  f.saver.markDirty();await f.saver.flush({force:true});
  assert.equal(writes.length,2);assert.equal(writes[1].meta.id,'PCN-1');assert.equal(writes[1].meta.version,5);assert.equal(writes[1].payload.supplierName,'A');
  assert.equal(f.saver.getState().dirty,false);assert.equal(f.saved.at(-1).record.version,6);f.saver.stop();
});

test('conflict and network failures pause until explicit retry and retain create UUID',async()=>{
  for(const status of [409,503]){let calls=0;const keys=[];const f=fixture({write:async(payload,meta)=>{calls++;keys.push(meta.clientDraftKey);if(calls===1)throw Object.assign(new Error('failed'),{status});return {record:{...payload,id:'PCN-1',version:1,status:'draft'}};}});
    f.saver.markDirty();await assert.rejects(f.saver.flush({force:true}));
    f.set({supplierName:'B'});f.saver.markDirty();await f.time.advance(20000);assert.equal(calls,1);
    await f.saver.retry();assert.equal(calls,2);assert.deepEqual(keys,['stable-uuid','stable-uuid']);f.saver.stop();}
});

test('exclusive operations wait for in flight save and adopt version before subsequent autosave',async()=>{
  const f=fixture();f.saver.markDirty();let used;
  await f.saver.exclusive(async record=>{used=record;return {record:{...record,version:2}};});
  assert.equal(used.id,'PCN-1');assert.equal(used.version,1);
  f.set({supplierName:'B'});f.saver.markDirty();await f.saver.flush({force:true});assert.equal(f.writes.at(-1).meta.version,2);
  f.saver.adopt({...used,status:'submitted',version:3});f.saver.markDirty();await f.time.advance(20000);assert.equal(f.writes.length,2);f.saver.stop();
});

test('overlapping flush requests serialize and cancel duplicate writes',async()=>{
  let release;let calls=0;const f=fixture({write:async payload=>{calls++;await new Promise(resolve=>{release=resolve;});return {record:{...payload,id:'PCN-1',version:1,status:'draft'}};}});
  f.saver.markDirty();const first=f.saver.flush({force:true}), second=f.saver.flush({force:true});await tick();assert.equal(calls,1);
  release();await Promise.all([first,second]);assert.equal(calls,1);assert.equal(f.saver.getState().pending,false);f.saver.stop();
});

test('signed drafts and stopped pages never schedule writes',async()=>{
  for(const internalReview of [{supplierSignoff:{prepared:{checked:true}}},{signoff:{gscTet:{prepared:true}}},{qateFinal:{signoff:{approved:true}}}]) {
    const f=fixture({initialRecord:{id:'PCN-1',version:1,status:'draft',internalReview}});f.saver.markDirty();await f.saver.flush({force:true});await f.time.advance(20000);assert.equal(f.writes.length,0);f.saver.stop();
  }
  const f=fixture();f.saver.markDirty();f.saver.stop();await f.time.advance(20000);await f.saver.flush({force:true});assert.equal(f.writes.length,0);
});

test('exclusive conflicts pause automatic writes and preserve the last canonical version',async()=>{
  const f=fixture();f.saver.markDirty();await f.saver.flush({force:true});
  await assert.rejects(f.saver.exclusive(async()=>{throw Object.assign(new Error('File version changed'),{status:409});}));
  f.set({supplierName:'B'});f.saver.markDirty();await f.time.advance(20000);
  assert.equal(f.writes.length,1);assert.equal(f.saver.getState().record.version,1);assert.equal(f.saver.getState().state,'conflict');f.saver.stop();
});

test('browser autosave uses the shared content serializer and validates adapters',async()=>{
  const context={PCN_CREATE_MODEL:require('../create-model'),setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(require.resolve('../create-autosave'),'utf8'),context);
  assert.throws(()=>create({}),/read and write/);
  const writes=[];const saver=context.PCN_CREATE_AUTOSAVE.create({read:()=>({supplierName:'Browser',status:'approved',id:'not-copied'}),
    write:async payload=>{writes.push(payload);return {record:{...payload,id:'PCN-1',status:'draft',version:1}};}});
  saver.markDirty();await saver.flush({force:true});assert.equal(writes[0].status,undefined);assert.equal(writes[0].id,undefined);
  assert.throws(()=>saver.adopt({}),/saved record/);saver.stop();await saver.retry();assert.equal(writes.length,1);
});

test('unchanged canonical content is not rewritten and malformed responses are reported',async()=>{
  const f=fixture({initialRecord:{id:'PCN-1',version:1,status:'draft',supplierName:'A'}});
  f.saver.markDirty();await f.saver.flush({force:true});assert.equal(f.writes.length,0);f.saver.stop();
  const malformed=fixture({write:async()=>({})});malformed.saver.markDirty();await assert.rejects(malformed.saver.flush({force:true}),/saved record/);
  assert.equal(malformed.saver.getState().state,'error');malformed.saver.stop();
});

test('exclusive operation drains edits arriving during its prerequisite save',async()=>{
  let release;let writes=0;let used;const f=fixture({write:async payload=>{writes++;if(writes===1)await new Promise(resolve=>{release=resolve;});return {record:{...payload,id:'PCN-1',version:writes,status:'draft'}};}});
  f.saver.markDirty();const operation=f.saver.exclusive(async record=>{used=record;return {record:{...record,status:'submitted',version:record.version+1}};});
  await tick();f.set({supplierName:'B'});f.saver.markDirty();release();await operation;
  assert.equal(used.supplierName,'B');assert.equal(used.version,2);assert.equal(writes,2);assert.equal(f.saver.getState().dirty,false);f.saver.stop();
});

test('exclusive operation refuses stale content if editing continues through repeated saves',async()=>{
  let writes=0,operations=0;let f;f=fixture({write:async payload=>{writes++;f.set({supplierName:`Edit ${writes}`});f.saver.markDirty();return {record:{...payload,id:'PCN-1',version:writes,status:'draft'}};}});
  f.saver.markDirty();await assert.rejects(f.saver.exclusive(async()=>{operations++;}),/editing|changes/i);
  assert.equal(operations,0);assert.equal(writes,3);assert.equal(f.saver.getState().dirty,true);f.saver.stop();
});

test('reused submitted draft reports canonical state and preserves unsaved local content',async()=>{
  let writes=0;const f=fixture({write:async()=>{writes++;return {record:{id:'PCN-1',supplierName:'Previously submitted',status:'submitted',version:8},reused:true};}});
  f.saver.markDirty();await f.saver.flush({force:true});
  assert.equal(writes,1);assert.equal(f.saver.getState().state,'stopped');assert.equal(f.saver.getState().dirty,true);
  assert.equal(f.saved.length,1);assert.equal(f.saved[0].record.status,'submitted');assert.equal(f.saved[0].unsavedChanges,true);
  assert.equal(f.saved[0].snapshot.supplierName,'A');assert.equal(f.statuses.at(-1).unsavedChanges,true);
  await f.time.advance(20000);assert.equal(writes,1);f.saver.stop();
});

test('reused signed draft is reported read only without attempting to patch signatures',async()=>{
  let writes=0;const f=fixture({write:async()=>{writes++;return {record:{id:'PCN-1',supplierName:'Signed content',status:'draft',version:8,
    internalReview:{supplierSignoff:{prepared:{checked:true}}}},reused:true};}});
  f.saver.markDirty();await f.saver.flush({force:true});assert.equal(writes,1);assert.equal(f.saver.getState().state,'stopped');
  assert.equal(f.saved[0].record.internalReview.supplierSignoff.prepared.checked,true);assert.equal(f.saved[0].unsavedChanges,true);f.saver.stop();
});

test('edits during exclusive attachment work remain dirty at the adopted version',async()=>{
  let release;const f=fixture();f.saver.markDirty();
  const operation=f.saver.exclusive(async record=>{await new Promise(resolve=>{release=resolve;});return {record:{...record,version:2}};});
  await tick();f.set({supplierName:'B'});f.saver.markDirty();release();await operation;
  assert.equal(f.saver.getState().dirty,true);await f.saver.flush({force:true});assert.equal(f.writes.at(-1).payload.supplierName,'B');assert.equal(f.writes.at(-1).meta.version,2);f.saver.stop();
});
