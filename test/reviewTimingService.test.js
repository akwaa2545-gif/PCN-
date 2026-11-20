const test = require('node:test');
const assert = require('node:assert/strict');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, unsignedPayload } = require('./helpers/apiHarness');
const { prodEngDeadline, qaDeadline } = require('../src/reviewTiming');

const start = '2026-10-20T03:00:00.000Z';
const later = '2026-10-22T03:00:00.000Z';
const complete = { prepared: true, checked: true, approved: true };
async function fixture(review = { signoff: { gscTet: { prepared: true, checked: true } } }) {
  const repository = memoryRepository();
  let time = start;
  const service = new PcnService(repository, () => new Date(time));
  const record = await repository.create({ ...service.normalizeInput({ ...unsignedPayload, status: 'gsc_review', internalReview: review }),
    createdAt: start, updatedAt: start });
  return { repository, record, service, setTime(value) { time = value; } };
}

test('service starts timing on the final GSC signature, persists it, and preserves it for partial Prod.Eng work and notes', async () => {
  const { repository, record, service, setTime } = await fixture();
  const handed = await service.update(record.id, { version: record.version, internalReview: { signoff: { gscTet: complete } } });
  assert.equal(handed.reviewTiming.prodEngTet.startedAt, start);
  assert.deepEqual((await repository.findById(record.id)).reviewTiming, handed.reviewTiming);
  const savedHistory = await repository.getRevision(record.id, 2);
  assert.deepEqual(savedHistory.snapshot.reviewTiming, handed.reviewTiming);
  setTime(later);
  const partial = await service.update(record.id, { version: handed.version, internalReview: { signoff: {
    prodEngTet: { prepared: true, checked: true, comment: 'Evaluating' }
  } } });
  assert.equal(partial.reviewTiming.prodEngTet.startedAt, start);
  const noted = await service.addComment(record.id, { version: partial.version, role: 'Reviewer', comment: 'Follow up' });
  assert.equal(noted.reviewTiming.prodEngTet.startedAt, start);
  const completeReview = await service.update(record.id, { version: noted.version, internalReview: { signoff: { prodEngTet: complete } } });
  assert.equal(completeReview.reviewTiming?.prodEngTet, undefined);
});

test('starting a controlled revision clears timing after signatures reset; next actual handoff starts again', async () => {
  const { record, service, setTime } = await fixture();
  const handed = await service.update(record.id, { version: record.version, internalReview: { signoff: { gscTet: complete } } });
  setTime(later);
  const revision = await service.startRevision(record.id, { version: handed.version, reason: 'Supplier correction' }, 'admin',
    { id: 'admin', roles: ['admin'], isActive: true });
  assert.equal(revision.reviewTiming?.prodEngTet, undefined);
  assert.equal(revision.internalReview.signoff.gscTet.approved, false);
  // Restore submitted state directly as a fixture; submission completion is covered by document checks.
  const reset = await service.repository.update(record.id, current => ({ ...current, status: 'gsc_review' }), 'fixture', revision.version);
  const reentered = await service.update(record.id, { version: reset.version, internalReview: { signoff: { gscTet: complete } } });
  assert.equal(reentered.reviewTiming.prodEngTet.startedAt, later);
});

test('routine legacy updates never invent handoff timing', async () => {
  const { record, service } = await fixture({ signoff: { gscTet: complete } });
  const changed = await service.update(record.id, { version: record.version, internalReview: { signoff: { prodEngTet: { comment: 'Reviewing' } } } });
  assert.equal(prodEngDeadline(changed, new Date(start)).source, 'unknown');
});

test('service rejects client-supplied review timing on create and update', async () => {
  const { record, service } = await fixture();
  const reviewTiming = { prodEngTet: { startedAt: start } };
  await assert.rejects(service.create({ ...unsignedPayload, status: 'draft', reviewTiming }), /Field cannot be written: reviewTiming/);
  await assert.rejects(service.update(record.id, { version: record.version, reviewTiming }), /Field cannot be written: reviewTiming/);
});

test('draft creation remains inactive and does not gain a review deadline', async () => {
  const service = new PcnService(memoryRepository(), () => new Date(start));
  const record = await service.create({ ...unsignedPayload, status: 'draft' });
  assert.equal(record.reviewTiming?.prodEngTet, undefined);
  assert.equal(prodEngDeadline(record, new Date(start)), null);
});

test('service hands off to QA atomically, persists timing, preserves partial work and clears on review completion', async () => {
  const { record, service, repository, setTime } = await fixture({
    signoff: { gscTet: { prepared: true, checked: true } }, tapbu: { noNeed: true }
  });
  const prodEng = await service.update(record.id, { version: record.version, internalReview: { signoff: { gscTet: complete } } });
  setTime(later);
  const handed = await service.update(record.id, { version: prodEng.version, internalReview: { signoff: { prodEngTet: complete } } });
  assert.equal(handed.reviewTiming.prodEngTet, undefined);
  assert.equal(handed.reviewTiming.qaTet.startedAt, later);
  assert.deepEqual((await repository.findById(record.id)).reviewTiming, handed.reviewTiming);
  assert.deepEqual((await repository.getRevision(record.id, 3)).snapshot.reviewTiming, handed.reviewTiming);
  setTime('2026-10-24T03:00:00.000Z');
  const partial = await service.update(record.id, { version: handed.version, internalReview: { signoff: {
    qaTet: { prepared: true, checked: true, comment: 'Qualification checks' }
  } } });
  assert.equal(partial.reviewTiming.qaTet.startedAt, later);
  const noted = await service.addComment(record.id, { version: partial.version, role: 'QA', comment: 'Review status' });
  assert.equal(noted.reviewTiming.qaTet.startedAt, later);
  const finished = await service.update(record.id, { version: noted.version, internalReview: { signoff: { qaTet: complete } } });
  assert.equal(finished.reviewTiming?.qaTet, undefined);
  assert.equal(finished.reviewTiming.qaFinal.startedAt, '2026-10-24T03:00:00.000Z');
  assert.equal(qaDeadline(finished), null);
});

test('service keeps legacy QA timing unknown, clears on controlled revision and restarts after a new handoff', async () => {
  const { record, service, setTime } = await fixture({ signoff: { gscTet: complete, prodEngTet: complete } });
  const partial = await service.update(record.id, { version: record.version, internalReview: { signoff: { qaTet: { prepared: true } } } });
  assert.equal(qaDeadline(partial, new Date(start)).source, 'unknown');
  const revised = await service.startRevision(record.id, { version: partial.version, reason: 'Updated document' }, 'admin',
    { id: 'admin', roles: ['admin'], isActive: true });
  assert.equal(revised.reviewTiming?.qaTet, undefined);
  const reset = await service.repository.update(record.id, current => ({ ...current, status: 'gsc_review' }), 'fixture', revised.version);
  setTime(later);
  const handed = await service.update(record.id, { version: reset.version, internalReview: { signoff: { gscTet: complete, prodEngTet: complete } } });
  assert.equal(handed.reviewTiming.qaTet.startedAt, later);
  await assert.rejects(service.update(record.id, { version: handed.version, reviewTiming: { qaTet: { startedAt: start } } }), /Field cannot be written: reviewTiming/);
});
