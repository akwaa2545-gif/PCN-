const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, unsignedPayload, fakeAuthService, memoryRepository } = require('./helpers/apiHarness');
const { PcnService } = require('../src/pcnService');

const done = { prepared: true, checked: true, approved: true };
const review = ({ decision = true, lastHeader = false, noNeed = false } = {}) => ({
  signoff: { gscTet: done, prodEngTet: done, qaTet: done },
  tapbu: noNeed ? { noNeed: true } : { need: true, gsc: done, qa: done },
  qateFinal: { signoff: done, approve: decision, reject: false },
  supplierSignoff: { prepared: { checked: true }, checked: { checked: true }, approved: { checked: lastHeader } }
});
async function fixture(t, options = {}) {
  const api = await startApi(t, options);
  const admin = await api.login('admin');
  const created = await api.request('/api/pcns', { method: 'POST', session: admin, body: unsignedPayload });
  assert.equal(created.status, 201);
  return { ...api, admin, id: created.body.data.id };
}
const patch = (api, current, internalReview, extra = {}) => api.request(`/api/pcns/${api.id}`, {
  method: 'PATCH', session: api.admin, body: { version: current.version, internalReview, ...extra }
});

test('last header closes in the same authorized save, records identity and persists one revision', async t => {
  const api = await fixture(t, { authService: fakeAuthService({ additionalUsers: [{ username: 'reviewer', roles: ['reviewer'] }] }) });
  const current = await api.repository.seedHistoricalReview(api.id, review());
  const revisions = await api.repository.getRevisions(api.id);
  const result = await api.request(`/api/pcns/${api.id}`, { method: 'PATCH', session: await api.login('reviewer'),
    body: { version: current.version, internalReview: { supplierSignoff: { approved: { checked: true } } } } });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.data.status, 'closed');
  assert.equal(result.body.data.internalReview.supplierSignoff.approved.name, 'reviewer');
  assert.equal(result.body.data.documentControl.signatureBindings['supplierSignoff.approved'].userId, 'reviewer-id');
  const saved = await api.repository.findById(api.id);
  assert.equal(saved.status, 'closed');
  const history = await api.repository.getRevisions(api.id);
  assert.equal(history.length, revisions.length + 1);
  assert.ok(history[0].changes.some(change => change.path === 'status' && change.after === 'closed'));
  const retry = await patch(api, current, { supplierSignoff: { approved: { checked: true } } });
  assert.equal(retry.status, 409);
  assert.equal((await patch(api, saved, {})).status, 403);
  assert.equal((await api.repository.getRevisions(api.id)).length, history.length);
});

test('last header closes without selecting a final decision and preserves both unselected fields', async t => {
  const api = await fixture(t);
  let current = await api.repository.seedHistoricalReview(api.id, review({ decision: false }));
  let result = await patch(api, current, { supplierSignoff: { approved: { checked: true } } });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.data.status, 'closed');
  assert.equal(result.body.data.internalReview.qateFinal.approve, false);
  assert.equal(result.body.data.internalReview.qateFinal.reject, false);
});

test('already fully signed active documents close on the next authorized save; partial headers stay open', async t => {
  const partial = await fixture(t);
  let current = await partial.repository.seedHistoricalReview(partial.id, review({ decision: false }));
  let result = await patch(partial, current, {});
  assert.equal(result.body.data.status, 'submitted');
  current = await partial.repository.seedHistoricalReview(partial.id, review({ decision: false, lastHeader: true }));
  const beforeReads = await partial.repository.getRevisions(partial.id);
  assert.equal((await partial.request(`/api/pcns/${partial.id}`, { session: partial.admin })).body.data.status, 'submitted');
  assert.equal((await partial.repository.getRevisions(partial.id)).length, beforeReads.length);
  result = await patch(partial, current, {});
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.data.status, 'closed');
  assert.equal(result.body.data.internalReview.qateFinal.approve, false);
  assert.equal(result.body.data.internalReview.qateFinal.reject, false);
  const history = await partial.repository.getRevisions(partial.id);
  assert.equal(history.length, beforeReads.length + 1);
  assert.ok(history[0].changes.some(change => change.path === 'status' && change.after === 'closed'));
});

test('explicit manual closure requires headers and keeps QA authority and transition validation', async t => {
  const api = await fixture(t, { authService: fakeAuthService({ additionalUsers: [{ username: 'reviewer', roles: ['reviewer'] }] }) });
  const current = await api.repository.seedHistoricalReview(api.id, review());
  const rejected = await patch(api, current, {}, { status: 'closed' });
  assert.equal(rejected.status, 400, rejected.text);
  assert.match(rejected.body.error, /header/i);
  const bypass = await api.request(`/api/pcns/${api.id}`, { method: 'PATCH', session: await api.login('reviewer'),
    body: { version: current.version, status: 'closed', internalReview: { supplierSignoff: { approved: { checked: true } } } } });
  assert.equal(bypass.status, 403);
  const anonymous = await api.request(`/api/pcns/${api.id}`, { method: 'PATCH', body: { version: current.version, internalReview: { supplierSignoff: { approved: { checked: true } } } } });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await api.repository.findById(api.id), current);
  assert.deepEqual(api.messages, []);
});

