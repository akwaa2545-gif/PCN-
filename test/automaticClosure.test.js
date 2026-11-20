const test = require('node:test');
const assert = require('node:assert/strict');
const { isEligibleForClosure, applyAutomaticClosure } = require('../src/automaticClosure');

const done = { prepared: true, checked: true, approved: true };
const headers = Object.fromEntries(Object.keys(done).map(action => [action, { checked: true }]));
function record(overrides = {}) {
  return { status: 'qualification', riskLevel: 'RL2', internalReview: {
    signoff: { gscTet: done, prodEngTet: done, qaTet: done },
    tapbu: { need: true, gsc: done, qa: done },
    qateFinal: { signoff: done, approve: true, reject: false }, supplierSignoff: headers
  }, ...overrides };
}

test('closure requires every strict route signature and all header checks', () => {
  assert.equal(isEligibleForClosure(record()), true);
  for (const value of [undefined, null, {}, [], 'complete']) assert.equal(isEligibleForClosure(value), false);
  for (const status of [undefined, 'unknown', 'draft', 'supplier_action', 'approved', 'rejected', 'closed']) {
    assert.equal(isEligibleForClosure(record({ status })), false);
  }
  for (const [section, key] of [['signoff', 'gscTet'], ['signoff', 'prodEngTet'], ['signoff', 'qaTet'], ['tapbu', 'gsc'], ['tapbu', 'qa'], ['qateFinal', 'signoff']]) {
    for (const action of Object.keys(done)) {
      for (const value of [false, undefined, 'true', 1]) {
        const candidate = structuredClone(record());
        candidate.internalReview[section][key][action] = value;
        assert.equal(isEligibleForClosure(candidate), false, `${section}.${key}.${action}: ${value}`);
      }
    }
  }
  for (const action of Object.keys(done)) {
    for (const value of [false, undefined, 'true', 1]) {
      const candidate = structuredClone(record());
      candidate.internalReview.supplierSignoff[action].checked = value;
      assert.equal(isEligibleForClosure(candidate), false);
    }
  }
  for (const decision of [{}, { approve: false, reject: false }, { approve: true, reject: false }, { approve: false, reject: true }]) {
    const candidate = record();
    candidate.internalReview.qateFinal = { signoff: done, ...decision };
    assert.equal(isEligibleForClosure(candidate), true);
  }
  const rejected = record();
  rejected.internalReview.qateFinal = { signoff: done, approve: false, reject: true };
  assert.equal(isEligibleForClosure(rejected), true);
});

test('RL0 and explicit TaPBU no-need skip only TaPBU requirements', () => {
  for (const candidate of [record({ riskLevel: 'RL0' }), record()]) {
    candidate.internalReview.tapbu = candidate.riskLevel === 'RL0' ? {} : { noNeed: true };
    assert.equal(isEligibleForClosure(candidate), true);
  }
  const undecided = record();
  undecided.internalReview.tapbu = {};
  assert.equal(isEligibleForClosure(undecided), false);
});

test('fully signed active candidates close on an authorized save even when already eligible', () => {
  const candidate = record();
  const before = structuredClone(candidate);
  before.internalReview.supplierSignoff.approved.checked = false;
  const closed = applyAutomaticClosure(before, candidate);
  assert.equal(closed.status, 'closed');
  assert.equal(candidate.status, 'qualification');
  assert.deepEqual(closed.internalReview, candidate.internalReview);
  assert.equal(applyAutomaticClosure(candidate, { ...candidate, updatedAt: 'later' }).status, 'closed');
  assert.equal(applyAutomaticClosure({ ...candidate, status: 'draft' }, { ...candidate, status: 'submitted' }).status, 'closed');
  for (const status of ['draft', 'supplier_action', 'approved', 'rejected', 'closed']) {
    assert.equal(applyAutomaticClosure(before, { ...candidate, status }).status, status);
  }
  const noDecision = structuredClone(candidate);
  noDecision.internalReview.qateFinal.approve = false;
  assert.equal(applyAutomaticClosure(noDecision, candidate).status, 'closed');
  const liveShape = { ...noDecision, status: 'submitted' };
  const saved = applyAutomaticClosure(liveShape, structuredClone(liveShape));
  assert.equal(saved.status, 'closed');
  assert.deepEqual(saved.internalReview.qateFinal, liveShape.internalReview.qateFinal);
  assert.equal(saved.internalReview.qateFinal.approve, false);
  assert.equal(saved.internalReview.qateFinal.reject, false);
});
