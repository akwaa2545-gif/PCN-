const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRecordAccess, assertReviewUpdate, assertWritablePayload, assertStatusPermission } = require('../src/workflowAccess');

const supplier = { id: 4, roles: ['Supplier'] };
const qa = { id: 5, roles: ['QA'] };
test('supplier access requires the persisted owner identity', () => {
  assert.doesNotThrow(() => assertRecordAccess({ ownerUserId: 4 }, supplier));
  assert.throws(() => assertRecordAccess({ ownerUserId: 9 }, supplier), { statusCode: 404 });
  assert.throws(() => assertRecordAccess({ ownerUserId: null }, supplier), { statusCode: 404 });
});
test('history and identity fields cannot be overwritten through a form patch', () => {
  assert.throws(() => assertWritablePayload({ ownerUserId: 9 }), { statusCode: 400 });
  assert.throws(() => assertWritablePayload({ approvals: [] }), { statusCode: 400 });
  assert.doesNotThrow(() => assertWritablePayload({ internalReview: {}, version: '0000000000000001' }));
});
test('supplier cannot alter internal review while unchanged defaults are allowed', () => {
  assert.doesNotThrow(() => assertReviewUpdate({}, { docs: { hazardousReport: false }, supplierSignoff: { prepared: { checked: true } } }, supplier, 'RL0'));
  assert.throws(() => assertReviewUpdate({}, { docs: { hazardousReport: true } }, supplier, 'RL0'), { statusCode: 403 });
});
test('QA cannot sign another department and cannot skip signoff prerequisites', () => {
  assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { approved: true } } }, qa, 'RL0'), { statusCode: 403 });
  assert.throws(() => assertReviewUpdate({}, { signoff: { qaTet: { checked: true } } }, qa, 'RL0'), { statusCode: 400 });
});
test('complete prior groups allow ordered review and RL0 forbids TaPBU approval', () => {
  const done = { approved: true, checked: true, prepared: true };
  const before = { signoff: { gscTet: done, prodEngTet: done, qaTet: { approved: true } } };
  const after = { signoff: { gscTet: done, prodEngTet: done, qaTet: { approved: true, checked: true } } };
  assert.doesNotThrow(() => assertReviewUpdate(before, after, qa, 'RL0'));
  assert.throws(() => assertReviewUpdate({}, { tapbu: { need: true } }, { roles: ['Admin'] }, 'RL0'), { statusCode: 400 });
});
test('supplier cannot advance an internal workflow stage or edit a locked submission', () => {
  assert.throws(() => assertStatusPermission({ status: 'submitted' }, 'gsc_review', supplier), { statusCode: 403 });
  assert.doesNotThrow(() => assertStatusPermission({ status: 'draft' }, 'submitted', supplier));
});

test('closure requires a recorded final judgment as well as signoffs', () => {
  const record={status:'qa_review',internalReview:{qateFinal:{signoff:{approved:true,checked:true,prepared:true}}}};
  assert.throws(()=>assertStatusPermission(record,'closed',qa),{statusCode:400});
  assert.doesNotThrow(()=>assertStatusPermission({...record,internalReview:{qateFinal:{...record.internalReview.qateFinal,approve:true}}},'closed',qa));
});
