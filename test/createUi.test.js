const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../create');

test('Create entry links accept only one supported start choice and preserve explicit draft links',()=>{
  for(const choice of ['blank','starter','copy','resume'])assert.equal(ui.entryIntent(`?start=${choice}`),choice);
  for(const search of ['', '?start=unknown','?start=blank&start=copy','?start=copy&draft=PCN-2026-0001'])assert.equal(ui.entryIntent(search),null);
});

test('Document preview accepts only its own same-origin frame and requested record version',()=>{
  const source={},origin='http://pcn.test',id='PCN-2026-0001',version='1234567890abcdef';
  const expected={source,origin,id,version,request:'1'};
  const data={type:'pcn-document-preview',state:'ready',id,version,request:'1'};
  const event={source,origin,data};
  assert.equal(ui.isPreviewMessage(event,expected),true);
  assert.equal(ui.isPreviewMessage({...event,data:{...data,state:'error'}},expected),true);
  for(const invalid of [{...event,source:{}},{...event,origin:'http://elsewhere.test'},
    {...event,data:{...data,id:'PCN-2026-0002'}},{...event,data:{...data,version:'0000000000000000'}},
    {...event,data:{...data,request:'old'}},{...event,data:{...data,type:'other'}},{...event,data:{...data,state:'pending'}},{...event,data:null}]) {
    assert.equal(ui.isPreviewMessage(invalid,expected),false);
  }
  assert.equal(ui.isPreviewMessage(event,null),false);
});

function submissionFixture(extra = {}) {
  const calls = [];
  const record = {id:'PCN-2026-0001',version:'1111111111111111',status:'draft'};
  const controller = ui.createSubmission({
    autosave:{flush:async()=>{calls.push('flush');return record;},exclusive:async work=>work(record),stop:()=>calls.push('stop')},
    api:async(path,options)=>{
      calls.push([path,options]);
      if(path.endsWith('/preflight'))return {checks:{ready:true,items:[]},nextAction:{label:'GSC/TET — Prepared'}};
      if(path.includes('/receipt?'))return {id:record.id,notification:{state:'queued'}};
      return {...record,status:'submitted',version:'2222222222222222'};
    },
    ...extra
  });
  return {controller,calls,record};
}

test('Create submission flushes drafts and preflights before an explicit status-only update',async()=>{
  const {controller,calls}=submissionFixture();
  const receipt=await controller.submit();
  assert.equal(calls[0],'flush');
  assert.equal(calls[1][0],'/api/pcn-drafts/PCN-2026-0001/preflight');
  assert.deepEqual(JSON.parse(calls[1][1].body),{version:'1111111111111111'});
  assert.equal(calls[2][0],'/api/pcns/PCN-2026-0001');
  assert.equal(calls[2][1].method,'PATCH');
  assert.deepEqual(JSON.parse(calls[2][1].body),{version:'1111111111111111',status:'submitted'});
  assert.equal(calls[3],'stop');
  assert.equal(calls[4][0],'/api/pcns/PCN-2026-0001/receipt?version=2222222222222222');
  assert.equal(receipt.notification.state,'queued');
});

test('Incomplete preflight preserves editable content and cannot send submission',async()=>{
  const calls=[];
  const {controller}=submissionFixture({api:async path=>{calls.push(path);return {checks:{ready:false,items:[{key:'reason',label:'Reason for change',field:'reason',blocking:true,complete:false}]}};}});
  await assert.rejects(controller.submit(),error=>error.details?.missing?.[0].field==='reason');
  assert.deepEqual(calls,['/api/pcn-drafts/PCN-2026-0001/preflight']);
});

test('Double click shares the single submission and receipt request',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const fixture=submissionFixture({autosave:{flush:async()=>{await gate;return {id:'PCN-2026-0001',version:'1111111111111111',status:'draft'};},exclusive:async work=>work(),stop(){}}});
  const first=fixture.controller.submit(),second=fixture.controller.submit();
  release();
  assert.deepEqual(await first,await second);
  assert.equal(fixture.calls.filter(call=>Array.isArray(call)&&call[1]?.method==='PATCH').length,1);
});

