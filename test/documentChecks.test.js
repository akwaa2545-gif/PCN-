const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChecks, assertCompletion, buildAction } = require('../src/documentChecks');
const { documentRequirements } = require('../src/documentRequirements');

const full = { id:'PCN-2026-0001',status:'submitted',ownerUserId:'supplier',riskLevel:'RL2',supplierName:'Supplier',
  materialName:'Copper',selectedChange:'Tolerance',reason:'Quality',currentCondition:'Old',newCondition:'New',
  desiredStart:'Lot 42',sampleSubmitted:'no',internalReview:{} };
const admin = {id:'admin',roles:['admin'],isActive:true};
test('completion errors list every missing blocking label and omit completed or advisory fields', () => {
  const record = { ...full, supplierName: '', materialName: '', selectedChange: '', reason: '',
    currentCondition: '', newCondition: '', desiredStart: '', sampleSubmitted: 'pending',
    internalReview: { docs: { hazardousReport: true, greenProcurement: true } } };
  const expected = ['Supplier name', 'Material / chemical name', 'Change description', 'Reason for change',
    'Current condition', 'New condition', 'Target start date or lot', 'Sample submission choice', 'Green Procurement declaration'];
  const attachments = [{ requirementName: 'hazardousReport', scanStatus: 'clean' }];
  assert.throws(() => assertCompletion(record, attachments), error => {
    assert.equal(error.statusCode, 400);
    assert.deepEqual(error.details.missing.map(item => item.label), expected);
    assert.ok(error.message.includes(`Still missing: ${expected.join('; ')}`));
    assert.equal(error.message.includes("Supplier's Hazardous substance tested Report"), false);
    assert.equal(error.message.includes('Sample submission date'), false);
    return true;
  });
  assert.throws(() => assertCompletion({ ...full, reason: '', sampleSubmitted: 'yes', sampleSubmittedDate: '' }), error => {
    assert.ok(error.message.includes('Still missing: Reason for change'));
    assert.equal(error.message.includes('Supplier name'), false);
    assert.equal(error.message.includes('Sample submission date'), false);
    return true;
  });
});
test('file-only completion errors name only missing blocking attachments', () => {
  const record = { ...full, reason: '', sampleSubmitted: 'yes', sampleSubmittedDate: '',
    internalReview: { docs: { hazardousReport: true, greenProcurement: true } } };
  assert.throws(() => assertCompletion(record, [{ requirementName: 'hazardousReport', scanStatus: 'clean' }], { requiredFilesOnly: true }), error => {
    assert.deepEqual(error.details.missing, [{ key: 'greenProcurement', label: 'Green Procurement declaration', field: 'internalReview.docs.greenProcurement' }]);
    assert.ok(error.message.includes('Still missing: Green Procurement declaration'));
    assert.equal(error.message.includes('Reason for change'), false);
    assert.equal(error.message.includes('Sample submission date'), false);
    assert.equal(error.message.includes("Supplier's Hazardous substance tested Report"), false);
    return true;
  });
});
test('next action starts with Prepared and fills historical gaps before later steps', () => {
  assert.equal(buildAction(full, admin).signingStep, 'prepared');
  const historical = { ...full, internalReview: { signoff: { gscTet: { approved: true, approvedName: 'Original' } } } };
  assert.equal(buildAction(historical, admin).signingStep, 'prepared');
  historical.internalReview.signoff.gscTet.prepared = true;
  assert.equal(buildAction(historical, admin).signingStep, 'checked');
});
test('final judgment belongs to the QA/TET Approved assignment', () => {
  const done = { prepared: true, checked: true, approved: true };
  const record = { ...full, riskLevel: 'RL0', internalReview: { signoff: { gscTet: done, prodEngTet: done, qaTet: done }, qateFinal: { signoff: done } } };
  const approved = { roles: ['qa'], department: 'qaTet', signingStep: 'approved' };
  const action = buildAction(record, approved);
  assert.equal(action.signingStep, 'approved');
  assert.equal(action.canAct, true);
  assert.equal(buildAction(record, { ...approved, signingStep: 'prepared' }).canAct, false);
});
test('checks describe missing document fields, remain advisory for drafts and do not modify records', () => {
  const draft={...full,status:'draft',reason:'',sampleSubmitted:'pending'};
  const before=JSON.stringify(draft);
  const result=buildChecks(draft,[]);
  assert.equal(result.ready,false);
  assert.equal(result.items.find(item=>item.key==='reason').field,'reason');
  assert.equal(result.items.find(item=>item.key==='sampleSubmitted').complete,false);
  assert.equal(JSON.stringify(draft),before);
  assert.doesNotThrow(()=>assertCompletion(full,[]));
  assert.throws(()=>assertCompletion(draft,[]),error=>error.statusCode===400 && error.details.missing.some(item=>item.key==='reason'));
});
test('selected requirements require an active clean matching attachment; unchecked requirements have no blocker', () => {
  assert.equal(documentRequirements.length,5);
  const record={...full,internalReview:{docs:{hazardousReport:true}}};
  for(const files of [[],[{requirementName:'hazardousReport',scanStatus:'pending'}],[{requirementName:'hazardousReport',scanStatus:'clean',deletedAt:'2026-10-09'}],
    [{requirementName:'otherRequirement',scanStatus:'clean'}]]) assert.equal(buildChecks(record,files).ready,false);
  assert.equal(buildChecks(record,[{requirementName:'hazardousReport',scanStatus:'clean'}]).ready,true);
  assert.equal(buildChecks(record,[{RequirementName:documentRequirements[0].label,ScanStatus:'clean'}]).ready,true);
  assert.doesNotThrow(()=>assertCompletion({...record,reason:''},[{requirementName:'hazardousReport',scanStatus:'clean'}],{requiredFilesOnly:true}));
});
test('sample date is an advisory item only when sample has been submitted', () => {
  const result=buildChecks({...full,sampleSubmitted:'yes'},[]);
  assert.equal(result.items.find(item=>item.key==='sampleSubmittedDate').complete,false);
  assert.equal(result.items.find(item=>item.key==='sampleSubmittedDate').blocking,false);
  assert.equal(result.ready,true);
  assert.equal(buildChecks(full,[]).items.some(item=>item.key==='sampleSubmittedDate'),false);
});
test('action follows ordered signatures, filters assigned active people, and exposes no private user data', () => {
  const users=[{id:'a',displayName:'Ann',employeeCode:'001',roles:['gsc'],department:'gscTet',signingStep:'prepared',isActive:true,email:'private'},
    {id:'b',displayName:'Bob',roles:['gsc'],department:'gscTet',signingStep:'checked',isActive:true},
    {id:'c',displayName:'Inactive',roles:['gsc'],department:'gscTet',signingStep:'prepared',isActive:false}];
  const action=buildAction(full,admin,users);
  assert.equal(action.field,'internalReview.signoff.gscTet.prepared');
  assert.equal(action.canAct,true);
  assert.deepEqual(action.people,[{displayName:'Ann',employeeCode:'001'}]);
  assert.equal(buildAction(full,users[1],users).canAct,false);
  const signed={...full,internalReview:{signoff:{gscTet:{prepared:true}}}};
  assert.equal(buildAction(signed,users[1],users).signingStep,'checked');
});
test('supplier sees no reviewer enumeration and terminal actions are empty', () => {
  const supplier={id:'supplier',roles:['supplier'],displayName:'Owner'};
  assert.deepEqual(buildAction(full,supplier,[admin]).people,[]);
  const draft=buildAction({...full,status:'draft'},supplier,[admin]);
  assert.equal(draft.canAct,true);
  assert.equal(draft.stage,'supplier_submission');
  assert.deepEqual(draft.people,[{displayName:'Owner',employeeCode:null}]);
  assert.equal(buildAction({...full,status:'closed'},admin,[]).stage,null);
});
test('RL0 and explicit TaPBU no-need skip TaPBU signatures', () => {
  const signed={gscTet:{approved:true,checked:true,prepared:true},prodEngTet:{approved:true,checked:true,prepared:true},qaTet:{approved:true,checked:true,prepared:true}};
  for(const record of [{...full,riskLevel:'RL0',internalReview:{signoff:signed}},{...full,internalReview:{signoff:signed,tapbu:{need:false,noNeed:true}}}]) {
    assert.equal(buildAction(record,admin,[]).field,'internalReview.qateFinal.signoff.prepared');
  }
});
