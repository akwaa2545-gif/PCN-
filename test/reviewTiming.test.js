const test = require('node:test');
const assert = require('node:assert/strict');
const { isProdEngActive, isQaActive, applyReviewTiming, stageDeadline, prodEngDeadline, qaDeadline, activeReviewDeadline } = require('../src/reviewTiming');

const startedAt = '2026-10-16T08:30:00.000Z';
const dueAt = '2026-10-19T08:30:00.000Z';
const complete = { prepared: true, checked: true, approved: true };
const active = (changes = {}) => ({ status: 'technical_review', internalReview: {
  signoff: { gscTet: complete, prodEngTet: {} }
}, ...changes });
const timed = () => active({ reviewTiming: { prodEngTet: { startedAt } } });
const configured = (pendingDays = {}) => ({ schemaVersion: 1, version: 1, pendingDays: {
  gscTet: null, prodEngTet: 3, qaTet: 3, gscTapbu: null, qaTapbu: null, qaFinal: null, ...pendingDays
} });
const route = [
  ['gscTet', 'signoff.gscTet'], ['prodEngTet', 'signoff.prodEngTet'], ['qaTet', 'signoff.qaTet'],
  ['gscTapbu', 'tapbu.gsc'], ['qaTapbu', 'tapbu.qa'], ['qaFinal', 'qateFinal.signoff']
];
function atStage(index, changes = {}) {
  const review = { signoff: {}, tapbu: { need: true }, qateFinal: {} };
  route.slice(0, index).forEach(([, path]) => {
    const [section, key] = path.split('.');
    review[section] = { ...review[section], [key]: complete };
  });
  return { status: 'submitted', riskLevel: 'RL2', internalReview: review, ...changes };
}

test('all six actual stage entries record server starts even when their allowance is disabled', () => {
  for (let index = 0; index < route.length; index++) {
    const [key, stageKey] = route[index];
    const before = index === 0 ? { status: 'draft' } : atStage(index - 1);
    const result = applyReviewTiming(before, atStage(index), startedAt);
    assert.deepEqual(result.reviewTiming, { [key]: { startedAt } });
    const settings = configured({ [key]: 2 });
    const deadline = stageDeadline(result, stageKey, new Date(dueAt), settings);
    assert.equal(deadline.stageKey, stageKey);
    assert.equal(deadline.department, key === 'qaFinal' ? 'qaTet' : key);
    assert.equal(deadline.dueAt, '2026-10-18T08:30:00.000Z');
    assert.equal(deadline.overdue, true);
    assert.deepEqual(activeReviewDeadline(result, new Date(dueAt), settings), deadline);
    const disabled = configured({ [key]: null });
    assert.equal(stageDeadline(result, stageKey, new Date(dueAt), disabled), null);
    assert.equal(activeReviewDeadline(result, new Date(dueAt), disabled), null);
  }
});

test('current limits recalculate ongoing reviews from their original start without changing records', () => {
  const record = timed();
  const snapshot = structuredClone(record);
  for (const days of [1, 5, 365]) {
    const deadline = prodEngDeadline(record, new Date(dueAt), configured({ prodEngTet: days }));
    assert.equal(deadline.startedAt, startedAt);
    assert.equal(deadline.dueAt, new Date(Date.parse(startedAt) + days * 86400000).toISOString());
  }
  assert.equal(prodEngDeadline(record, new Date(dueAt), configured({ prodEngTet: null })), null);
  assert.deepEqual(record, snapshot);
});

test('skipped TaPBU stages never receive a timer and final QA has a distinct handoff', () => {
  for (const skip of ['RL0', 'noNeed']) {
    const skipped = index => {
      const record = atStage(index, { riskLevel: skip === 'RL0' ? 'RL0' : 'RL2' });
      return { ...record, internalReview: { ...record.internalReview, tapbu: { noNeed: skip === 'noNeed' } } };
    };
    const before = skipped(2);
    const after = skipped(3);
    const result = applyReviewTiming(before, after, startedAt);
    assert.deepEqual(result.reviewTiming, { qaFinal: { startedAt } });
    assert.equal(stageDeadline(result, 'tapbu.gsc', new Date(dueAt), configured({ gscTapbu: 1 })), null);
    assert.equal(stageDeadline(result, 'tapbu.qa', new Date(dueAt), configured({ qaTapbu: 1 })), null);
    assert.equal(qaDeadline(result, new Date(dueAt)), null);
    assert.equal(activeReviewDeadline(result, new Date(dueAt)), null);
    assert.equal(activeReviewDeadline(result, new Date(dueAt), configured({ qaFinal: 2 })).stageKey, 'qateFinal.signoff');
  }
});

