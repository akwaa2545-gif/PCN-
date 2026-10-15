const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkflowSummary } = require('../src/workflowSummary');
const { startApi, fakeAuthService, unsignedPayload } = require('./helpers/apiHarness');

const done = Object.freeze({prepared:true,checked:true,approved:true});
const base = {id:'PCN-2026-0001',version:'0000000000000001',status:'submitted',riskLevel:'RL2'};

test('workflow department summaries count actual signatures in Prepared, Checked, Approved order and identify current step',() => {
  const record = {...base,internalReview:{signoff:{gscTet:done,prodEngTet:done,qaTet:{prepared:true,preparedName:'QA reviewer',preparedDate:'2026-10-15'}}}};
  const summary = buildWorkflowSummary(record);
  assert.equal(summary.id,record.id);
  assert.equal(summary.version,record.version);
  assert.equal(summary.status,'submitted');
  assert.equal(summary.stages.length,6);
  assert.deepEqual(summary.stages.map(stage => stage.state),['completed','completed','current','waiting','waiting','waiting']);
  const qa = summary.stages[2];
  assert.equal(qa.label,'QA/TET');
  assert.equal(qa.completed,1);
  assert.equal(qa.total,3);
  assert.equal(qa.currentStep,'Checked');
  assert.deepEqual(qa.steps.map(step => step.action),['prepared','checked','approved']);
  assert.deepEqual(qa.steps[0],{action:'prepared',label:'Prepared',completed:true,person:'QA reviewer',signedAt:'2026-10-15'});
  assert.deepEqual(qa.steps[1],{action:'checked',label:'Checked',completed:false,person:null,signedAt:null});
  assert.equal(summary.stages[5].label,'QA/TET Final judgment');
  assert.deepEqual(summary.nextAction,{stage:'signoff.qaTet',signingStep:'checked',label:'QA/TET — Checked',terminal:false});
});

test('saved signature binding identity has precedence and unchecked historical name/date never imply a signature',() => {
  const record = {...base,internalReview:{signoff:{gscTet:{prepared:true,preparedName:'Legacy person',preparedDate:'2026-10-14',checkedName:'Stale',checkedDate:'2026-10-15',approved:'true'}}},
    documentControl:{signatureBindings:{'signoff.gscTet.prepared':{displayName:'Actual signer',signedAt:'2026-10-15T08:00:00Z',userId:'private',email:'private'}}}};
  const stage = buildWorkflowSummary(record).stages[0];
  assert.equal(stage.completed,1);
  assert.equal(stage.steps[0].person,'Actual signer');
  assert.equal(stage.steps[0].signedAt,'2026-10-15T08:00:00Z');
  assert.equal(stage.steps[1].person,null);
  assert.equal(stage.steps[1].signedAt,null);
  assert.equal(stage.steps[2].completed,false);
  assert.equal(JSON.stringify(buildWorkflowSummary(record)).includes('private'),false);
});

test('effective route omits TaPBU for RL0 and explicit no-need, while pending confirmation is not a signing step',() => {
  for (const record of [{...base,riskLevel:'RL0'},{...base,internalReview:{tapbu:{noNeed:true}}}]) {
    const summary = buildWorkflowSummary(record);
    assert.equal(summary.stages.length,4);
    assert.equal(summary.stages.some(stage => stage.key.startsWith('tapbu.')),false);
  }
  const signoff = {gscTet:done,prodEngTet:done,qaTet:done};
  const pending = buildWorkflowSummary({...base,internalReview:{signoff}});
  assert.equal(pending.stages[3].state,'current');
  assert.equal(pending.stages[3].currentStep,'Confirm TaPBU requirement');
  assert.deepEqual(pending.nextAction,{stage:'tapbu.gsc',signingStep:null,label:'Confirm TaPBU requirement',terminal:false});
  const required = buildWorkflowSummary({...base,internalReview:{signoff,tapbu:{need:true}}});
  assert.equal(required.stages[3].currentStep,'Prepared');
  assert.equal(required.nextAction.signingStep,'prepared');
});

