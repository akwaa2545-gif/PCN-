const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../create');

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
