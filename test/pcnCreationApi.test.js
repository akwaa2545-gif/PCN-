const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, unsignedPayload } = require('./helpers/apiHarness');
const input = { clientDraftKey: '50000000-0000-4000-8000-000000000001', document: unsignedPayload };
test('draft endpoints require authentication and CSRF, preserve ownership, and never queue mail', async t => {
  let repository;
  const api = await startApi(t, { documents: { async listForRecords(ids) { return new Map(await Promise.all(ids.map(async id => [id, { parentVersion: (await repository.findById(id)).version, attachments: [] }]))); } } });
  repository = api.repository;
  const session = await api.login('supplier'); const other = await api.login('other');
  assert.equal((await api.request('/api/pcn-drafts')).status, 401);
  assert.equal((await api.request('/api/pcn-drafts', { method: 'POST', session, csrf: null, body: input })).status, 403);
  const saved = await api.request('/api/pcn-drafts', { method: 'POST', session, body: input });
  assert.equal(saved.status, 201); assert.equal(saved.body.data.record.status, 'draft');
  const id = saved.body.data.record.id;
  assert.equal((await api.request(`/api/pcn-drafts/${id}`, { session: other })).status, 404);
  assert.equal((await api.request(`/api/pcn-drafts/${id}/preflight`, { method: 'POST', session, body: { version: saved.body.data.record.version } })).status, 200);
  assert.deepEqual(api.messages, []);
});

test('draft API preserves test marks, strict payloads and stale version conflicts, with safe template and receipt reads', async t => {
  const api = await startApi(t); const session = await api.login('supplier'); const other = await api.login('other');
  const saved = await api.request('/api/pcn-drafts', { method: 'POST', session, body: { ...input, testDocument: true } });
  assert.equal(saved.status, 201); const { id, version } = saved.body.data.record;
  assert.equal(saved.body.data.record.isTestDocument, true);
  const injected = await api.request(`/api/pcn-drafts/${id}`, { method: 'PATCH', session, body: { version, document: { isTestDocument: false } } });
  assert.equal(injected.status, 400);
  const update = await api.request(`/api/pcn-drafts/${id}`, { method: 'PATCH', session, body: { version, document: { reason: 'A deliberate test edit' } } });
  assert.equal(update.status, 200); assert.equal(update.body.data.record.isTestDocument, true);
  assert.equal((await api.request(`/api/pcn-drafts/${id}`, { method: 'PATCH', session, body: { version, document: { reason: 'Stale' } } })).status, 409);
  const template = await api.request(`/api/pcns/${id}/template`, { session });
  assert.equal(template.status, 200); assert.equal(template.body.data.isTestDocument, true);
  assert.equal(Object.hasOwn(template.body.data, 'documentControl'), false);
  assert.equal((await api.request(`/api/pcns/${id}/template`, { session: other })).status, 404);
  const receipt = await api.request(`/api/pcns/${id}/receipt?version=${update.body.data.record.version}`, { session });
  assert.equal(receipt.status, 200); assert.equal(receipt.body.data.notification.state, 'not_queued');
  assert.doesNotMatch(JSON.stringify(receipt.body), /Recipient|PayloadJson|LastError|creationDraftKey|signatureBindings/);
  assert.equal((await api.request(`/api/pcns/${id}/receipt?version=${version}`, { session: other })).status, 404);
  assert.equal((await api.request(`/api/pcns/${id}/receipt?version=invalid`, { session })).status, 400);
  assert.deepEqual(api.messages, []);
});

test('draft API saves cleared change text without restoring catalog content and still refuses submission', async t => {
  const api = await startApi(t); const session = await api.login('supplier');
  const { formDefinitions } = require('../src/masterData');
  const options = formDefinitions.rawMaterial.riskOptions.filter(option => option.risk === 'RL2');
  const rows = options.slice(0, 2).map((option, index) => ({ ...option, optionText: option.text,
    currentCondition: `Before ${index}`, newCondition: `After ${index}` }));
  const created = await api.request('/api/pcn-drafts', { method: 'POST', session,
    body: { ...input, document: { ...unsignedPayload, changeRows: rows } } });
  assert.equal(created.status, 201); const { id, version } = created.body.data.record;
  const cleared = [{ ...rows[0], text: '' }, rows[1]];
  const saved = await api.request(`/api/pcn-drafts/${id}`, { method: 'PATCH', session,
    body: { version, document: { selectedChange: '', changeRows: cleared } } });
  assert.equal(saved.status, 200); assert.equal(saved.body.data.record.selectedChange, '');
  assert.deepEqual(saved.body.data.record.changeRows, cleared);
  const submit = await api.request(`/api/pcns/${id}`, { method: 'PATCH', session,
    body: { version: saved.body.data.record.version, status: 'submitted' } });
  assert.equal(submit.status, 400);
  assert.equal((await api.repository.findById(id)).status, 'draft'); assert.deepEqual(api.messages, []);
});