test('draft and supplier action never suggest signing and terminal status cannot complete missing signatures',() => {
  for (const status of ['draft','supplier_action']) {
    const summary = buildWorkflowSummary({...base,status});
    assert.ok(summary.stages.every(stage => stage.state === 'waiting' && stage.currentStep === null && stage.completed === 0));
    assert.equal(summary.nextAction.stage,'supplier_submission');
    assert.equal(summary.nextAction.signingStep,null);
  }
  for (const status of ['approved','rejected','closed']) {
    const summary = buildWorkflowSummary({...base,status,internalReview:{signoff:{gscTet:done,qaTet:{prepared:true}}}});
    assert.equal(summary.stages[0].state,'completed');
    assert.equal(summary.stages[2].state,'stopped');
    assert.equal(summary.stages[2].completed,1);
    assert.ok(summary.stages.every(stage => stage.state !== 'current' && stage.currentStep === null));
    assert.deepEqual(summary.nextAction,{stage:null,signingStep:null,label:`PCN ${status}`,terminal:true});
  }
});

test('all signatures complete remains distinct from recording a final judgment',() => {
  const summary = buildWorkflowSummary({...base,riskLevel:'RL0',internalReview:{signoff:{gscTet:done,prodEngTet:done,qaTet:done},qateFinal:{signoff:done}}});
  assert.ok(summary.stages.every(stage => stage.state === 'completed' && stage.completed === 3));
  assert.deepEqual(summary.nextAction,{stage:'final_judgment',signingStep:null,label:'Record final judgment',terminal:false});
});

test('historical later signatures do not hide earlier missing checks or invent names from status',() => {
  const summary = buildWorkflowSummary({...base,status:'qualification',internalReview:{signoff:{gscTet:{approved:true},prodEngTet:done}}});
  assert.equal(summary.stages[0].completed,1);
  assert.equal(summary.stages[0].currentStep,'Prepared');
  assert.equal(summary.stages[0].steps[2].person,null);
  assert.equal(summary.stages[1].completed,3);
  assert.equal(summary.stages[1].state,'completed');
});

test('workflow summary is authorized for owned supplier, internal and read-only viewer without exposing assignments',async t => {
  const api = await startApi(t,{authService:fakeAuthService({additionalUsers:[
    {username:'viewer',roles:[],identityProvider:'employee-code',employeeCode:'0012345'},
    {username:'reviewer',roles:['reviewer']}
  ]})});
  const supplier = await api.login('supplier');
  const other = await api.login('other');
  const admin = await api.login('admin');
  const reviewer = await api.login('reviewer');
  const viewer = await api.login('viewer');
  const created = await api.request('/api/pcns',{method:'POST',session:supplier,body:unsignedPayload});
  assert.equal(created.status,201);
  const id = created.body.data.id;
  await api.repository.seedHistoricalReview(id,{signoff:{gscTet:{prepared:true,preparedName:'Saved signer',preparedDate:'2026-10-15'}}});
  const before = await api.repository.findById(id);
  const route = `/api/pcns/${id}/workflow-summary`;
  assert.equal((await api.request(route)).status,401);
  assert.equal((await api.request(route,{session:other})).status,404);
  for (const session of [supplier,admin,reviewer,viewer]) {
    const response = await api.request(route,{session});
    assert.equal(response.status,200,response.text);
    assert.equal(response.body.data.id,id);
    assert.equal(response.body.data.stages[0].completed,1);
    assert.equal(response.body.data.stages[0].steps[0].person,'Saved signer');
    assert.equal(Object.hasOwn(response.body.data.nextAction,'people'),false);
    assert.equal(JSON.stringify(response.body.data).includes('email'),false);
  }
  assert.equal((await api.request(`${route}?user=other`,{session:admin})).status,400);
  for (const method of ['POST','PATCH','PUT','DELETE']) {
    assert.equal((await api.request(route,{session:admin,method,body:{}})).status,405);
    assert.equal((await api.request(route,{session:viewer,method,body:{}})).status,403);
  }
  assert.equal((await api.request('/api/pcns/PCN-2026-9999/workflow-summary',{session:admin})).status,404);
  assert.deepEqual(await api.repository.findById(id),before);
  assert.deepEqual(api.messages,[]);
});