test('Lost submission reply recovers a submitted canonical record without resubmitting',async()=>{
  const calls=[];
  const {controller}=submissionFixture({api:async(path,options)=>{
    calls.push([path,options]);
    if(path.endsWith('/preflight'))return {checks:{ready:true,items:[]}};
    if(options?.method==='PATCH')throw new TypeError('Network unavailable');
    if(path.includes('/receipt?'))return {id:'PCN-2026-0001',notification:{state:'processing'}};
    return {id:'PCN-2026-0001',version:'3333333333333333',status:'submitted'};
  }});
  assert.equal((await controller.submit()).notification.state,'processing');
  assert.equal(calls.filter(call=>call[1]?.method==='PATCH').length,1);
  assert.equal(calls.at(-1)[0],'/api/pcns/PCN-2026-0001/receipt?version=3333333333333333');
});

test('A lost reply with a still-draft canonical record requires a new user action',async()=>{
  const calls=[];
  const {controller}=submissionFixture({api:async(path,options)=>{
    calls.push(path);
    if(path.endsWith('/preflight'))return {checks:{ready:true,items:[]}};
    if(options?.method==='PATCH')throw new TypeError('Network unavailable');
    return {id:'PCN-2026-0001',version:'1111111111111111',status:'draft'};
  }});
  await assert.rejects(controller.submit(),/not confirmed|try.*again/i);
  assert.equal(calls.filter(path=>path.includes('/receipt?')).length,0);
});

test('A lost receipt reply still reports confirmed submission without repeating the status update',async()=>{
  let updates=0;
  const {controller}=submissionFixture({api:async(path,options)=>{
    if(path.endsWith('/preflight'))return {checks:{ready:true,items:[]},nextAction:{label:'GSC/TET — Prepared'}};
    if(options?.method==='PATCH'){updates++;return {id:'PCN-2026-0001',version:'4444444444444444',status:'submitted'};}
    throw new TypeError('Receipt unavailable');
  }});
  const receipt=await controller.submit();
  assert.equal(receipt.id,'PCN-2026-0001');
  assert.equal(receipt.version,'4444444444444444');
  assert.equal(receipt.notification.state,'needs_attention');
  assert.match(receipt.notification.message,/was submitted/);
  assert.equal(updates,1);
});

test('Live completion counts blocking fields only and retains attachment jump targets',()=>{
  const checks={items:[
    {key:'supplierName',field:'supplierName',blocking:true,complete:true},
    {key:'sampleSubmittedDate',field:'sampleSubmittedDate',blocking:false,complete:false},
    {key:'greenProcurement',field:'internalReview.docs.greenProcurement',attachment:true,blocking:true,complete:false}
  ]};
  assert.deepEqual(ui.completion(checks),{complete:1,total:2,missing:[checks.items[2]]});
  assert.equal(ui.stageForIssue(checks.items[2]),'documents');
  assert.equal(ui.stageForIssue({field:'changeRows[2].currentCondition'}),'changes');
});

test('Test autofill requires confirmation for entered data and always starts fresh for a saved record',()=>{
  assert.equal(ui.testFillMode({savedRecord:null,hasContent:false}),'fill');
  assert.equal(ui.testFillMode({savedRecord:null,hasContent:true}),'confirm-replace');
  assert.equal(ui.testFillMode({savedRecord:{id:'PCN-2026-0001'},hasContent:true}),'confirm-new');
});

test('Receipt wording never equates workflow acceptance with delivered mail',()=>{
  assert.equal(ui.notificationLabel({state:'sent'}),'Accepted by workflow');
  assert.equal(ui.notificationLabel({state:'queued'}),'Queued');
  assert.equal(ui.notificationLabel({state:'processing'}),'Processing');
  assert.equal(ui.notificationLabel({state:'uncertain'}),'Needs attention');
  assert.equal(ui.notificationLabel({state:'superseded'}),'Superseded');
});