test('all configured stages preserve reliable starts, keep legacy timing unknown and reject proposed evidence', () => {
  for (let index = 0; index < route.length; index++) {
    const [key, stageKey] = route[index];
    const legacy = atStage(index);
    const forged = { ...legacy, reviewTiming: { [key]: { startedAt } } };
    const settings = configured({ [key]: 1 });
    const unknown = applyReviewTiming(legacy, forged, dueAt);
    assert.equal(stageDeadline(unknown, stageKey, new Date(dueAt), settings).source, 'unknown');
    const reliable = { ...legacy, reviewTiming: { [key]: { startedAt } } };
    assert.deepEqual(applyReviewTiming(reliable, { ...forged, status: 'qualification' }, dueAt).reviewTiming, reliable.reviewTiming);
    const returned = applyReviewTiming(reliable, { ...reliable, status: 'supplier_action' }, dueAt);
    assert.equal(activeReviewDeadline(returned, new Date(dueAt), settings), null);
    const resumed = applyReviewTiming(returned, { ...returned, status: 'submitted' }, dueAt);
    assert.deepEqual(resumed.reviewTiming, { [key]: { startedAt: dueAt } });
  }
});

test('earlier incomplete stage wins over historical later signatures and terminal stages never expose deadlines', () => {
  const record = { ...atStage(5), internalReview: { ...atStage(5).internalReview, signoff: {} },
    reviewTiming: { qaFinal: { startedAt }, gscTet: { startedAt } } };
  const settings = configured({ gscTet: 1, qaFinal: 1 });
  assert.equal(activeReviewDeadline(record, new Date(dueAt), settings).stageKey, 'signoff.gscTet');
  assert.equal(stageDeadline(record, 'qateFinal.signoff', new Date(dueAt), settings), null);
  for (const status of ['draft', 'supplier_action', 'approved', 'rejected', 'closed']) {
    assert.equal(activeReviewDeadline({ ...record, status }, new Date(dueAt), settings), null);
  }
  assert.equal(activeReviewDeadline(atStage(6), new Date(dueAt), settings), null);
});

test('handoff depends on complete GSC signatures and incomplete Prod.Eng, regardless of review status', () => {
  for (const status of ['submitted', 'gsc_review', 'technical_review', 'qa_review']) {
    assert.equal(isProdEngActive(active({ status })), true);
  }
  for (const status of ['draft', 'supplier_action', 'approved', 'rejected', 'closed']) {
    assert.equal(isProdEngActive(active({ status })), false);
  }
  assert.equal(isProdEngActive(null), false);
  assert.equal(isProdEngActive({ status: 'technical_review' }), false);
  assert.equal(isProdEngActive(active({ internalReview: { signoff: { gscTet: { prepared: true, checked: true } } } })), false);
  assert.equal(isProdEngActive(active({ internalReview: { signoff: { gscTet: complete, prodEngTet: complete } } })), false);
});

test('actual inactive-to-active handoff stores a canonical server timestamp without changing inputs', () => {
  const before = { status: 'gsc_review', internalReview: { signoff: { gscTet: { prepared: true, checked: true } } } };
  const after = active();
  const original = structuredClone(after);
  const result = applyReviewTiming(before, after, '2026-10-16T15:30:00+07:00');
  assert.deepEqual(result.reviewTiming, { prodEngTet: { startedAt } });
  assert.deepEqual(after, original);
  assert.equal(before.reviewTiming, undefined);
  assert.notEqual(result, after);
});

test('partial signatures, notes and status changes keep the first handoff timestamp', () => {
  const before = timed();
  const after = active({ status: 'gsc_review', updatedAt: dueAt, internalReview: {
    signoff: { gscTet: complete, prodEngTet: { prepared: true, checked: true, comment: 'Working' } }
  } });
  assert.deepEqual(applyReviewTiming(before, after, dueAt).reviewTiming, before.reviewTiming);
});

test('leaving the stage clears timing and a later reentry gets a fresh timestamp', () => {
  const before = timed();
  const returned = applyReviewTiming(before, { ...before, status: 'supplier_action' }, dueAt);
  assert.equal(returned.reviewTiming?.prodEngTet, undefined);
  const reentered = applyReviewTiming(returned, { ...returned, status: 'submitted' }, dueAt);
  assert.equal(reentered.reviewTiming.prodEngTet.startedAt, dueAt);
  const completed = applyReviewTiming(before, active({ internalReview: {
    signoff: { gscTet: complete, prodEngTet: complete }
  } }), dueAt);
  assert.equal(completed.reviewTiming?.prodEngTet, undefined);
});