test('invalid final choice and invalid route signatures cannot persist closure or jobs', async t => {
  const api = await fixture(t);
  const current = await api.repository.seedHistoricalReview(api.id, review());
  const histories = await api.repository.getRevisions(api.id);
  for (const delta of [
    { supplierSignoff: { approved: { checked: true } }, qateFinal: { reject: true } },
    { supplierSignoff: { approved: { checked: true } }, signoff: { gscTet: { prepared: false } } },
    { supplierSignoff: { approved: { checked: 'true' } } }
  ]) assert.equal((await patch(api, current, delta)).status, 400);
  assert.deepEqual(await api.repository.findById(api.id), current);
  assert.deepEqual(await api.repository.getRevisions(api.id), histories);
  assert.deepEqual(api.messages, []);
});

test('automatic closure cannot bypass an invalid requested status or another role’s header permission', async t => {
  const api = await fixture(t, { authService: fakeAuthService({ additionalUsers: [
    { username: 'qa', roles: ['qa'], department: 'qaTet', signingStep: 'approved' }
  ] }) });
  const current = await api.repository.seedHistoricalReview(api.id, review());
  const attempted = await patch(api, current, { supplierSignoff: { approved: { checked: true } } }, { status: 'qualification' });
  assert.equal(attempted.status, 400, attempted.text);
  assert.match(attempted.body.error, /skip steps/);
  const denied = await api.request(`/api/pcns/${api.id}`, { method: 'PATCH', session: await api.login('qa'),
    body: { version: current.version, internalReview: { supplierSignoff: { approved: { checked: true } } } } });
  assert.equal(denied.status, 403, denied.text);
  assert.deepEqual(await api.repository.findById(api.id), current);
  assert.deepEqual(api.messages, []);
});

test('selected required files still block automatic closure atomically', async t => {
  const api = await fixture(t);
  const current = await api.repository.seedHistoricalReview(api.id, { ...review(), docs: { hazardousReport: true } });
  const histories = await api.repository.getRevisions(api.id);
  const result = await patch(api, current, { supplierSignoff: { approved: { checked: true } } });
  assert.equal(result.status, 400, result.text);
  assert.ok(result.body.details.missing.some(item => item.key === 'hazardousReport'));
  assert.deepEqual(await api.repository.findById(api.id), current);
  assert.deepEqual(await api.repository.getRevisions(api.id), histories);
  assert.deepEqual(api.messages, []);
});

test('closure reads attachment evidence from the update transaction; only clean current required files qualify', async () => {
  const repository = memoryRepository();
  const service = new PcnService(repository, () => new Date('2026-10-22T05:00:00Z'));
  const admin = { id: 'admin', roles: ['admin'], isActive: true };
  const created = await service.create(unsignedPayload, 'Tester', admin);
  const current = await repository.seedHistoricalReview(created.id, { ...review(), docs: { hazardousReport: true } });
  let files = [];
  let attachmentReads = 0;
  const update = repository.update.bind(repository);
  repository.update = (id, updater, ...args) => update(id, row => updater(row, {
    async listAttachments() { attachmentReads++; return files; }
  }), ...args);
  const input = { version: current.version, internalReview: { supplierSignoff: { approved: { checked: true } } } };
  for (const invalid of [[], [{ requirementName: 'hazardousReport', scanStatus: 'pending' }],
    [{ requirementName: 'hazardousReport', scanStatus: 'clean', isDeleted: true }]]) {
    files = invalid;
    await assert.rejects(service.update(created.id, input, 'Tester', admin), { statusCode: 400 });
    assert.deepEqual(await repository.findById(created.id), current);
  }
  files = [{ requirementName: 'hazardousReport', scanStatus: 'clean' }];
  const closed = await service.update(created.id, input, 'Tester', admin);
  assert.equal(closed.status, 'closed');
  assert.equal(attachmentReads, 4);
});

test('complete RL0 and explicit TaPBU skip routes close without TaPBU signatures', async t => {
  for (const riskLevel of ['RL0', 'RL2']) {
    const api = await startApi(t);
    api.admin = await api.login('admin');
    const selectedChange = riskLevel === 'RL0' ? 'Supplier formal name modification' : unsignedPayload.selectedChange;
    const created = await api.request('/api/pcns', { method: 'POST', session: api.admin,
      body: { ...unsignedPayload, riskLevel, selectedChange, changeRows: [{ risk: riskLevel, text: selectedChange }] } });
    assert.equal(created.status, 201, created.text);
    api.id = created.body.data.id;
    const current = await api.repository.seedHistoricalReview(api.id, review({ noNeed: true }));
    const result = await patch(api, current, { supplierSignoff: { approved: { checked: true } } });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.data.status, 'closed');
  }
});

test('signed draft save remains draft; normal submission of a fully signed draft closes', async t => {
  const api = await startApi(t);
  const supplier = await api.login('supplier');
  api.admin = supplier;
  const created = await api.request('/api/pcns', { method: 'POST', session: supplier, body: { ...unsignedPayload, status: 'draft' } });
  api.id = created.body.data.id;
  const current = await api.repository.seedHistoricalReview(api.id, review());
  const draft = await patch(api, current, { supplierSignoff: { approved: { checked: true } } }, { status: 'draft' });
  assert.equal(draft.status, 200, draft.text);
  assert.equal(draft.body.data.status, 'draft');
  const submitted = await patch(api, draft.body.data, {}, { status: 'submitted' });
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal(submitted.body.data.status, 'closed');
});
