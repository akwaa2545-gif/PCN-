const test = require('node:test');
const assert = require('node:assert/strict');

function fixture(options = {}) {
  const values = new Map();
  const statuses = [];
  const offers = [];
  const restored = [];
  let context = {userId:'alice',recordId:'PCN-1',version:1,ready:true,viewOnly:false,dirty:true};
  let snapshot = {fields:[{id:'reason',value:'Draft reason'}]};
  const timers = new Map();
  let timerId = 0;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key,value) => values.set(key,value),
    removeItem: key => values.delete(key)
  };
  const recovery = require('../document-recovery.js').create({
    storage, getContext:()=>context,capture:()=>snapshot,
    restore:value=>restored.push(value),onStatus:value=>statuses.push(value),onOffer:value=>offers.push(value),
    now:()=>options.now ?? 1000000,
    setTimeout:callback=>{timers.set(++timerId,callback);return timerId;},
    clearTimeout:id=>timers.delete(id), ...options
  });
  return {recovery,values,statuses,offers,restored,storage,
    setContext:value=>{context={...context,...value};},setSnapshot:value=>{snapshot=value;},
    flush:()=>{const pending=[...timers.values()];timers.clear();pending.forEach(callback=>callback());}
  };
}

test('debounces bounded, account-scoped drafts and writes schema and base version',()=>{
  const f=fixture();f.recovery.schedule();f.recovery.schedule();assert.equal(f.values.size,0);f.flush();
  assert.equal(f.values.size,1);
  const [key,raw]=[...f.values][0];const saved=JSON.parse(raw);
  assert.match(key,/alice/);assert.equal(saved.schema,1);assert.equal(saved.version,'1');
  assert.equal(saved.userId,'alice');assert.equal(saved.recordId,'PCN-1');
  assert.equal(saved.snapshot.fields[0].value,'Draft reason');assert.equal(f.statuses.at(-1).state,'saved');
});
test('offers once and restores only to the same pristine writable document',()=>{
  const f=fixture();f.recovery.schedule();f.flush();f.setContext({dirty:false});
  f.recovery.check();f.recovery.check();assert.equal(f.offers.length,1);
  assert.equal(f.offers[0].stale,false);assert.equal(f.offers[0].restore(),true);
  assert.equal(f.restored.length,1);assert.equal(f.offers[0].restore(),false);
});
test('new versions are stale and cannot restore or overwrite the server copy',()=>{
  const f=fixture();f.recovery.schedule();f.flush();f.setContext({dirty:false,version:2});f.recovery.check();
  assert.equal(f.offers[0].stale,true);assert.equal(f.offers[0].restore(),false);assert.equal(f.restored.length,0);
  assert.equal(f.offers[0].discard(),true);assert.equal(f.values.size,0);
});
test('an old offer cannot cross accounts, versions or revoked editing permissions',()=>{
  for(const change of [{userId:'bob'},{recordId:'PCN-2'},{version:2},{viewOnly:true},{dirty:true},{ready:false}]) {
    const f=fixture();f.recovery.schedule();f.flush();f.setContext({dirty:false});f.recovery.check();
    f.setContext(change);assert.equal(f.offers[0].restore(),false);assert.equal(f.restored.length,0);
  }
});
test('expired and malformed drafts are removed only from their own key',()=>{
  for(const corrupt of ['not json',JSON.stringify({schema:99}),null]) {
    const f=fixture();f.recovery.schedule();f.flush();const key=[...f.values.keys()][0];
    const raw=JSON.parse(f.values.get(key));f.values.set(key,corrupt??JSON.stringify({...raw,savedAt:1000000-8*86400000}));
    f.values.set('other-private-data','keep');f.setContext({dirty:false});f.recovery.check();
    assert.equal(f.offers.length,0);assert.equal(f.values.has(key),false);assert.equal(f.values.get('other-private-data'),'keep');
  }
});
test('accounts cannot see another employee draft and new documents have separate keys',()=>{
  const f=fixture();f.recovery.schedule();f.flush();f.setContext({dirty:false,userId:'bob'});f.recovery.check();
  assert.equal(f.offers.length,0);f.setContext({dirty:true,recordId:null});f.recovery.schedule();f.flush();
  assert.equal(f.values.size,2);
});
test('storage failure and excessive or non-JSON data report unavailable',()=>{
  const broken=fixture({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');},removeItem(){throw Error('blocked');}}});
  broken.recovery.schedule();broken.flush();assert.equal(broken.statuses.at(-1).state,'unavailable');
  for(const invalid of [{body:'x'.repeat(260000)},{bad:()=>{}},{bad:NaN}]) {
    const f=fixture();f.setSnapshot(invalid);f.recovery.schedule();f.flush();
    assert.equal(f.values.size,0);assert.equal(f.statuses.at(-1).state,'unavailable');
  }
});
test('confirmed-save cleanup preserves newer edits and cancels old pending timers',()=>{
  const f=fixture();const submitted={fields:[{id:'reason',value:'Draft reason'}]};
  f.recovery.schedule();f.flush();f.setSnapshot({fields:[{id:'reason',value:'Later edit'}]});
  assert.equal(f.recovery.clear(submitted),false);f.flush();
  assert.equal(JSON.parse([...f.values.values()][0]).snapshot.fields[0].value,'Later edit');
  assert.equal(f.recovery.clear({fields:[{id:'reason',value:'Later edit'}]}),true);f.flush();assert.equal(f.values.size,0);
});
test('read-only, unready and clean contexts do not persist, destroyed recovery does nothing',()=>{
  for(const change of [{viewOnly:true},{ready:false},{dirty:false},{userId:''}]) {
    const f=fixture();f.setContext(change);f.recovery.schedule();f.flush();assert.equal(f.values.size,0);
  }
  const f=fixture();f.recovery.schedule();f.recovery.destroy();f.flush();f.recovery.check();assert.equal(f.values.size,0);
});
test('pending storage writes cannot cross records or revoked permissions',()=>{
  for(const change of [{recordId:'PCN-2'},{userId:'bob'},{version:2},{viewOnly:true},{dirty:false}]) {
    const f=fixture();f.recovery.schedule();f.setContext(change);f.flush();assert.equal(f.values.size,0);
  }
});
test('offer actions preserve newer local edits and other-tab draft updates',()=>{
  for(const action of ['restore','discard']) {
    const f=fixture();f.recovery.schedule();f.flush();f.setContext({dirty:false});f.recovery.check();
    const key=[...f.values.keys()][0];const draft=JSON.parse(f.values.get(key));
    f.values.set(key,JSON.stringify({...draft,snapshot:{fields:[{id:'reason',value:'Other tab'}]}}));
    assert.equal(f.offers[0][action](),false);assert.equal(f.values.size,1);assert.equal(f.restored.length,0);
  }
  const f=fixture();f.recovery.schedule();f.flush();f.setContext({dirty:false});f.recovery.check();
  f.setContext({dirty:true});assert.equal(f.offers[0].discard(),false);assert.equal(f.values.size,1);
});
test('rejects wrong identity, future timestamps, deep or hostile JSON properties',()=>{
  for(const change of [{userId:'bob'},{recordId:'PCN-2'},{savedAt:2000000},{version:1},{snapshot:{constructor:'bad'}}]) {
    const f=fixture();f.recovery.schedule();f.flush();const key=[...f.values.keys()][0];
    const draft=JSON.parse(f.values.get(key));f.values.set(key,JSON.stringify({...draft,...change}));
    f.setContext({dirty:false});f.recovery.check();assert.equal(f.offers.length,0);assert.equal(f.values.size,0);
  }
  const f=fixture();let deep={field:'value'};for(let i=0;i<15;i++)deep={nested:deep};
  f.setSnapshot(deep);f.recovery.schedule();f.flush();assert.equal(f.statuses.at(-1).state,'unavailable');
});
test('read failures and failed restore are reported without claiming recovery',()=>{
  const denied=fixture({storage:{getItem(){throw Error('denied');}}});
  denied.setContext({dirty:false});denied.recovery.check();assert.equal(denied.statuses.at(-1).state,'unavailable');
  const f=fixture({restore(){throw Error('revoked');}});f.recovery.schedule();f.flush();
  f.setContext({dirty:false});f.recovery.check();assert.equal(f.offers[0].restore(),false);
  assert.equal(f.statuses.at(-1).state,'unavailable');assert.equal(f.values.size,1);
});
test('browser script exports recovery without CommonJS and does not touch storage at load',()=>{
  const fs=require('node:fs');const vm=require('node:vm');const scope={TextEncoder,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(require.resolve('../document-recovery.js'),'utf8'),scope);
  assert.equal(typeof scope.PCN_DOCUMENT_RECOVERY.create,'function');
});
