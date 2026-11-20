const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, fakeAuthService, unsignedPayload } = require('./helpers/apiHarness');
const { splitRecord, hydratePcn } = require('../src/sqlPcnHydration');

test('HTTP handoff stores a three-calendar-day deadline, exposes live overdue in both read APIs and blocks forged timing', async t => {
  let clock = new Date('2026-10-23T09:45:00.000Z');
  const authService = fakeAuthService({ additionalUsers: [
    { username: 'viewer', employeeCode: '0800001', identityProvider: 'employee-code', roles: [] }
  ] });
  const api = await startApi(t, { clock: () => clock, authService });
  const admin = await api.login('admin');
  const supplier = await api.login('supplier');
  const other = await api.login('other');
  const viewer = await api.login('viewer');
  const created = await api.request('/api/pcns', { method: 'POST', session: supplier, body: unsignedPayload });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  await api.repository.update(id, current => ({ ...current, internalReview: {
    ...current.internalReview, signoff: { gscTet: { prepared: true, checked: true } }
  } }), 'Fixture earlier GSC signatures', created.body.data.version);
  const sign = async (department, step, extra = {}) => {
    const record = await api.repository.findById(id);
    return api.request('/api/pcns/' + id, { method: 'PATCH', session: admin,
      body: { version: record.version, internalReview: { signoff: { [department]: { [step]: true } } }, ...extra } });
  };
  const handoff = await sign('gscTet', 'approved');
  assert.equal(handoff.status, 200);
  assert.equal(handoff.body.data.reviewTiming.prodEngTet.startedAt, '2026-10-23T09:45:00.000Z');
  const saved = await api.repository.findById(id);
  const split = splitRecord(saved);
  const reloaded = hydratePcn({ ...split.parent, PcnCode: id, RowVersion: Buffer.from(saved.version, 'hex') }, split.review, split.children);
  assert.deepEqual(reloaded.reviewTiming, saved.reviewTiming, 'Deadline survives the SQL JSON round trip');
  clock = new Date('2026-10-26T09:45:00.001Z');
  for (const session of [admin, supplier, viewer]) {
    const overview = await api.request('/api/pcns/overview', { session });
    assert.equal(overview.status, 200);
    const pending = overview.body.data.items.find(item => item.id === id).dashboard.pending;
    assert.equal(pending.prodEngDeadline.dueAt, '2026-10-26T09:45:00.000Z');
    assert.equal(pending.prodEngDeadline.overdue, true);
    assert.equal(pending.needsAttention, true);
    const timeline = await api.request('/api/pcns/' + id + '/workflow-summary', { session });
    assert.equal(timeline.status, 200);
    assert.equal(timeline.body.data.stages.find(stage => stage.key === 'signoff.prodEngTet').deadline.overdue, true);
  }
  assert.equal((await api.request('/api/pcns/overview', { session: other })).body.data.items.length, 0);
  assert.equal((await api.request('/api/pcns/' + id + '/workflow-summary', { session: other })).status, 404);
  const versionBeforeForgery = (await api.repository.findById(id)).version;
  const forged = await api.request('/api/pcns/' + id, { method: 'PATCH', session: admin,
    body: { version: versionBeforeForgery, reviewTiming: { prodEngTet: { startedAt: clock.toISOString() } } } });
  assert.equal(forged.status, 400);
  assert.equal((await api.repository.findById(id)).version, versionBeforeForgery);
  assert.equal((await sign('prodEngTet', 'prepared')).status, 200);
  assert.equal((await api.repository.findById(id)).reviewTiming.prodEngTet.startedAt, '2026-10-23T09:45:00.000Z');
  assert.equal((await sign('prodEngTet', 'checked')).status, 200);
  assert.equal((await sign('prodEngTet', 'approved')).status, 200);
  const finished = await api.request('/api/pcns/overview', { session: admin });
  const pending = finished.body.data.items.find(item => item.id === id).dashboard.pending;
  assert.equal(pending.prodEngDeadline, null);
  assert.ok(!pending.reasons.includes('overdue'));
  assert.equal(pending.qaDeadline.startedAt, clock.toISOString());
  assert.equal(pending.activeReviewDeadline.department, 'qaTet');
  const qaSaved = await api.repository.findById(id);
  const qaSplit = splitRecord(qaSaved);
  const qaReloaded = hydratePcn({ ...qaSplit.parent, PcnCode: id, RowVersion: Buffer.from(qaSaved.version, 'hex') }, qaSplit.review, qaSplit.children);
  assert.deepEqual(qaReloaded.reviewTiming, qaSaved.reviewTiming, 'QA timing survives the same SQL extras round trip');
  clock = new Date('2026-10-29T09:45:00.002Z');
  for (const session of [admin, supplier, viewer]) {
    const overview = await api.request('/api/pcns/overview', { session });
    const qaPending = overview.body.data.items.find(item => item.id === id).dashboard.pending;
    assert.equal(qaPending.qaDeadline.overdue, true);
    assert.equal(qaPending.needsAttention, true);
    const timeline = await api.request('/api/pcns/' + id + '/workflow-summary', { session });
    assert.equal(timeline.body.data.stages.find(stage => stage.key === 'signoff.qaTet').deadline.overdue, true);
  }
  assert.equal((await sign('qaTet', 'prepared')).status, 200);
  assert.equal((await sign('qaTet', 'checked')).status, 200);
  assert.equal((await sign('qaTet', 'approved')).status, 200);
  const qaFinished = (await api.request('/api/pcns/overview', { session: admin })).body.data.items.find(item => item.id === id).dashboard.pending;
  assert.equal(qaFinished.qaDeadline, null);
  assert.equal(qaFinished.activeReviewDeadline, null);
  assert.ok(!qaFinished.reasons.includes('overdue'));
  assert.deepEqual(api.messages, [], 'Deadline evaluation does not queue email');
});
