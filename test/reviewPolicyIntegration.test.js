const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, fakeAuthService, unsignedPayload } = require('./helpers/apiHarness');

const start = '2026-10-20T08:00:00.000Z';
const done = { prepared: true, checked: true, approved: true };
const policy = days => ({ schemaVersion: 1, version: 1, pendingDays: {
  gscTet: null, prodEngTet: days, qaTet: 3, gscTapbu: null, qaTapbu: null, qaFinal: null
}, updatedAt: null, updatedBy: null });

test('current settings recalculate ongoing deadlines in overview and timeline without modifying PCNs', async t => {
  const clock = () => new Date('2026-10-24T08:00:00.000Z');
  const api = await startApi(t, { clock, authService: fakeAuthService({ additionalUsers: [
    { username: 'viewer', employeeCode: '0800001', identityProvider: 'employee-code', roles: [] }
  ] }) });
  const supplier = await api.login('supplier');
  const admin = await api.login('admin');
  const viewer = await api.login('viewer');
  const created = await api.request('/api/pcns', { method: 'POST', session: supplier, body: unsignedPayload });
  const id = created.body.data.id;
  const saved = await api.repository.update(id, current => ({ ...current,
    reviewTiming: { prodEngTet: { startedAt: start } },
    internalReview: { ...current.internalReview, signoff: { gscTet: done } }
  }), 'Fixture handoff', created.body.data.version);
  let settings = policy(7);
  api.repository.getWorkflowSettings = async () => structuredClone(settings);
  for (const session of [admin, supplier, viewer]) {
    const overview = await api.request('/api/pcns/overview', { session });
    assert.equal(overview.status, 200);
    const pending = overview.body.data.items.find(item => item.id === id).dashboard.pending;
    assert.equal(pending.activeReviewDeadline.dueAt, '2026-10-27T08:00:00.000Z');
    assert.equal(pending.overdue, false);
    const summary = await api.request(`/api/pcns/${id}/workflow-summary`, { session });
    assert.equal(summary.body.data.stages.find(stage => stage.key === 'signoff.prodEngTet').deadline.dueAt,
      pending.activeReviewDeadline.dueAt);
  }
  settings = policy(1);
  const shortened = await api.request('/api/pcns/overview', { session: viewer });
  assert.equal(shortened.body.data.items[0].dashboard.pending.departmentOverdueDays, 3);
  settings = policy(null);
  const disabled = await api.request('/api/pcns/overview', { session: viewer });
  assert.equal(disabled.body.data.items[0].dashboard.pending.activeReviewDeadline, null);
  assert.equal(disabled.body.data.items[0].dashboard.pending.departmentOverdueDays, null);
  assert.deepEqual(await api.repository.findById(id), saved, 'Reading changed rules preserves starts, signatures and version');
  assert.deepEqual(api.messages, [], 'Reading changed rules does not queue mail');
});

test('unavailable current workflow settings fail explicitly rather than evaluating obsolete defaults', async t => {
  const api = await startApi(t);
  const admin = await api.login('admin');
  api.repository.getWorkflowSettings = async () => { throw new Error('Settings store unavailable'); };
  const overview = await api.request('/api/pcns/overview', { session: admin });
  assert.equal(overview.status, 500);
  assert.doesNotMatch(JSON.stringify(overview.body), /Settings store unavailable/);
});