test('due date is exactly 72 hours including weekends, overdue only strictly after deadline', () => {
  assert.deepEqual(prodEngDeadline(timed(), new Date(dueAt)), {
    stageKey: 'signoff.prodEngTet', department: 'prodEngTet', label: 'Prod.Eng/TET', startedAt, dueAt, overdue: false, source: 'handoff'
  });
  assert.equal(prodEngDeadline(timed(), new Date('2026-10-19T08:30:00.001Z')).overdue, true);
  assert.equal(prodEngDeadline(timed(), new Date('2026-10-19T08:29:59.999Z')).overdue, false);
  assert.equal(prodEngDeadline({ ...timed(), status: 'closed' }), null);
});

test('legacy active records never infer a handoff from signatures, creation or updated dates', () => {
  const legacy = active({ updatedAt: startedAt, createdAt: startedAt, documentControl: {
    signatureBindings: { 'signoff.gscTet.approved': { signedAt: startedAt } }
  } });
  const updated = applyReviewTiming(legacy, { ...legacy, updatedAt: dueAt }, dueAt);
  assert.deepEqual(prodEngDeadline(updated, new Date(dueAt)), {
    stageKey: 'signoff.prodEngTet', department: 'prodEngTet', label: 'Prod.Eng/TET', startedAt: null, dueAt: null, overdue: null, source: 'unknown'
  });
});

test('malformed, impossible, partial and future timestamps remain unknown', () => {
  const invalid = [undefined, null, 42, '2026-10-16', '2026-10-16T08:30:00',
    '2026-02-30T08:30:00.000Z', '2026-10-16T24:00:00.000Z', '2026-10-16T08:30:60.000Z',
    '2026-10-16T08:30:00+25:00', '2026-10-20T08:30:00.000Z'];
  for (const value of invalid) {
    const record = active({ reviewTiming: { prodEngTet: { startedAt: value } } });
    const result = prodEngDeadline(record, new Date(dueAt));
    assert.equal(result.source, 'unknown', String(value));
    assert.equal(result.overdue, null, String(value));
    assert.equal(prodEngDeadline(applyReviewTiming(record, record, dueAt), new Date(dueAt)).source, 'unknown');
  }
});

test('full ISO timestamps normalize offsets and optional milliseconds', () => {
  for (const value of ['2026-10-16T15:30:00+07:00', '2026-10-16T08:30:00Z', '2026-10-16T08:30:00.0Z']) {
    const record = active({ reviewTiming: { prodEngTet: { startedAt: value } } });
    assert.equal(prodEngDeadline(record, new Date(dueAt)).startedAt, startedAt);
    assert.equal(prodEngDeadline(record, new Date(dueAt)).dueAt, dueAt);
  }
});

test('proposed timing cannot replace a trusted timestamp or invent timing for legacy active records', () => {
  const forged = active({ reviewTiming: { prodEngTet: { startedAt: dueAt } } });
  assert.equal(applyReviewTiming(timed(), forged, dueAt).reviewTiming.prodEngTet.startedAt, startedAt);
  assert.equal(prodEngDeadline(applyReviewTiming(active(), forged, dueAt), new Date(dueAt)).source, 'unknown');
});

test('withdrawing GSC approval clears this stage while preserving unrelated timing metadata', () => {
  const before = { ...timed(), reviewTiming: { prodEngTet: { startedAt }, otherStage: { note: 'Preserve' } } };
  const after = active({ internalReview: { signoff: { gscTet: { ...complete, approved: false } } } });
  const result = applyReviewTiming(before, after, dueAt);
  assert.deepEqual(result.reviewTiming, { otherStage: { note: 'Preserve' }, gscTet: { startedAt: dueAt } });
  assert.equal(prodEngDeadline(result, new Date(dueAt)), null);
  const handedAgain = applyReviewTiming(result, active(), dueAt);
  assert.equal(handedAgain.reviewTiming.prodEngTet.startedAt, dueAt);
});

test('invalid server clock values cannot create false timing evidence', () => {
  assert.throws(() => applyReviewTiming(null, active(), '2026-10-16'), /full ISO server timestamp/);
  assert.equal(prodEngDeadline(timed(), new Date('invalid')).source, 'unknown');
});

const qaActive = (changes = {}) => active({ internalReview: { signoff: {
  gscTet: complete, prodEngTet: complete, qaTet: {}
} }, ...changes });

