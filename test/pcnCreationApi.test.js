const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, unsignedPayload } = require('./helpers/apiHarness');
const input = { clientDraftKey: '50000000-0000-4000-8000-000000000001', document: unsignedPayload };
test('draft endpoints require authentication and CSRF, preserve ownership, and never queue mail', async t => {
  const api = await startApi(t); const session = await api.login('supplier'); const other = await api.login('other');
  assert.equal((await api.request('/api/pcn-drafts')).status, 401);
  assert.equal((await api.request('/api/pcn-drafts', { method: 'POST', session, csrf: null, body: input })).status, 403);
  const saved = await api.request('/api/pcn-drafts', { method: 'POST', session, body: input });
  assert.equal(saved.status, 201); assert.equal(saved.body.data.record.status, 'draft');
  const id = saved.body.data.record.id;
  assert.equal((await api.request(`/api/pcn-drafts/${id}`, { session: other })).status, 404);
  assert.equal((await api.request(`/api/pcn-drafts/${id}/preflight`, { method: 'POST', session, body: { version: saved.body.data.record.version } })).status, 200);
  assert.deepEqual(api.messages, []);
});
