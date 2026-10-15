const test = require('node:test');
const assert = require('node:assert/strict');
const {create}=require('../create-autosave');

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function clock(){let now=0,next=0;const jobs=new Map();return {now:()=>now,setTimeout:(fn,delay)=>{jobs.set(++next,{fn,at:now+delay});return next;},clearTimeout:id=>jobs.delete(id),async advance(ms){now+=ms;for(const [id,job]of jobs)if(job.at<=now){jobs.delete(id);job.fn();}await tick();}};}
function fixture(overrides={}){const time=clock();let document={supplierName:'A'};const writes=[],saved=[],statuses=[];let version=0;const saver=create({read:()=>document,serialize:x=>({...x,status:'draft'}),write:async(payload,meta)=>{writes.push({payload,meta});return {record:{...payload,id:'PCN-1',version:++version,status:'draft'}};},onSaved:value=>saved.push(value),onStatus:value=>statuses.push(value),clientDraftKey:'stable-uuid',...time,...overrides});return {saver,time,writes,saved,statuses,set:value=>{document=value;}};}

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