test('QA review starts only with complete GSC and Prod.Eng signatures and stops at QA review completion', () => {
  assert.equal(isQaActive(qaActive()), true);
  assert.equal(isQaActive(active()), false);
  assert.equal(isQaActive(qaActive({ internalReview: { signoff: { prodEngTet: complete, qaTet: {} } } })), false);
  assert.equal(isQaActive(qaActive({ internalReview: { signoff: { gscTet: complete, prodEngTet: complete, qaTet: complete } } })), false);
  for (const status of ['draft', 'supplier_action', 'approved', 'rejected', 'closed']) {
    assert.equal(isQaActive(qaActive({ status })), false);
  }
});

test('Prod.Eng completion atomically ends its timer and starts the separate QA handoff timer', () => {
  const before = timed();
  const handed = applyReviewTiming(before, qaActive(), dueAt);
  assert.equal(handed.reviewTiming.prodEngTet, undefined);
  assert.deepEqual(handed.reviewTiming.qaTet, { startedAt: dueAt });
  assert.equal(prodEngDeadline(handed, new Date(dueAt)), null);
  assert.deepEqual(qaDeadline(handed, new Date('2026-10-22T08:30:00.000Z')), {
    stageKey: 'signoff.qaTet', department: 'qaTet', label: 'QA/TET', startedAt: dueAt, dueAt: '2026-10-22T08:30:00.000Z',
    overdue: false, source: 'handoff'
  });
  assert.equal(qaDeadline(handed, new Date('2026-10-22T08:30:00.001Z')).overdue, true);
  assert.deepEqual(activeReviewDeadline(handed, new Date(dueAt)), qaDeadline(handed, new Date(dueAt)));
  assert.deepEqual(activeReviewDeadline(before, new Date(dueAt)), prodEngDeadline(before, new Date(dueAt)));
});

test('QA partial signatures, comments and status saves preserve the handoff timer', () => {
  const before = qaActive({ reviewTiming: { qaTet: { startedAt } } });
  const partial = qaActive({ status: 'qualification', internalReview: { signoff: {
    gscTet: complete, prodEngTet: complete, qaTet: { prepared: true, checked: true, comment: 'Reviewing' }
  } } });
  assert.deepEqual(applyReviewTiming(before, partial, dueAt).reviewTiming.qaTet, { startedAt });
});

test('QA completed review has no deadline even if final judgment remains unsigned', () => {
  const before = qaActive({ reviewTiming: { qaTet: { startedAt }, otherStage: { note: 'Keep' } } });
  const completed = qaActive({ internalReview: { signoff: { gscTet: complete, prodEngTet: complete, qaTet: complete }, tapbu: { noNeed: true }, qateFinal: {} } });
  const next = applyReviewTiming(before, completed, dueAt);
  assert.deepEqual(next.reviewTiming, { otherStage: { note: 'Keep' }, qaFinal: { startedAt: dueAt } });
  assert.equal(qaDeadline(next, new Date(dueAt)), null);
  assert.equal(activeReviewDeadline(next, new Date(dueAt)), null);
});

test('legacy QA review keeps unknown timing and cannot adopt proposed timestamps or old Prod.Eng evidence', () => {
  const before = qaActive({ reviewTiming: { prodEngTet: { startedAt } }, updatedAt: startedAt });
  const next = applyReviewTiming(before, { ...before, reviewTiming: { qaTet: { startedAt: dueAt } } }, dueAt);
  assert.equal(next.reviewTiming?.prodEngTet, undefined);
  assert.deepEqual(qaDeadline(next, new Date(dueAt)), {
    stageKey: 'signoff.qaTet', department: 'qaTet', label: 'QA/TET', startedAt: null, dueAt: null, overdue: null, source: 'unknown'
  });
  for (const value of ['2026-02-30T00:00:00.000Z', '2026-10-22T00:00:00.000Z']) {
    assert.equal(qaDeadline(qaActive({ reviewTiming: { qaTet: { startedAt: value } } }), new Date(dueAt)).source, 'unknown');
  }
});

test('QA stage exit clears timing and reentry starts fresh', () => {
  const before = qaActive({ reviewTiming: { qaTet: { startedAt } } });
  const returned = applyReviewTiming(before, { ...before, status: 'supplier_action' }, dueAt);
  assert.equal(returned.reviewTiming?.qaTet, undefined);
  const next = applyReviewTiming(returned, { ...returned, status: 'submitted' }, dueAt);
  assert.deepEqual(next.reviewTiming.qaTet, { startedAt: dueAt });
});