test('Correcting one field clears only its error while untouched missing fields remain',()=>{
  const errors=[{key:'reason',field:'reason'},{key:'desiredStart',field:'desiredStart'}];
  const remaining=ui.remainingErrors(errors,{items:[{key:'reason',complete:true},{key:'desiredStart',complete:false}]});
  assert.deepEqual(remaining,[errors[1]]);
});

test('A newer draft entry invalidates an older response even after the newer record is edited',async()=>{
  const guard=ui.createEntryGuard();let current={supplierName:'Original'};
  let resolveFirst;
  const first=new Promise(resolve=>{resolveFirst=resolve;});
  const firstToken=guard.next();
  const firstLoad=first.then(record=>{if(guard.current(firstToken))current=record;});
  const secondToken=guard.next();
  assert.equal(guard.current(secondToken),true);
  current={supplierName:'Second draft'};guard.next();current={...current,supplierName:'Edited second draft'};
  resolveFirst({supplierName:'Late first draft'});await firstLoad;
  assert.equal(current.supplierName,'Edited second draft');
});

test('Preflight notification wording requires both configured sending and a recipient',()=>{
  assert.match(ui.notificationPreview({configurationStatus:'configured',recipientConfigured:true}),/will be queued/);
  assert.match(ui.notificationPreview({configurationStatus:'not_configured',recipientConfigured:true}),/not configured/);
  assert.match(ui.notificationPreview({configurationStatus:'invalid',recipientConfigured:true}),/needs attention/);
  assert.match(ui.notificationPreview({configurationStatus:'configured',recipientConfigured:false}),/No action-mail recipient/);
});

test('Canonical draft adoption retains read-only requirements for a restricted owner',()=>{
  const model=require('../create-model');
  const current={supplierName:'New name',internalReview:{docs:{greenProcurement:true}}};
  const serialize=value=>{const {internalReview,...payload}=model.toPayload(value);return payload;};
  const record={...current,id:'PCN-2026-0001',version:'1',status:'draft'};
  const adopted=ui.savedDocument(model,current,{record,snapshot:serialize(current)},serialize);
  assert.equal(adopted.matches,true);
  assert.equal(adopted.document.internalReview.docs.greenProcurement,true);
  assert.equal(serialize(adopted.document).internalReview,undefined);
});

test('Reused terminal or signed canonical records keep newer local text and disable editing',()=>{
  const model=require('../create-model'),current={supplierName:'Unsaved newer name',isTestDocument:true};
  const record={supplierName:'Older committed name',id:'PCN-2026-0001',version:'2',status:'submitted',isTestDocument:false};
  const adopted=ui.savedDocument(model,current,{record,snapshot:model.toPayload(current),unsavedChanges:true},model.toPayload);
  assert.equal(adopted.matches,false);
  assert.equal(adopted.document.supplierName,'Unsaved newer name');
  assert.equal(adopted.document.isTestDocument,false);
  assert.equal(ui.editableDraft(record),false);
  assert.equal(ui.editableDraft({...record,status:'draft',internalReview:{signoff:{gscTet:{prepared:true}}}}),false);
  assert.equal(ui.editableDraft({...record,status:'draft',internalReview:{supplierSignoff:{prepared:{checked:true}}}}),false);
  assert.equal(ui.editableDraft({...record,status:'draft'}),true);
});

test('An initial creation conflict retries the same draft instead of trying to reload an absent record',()=>{
  assert.equal(ui.retryMode('conflict',null),'retry');
  assert.equal(ui.retryMode('conflict',{id:'PCN-2026-0001'}),'reload');
  assert.equal(ui.retryMode('error',null),'retry');
});

test('Explicit copy and starter sessions cannot reuse a previous unsaved client identity',()=>{
  const key='12345678-1234-4234-8234-123456789abc';
  assert.equal(ui.canReuseClientKey({key,record:null,freshIdentity:false}),true);
  assert.equal(ui.canReuseClientKey({key,record:null,freshIdentity:true}),false);
  assert.equal(ui.canReuseClientKey({key,record:{id:'PCN-2026-0001'},freshIdentity:false}),false);
});
