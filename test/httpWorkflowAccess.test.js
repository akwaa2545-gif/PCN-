const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertRecordAccess, assertWritablePayload, assertReviewUpdate, assertStatusPermission,
  hasRole, isInternal, routeGroups, complete
} = require('../src/workflowAccess');

const user = role => ({ id: 'owner', roles: [role], ...(role === 'qa' ? { department: 'qaTet', signingStep: 'prepared' } : {}) });
const signoff = { approved: true, checked: true, prepared: true };
const finished = () => ({ signoff: { gscTet: { ...signoff }, prodEngTet: { ...signoff }, qaTet: { ...signoff } },
  tapbu: { need: true, gsc: { ...signoff }, qa: { ...signoff } }, qateFinal: { signoff: { ...signoff }, approve: true } });

test('record access hides foreign ownership while allowing internal departments', () => {
  assertRecordAccess({ ownerUserId: 'owner' }, user('supplier'));
  for (const role of ['admin', 'reviewer', 'GSC', 'Production Engineering', 'QA', 'TaPBU']) {
    assertRecordAccess({ ownerUserId: 'another' }, user(role));
    assert.equal(isInternal(user(role)), true);
  }
  for (const record of [null, {}, { ownerUserId: 'another' }]) {
    assert.throws(() => assertRecordAccess(record, user('supplier')), { statusCode: 404 });
  }
  assert.equal(hasRole(user('Production Engineering'), 'productionengineering'), true);
  assert.equal(isInternal(undefined), false);
});

test('payload validation prevents ownership, audit, identity and approval mass assignment', () => {
  assertWritablePayload({ supplierName: 'A', reason: 'B', internalReview: {}, version: '0000000000000001' });
  for (const input of [null, [], 'text', { ownerUserId: 'forged' }, { id: 'forged' }, { approvals: [] }, { createdAt: 'forged' }, { constructor: {} }]) {
    assert.throws(() => assertWritablePayload(input), { statusCode: 400 });
  }
});

test('department review permissions apply at individual workbook fields', () => {
  for (const [role, review] of [
    ['supplier', { supplierSignoff: { name: 'supplier' } }],
    ['gsc', { materialCodeDescription: 'material', docs: { report: true } }],
    ['qa', { decision: { agreed: true } }],
    ['productionengineering', { signoff: { prodEngTet: { comment: 'reviewed' } } }],
    ['tapbu', { tapbu: { qa: { comment: 'reviewed' } } }]
  ]) assertReviewUpdate({}, review, user(role), 'RL2');
  for (const [role, review] of [
    ['supplier', { docs: { report: true } }], ['gsc', { decision: { agreed: true } }],
    ['qa', { signoff: { prodEngTet: { comment: 'forged' } } }],
    ['productionengineering', { signoff: { qaTet: { comment: 'forged' } } }],
    ['tapbu', { supplierSignoff: { name: 'forged' } }]
  ]) assert.throws(() => assertReviewUpdate({}, review, user(role), 'RL2'), { statusCode: 403 });
  assertReviewUpdate({ docs: { report: true } }, { docs: { report: true }, unused: false, pcnCode: 'server' }, user('supplier'), 'RL2');
});

test('signoff order and checked prerequisites block forged completion', () => {
  assertReviewUpdate(finished(), finished(), user('admin'), 'RL2');
  assert.equal(complete(finished(), 'qateFinal.signoff'), true);
  assert.equal(complete({}, 'qateFinal.signoff'), false);
  for (const [before, review, actor] of [
    [{}, { signoff: { gscTet: { checked: true } } }, { ...user('gsc'), department: 'gscTet', signingStep: 'checked' }],
    [{ signoff: { gscTet: { approved: true } } }, { signoff: { gscTet: { approved: true, prepared: true } } }, { ...user('gsc'), department: 'gscTet', signingStep: 'prepared' }],
    [{}, { signoff: { prodEngTet: { approved: true } } }, { ...user('productionengineering'), department: 'prodEngTet', signingStep: 'approved' }],
    [finished(), { ...finished(), tapbu: { need: false, gsc: { ...signoff }, qa: { ...signoff } } }, user('admin')]
  ]) assert.throws(() => assertReviewUpdate(before, review, actor, 'RL2'), { statusCode: 400 });
});

test('risk-specific routes and mutually exclusive workbook decisions are enforced', () => {
  assert.deepEqual(routeGroups('RL0'), ['signoff.gscTet', 'signoff.prodEngTet', 'signoff.qaTet', 'qateFinal.signoff']);
  assert.ok(routeGroups('RL2').includes('tapbu.qa'));
  for (const review of [
    { tapbu: { need: true, noNeed: true } }, { qateFinal: { approve: true, reject: true } },
    { decision: { rejected: true, agreed: true } }, { decision: { rejected: true, agreedAfterQualification: true } }
  ]) assert.throws(() => assertReviewUpdate({}, review, user(review.qateFinal ? 'qa' : 'admin'), 'RL2'), { statusCode: 400 });
  assert.throws(() => assertReviewUpdate({}, { tapbu: { need: true } }, user('admin'), 'RL0'), { statusCode: 400 });
  const noTapbu = finished();
  delete noTapbu.tapbu;
  assertReviewUpdate(noTapbu, noTapbu, user('admin'), 'RL0');
  assert.throws(() => assertReviewUpdate(noTapbu, { ...noTapbu, tapbu: { gsc: { approved: true } } }, { ...user('tapbu'), department: 'gscTapbu', signingStep: 'approved' }, 'RL0'), { statusCode: 400 });
});

test('final judgments require QA privileges, complete signoffs and recorded decision', () => {
  assertStatusPermission({ status: 'draft' }, 'draft', user('supplier'));
  assertStatusPermission({ status: 'draft' }, 'submitted', user('supplier'));
  assertStatusPermission({ status: 'supplier_action' }, 'submitted', user('supplier'));
  assert.throws(() => assertStatusPermission({ status: 'submitted' }, 'gsc_review', user('supplier')), { statusCode: 403 });
  assert.throws(() => assertStatusPermission({ status: 'final_review', internalReview: finished() }, 'approved', user('gsc')), { statusCode: 403 });
  assert.throws(() => assertStatusPermission({ status: 'final_review', internalReview: {} }, 'approved', user('qa')), { statusCode: 400 });
  assertStatusPermission({ status: 'final_review', internalReview: finished() }, 'approved', user('qa'));
  const undecided = finished();
  delete undecided.qateFinal.approve;
  for (const status of ['approved', 'rejected']) {
    assert.throws(() => assertStatusPermission({ status: 'final_review', internalReview: undecided }, status, user('qa')), { statusCode: 400 });
  }
  const rejected = { ...undecided, qateFinal: { ...undecided.qateFinal, reject: true } };
  assertStatusPermission({ status: 'final_review', internalReview: rejected }, 'rejected', user('qa'));
  assertStatusPermission({ status: 'approved', internalReview: finished() }, 'closed', user('qa'));
});
