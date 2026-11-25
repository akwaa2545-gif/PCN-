const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, unsignedPayload, fakeAuthService } = require('./helpers/apiHarness');
const users = [
  { username: 'dev', roles: ['developer'], department: 'developer', signingStep: null },
  { username: 'bad-dev', roles: ['developer'], department: 'it', signingStep: null },
  { username: 'viewer', roles: [], identityProvider: 'employee-code', employeeCode: '7654321' }
];
const path = '/api/admin/change-categories';
async function settings(api, session) {
  const response = await api.request(path, { session });
  assert.equal(response.status, 200, response.text);
  return response.body.data;
}

test('Administrator and exclusive Developer can publish wording, risk, added and disabled options with version conflict protection', async t => {
  const api = await startApi(t, { authService: fakeAuthService({ additionalUsers: users }) });
  const admin = await api.login('admin'), dev = await api.login('dev');
  const original = await settings(api, admin);
  const forms = structuredClone(original.forms);
  forms.rawMaterial[0] = { text: 'Edited administrator wording', risk: 'RL1', enabled: true };
  forms.rawMaterial[1].enabled = false;
  forms.rawMaterial.push({ text: 'Added administrator option', risk: 'RL0', enabled: true });
  const body = { versionId: original.versionId, forms, reason: 'Reviewed category catalogue' };
  const saved = await api.request(path, { method: 'PUT', session: dev, body });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.data.versionId, 2);
  assert.deepEqual(saved.body.data.forms, forms);
  assert.deepEqual(await settings(api, admin), saved.body.data);
  assert.equal((await api.request(path, { method: 'PUT', session: admin, body })).status, 409);
  const master = await api.request('/api/master-data', { session: admin });
  assert.equal(master.status, 200);
  const options = master.body.data.formDefinitions.rawMaterial.riskOptions;
  assert.ok(options.some(option => option.text === 'Added administrator option'));
  assert.equal(options.some(option => option.text === forms.rawMaterial[1].text), false);
  assert.equal(Object.hasOwn(master.body.data, 'changeCategoriesPublication'), false);
});

test('master settings reject other roles, missing CSRF, foreign origin and protected configuration without publishing', async t => {
  const api = await startApi(t, { authService: fakeAuthService({ additionalUsers: users }) });
  const admin = await api.login('admin');
  const original = await settings(api, admin), body = { ...original, reason: 'Check protection' };
  assert.equal((await api.request(path)).status, 401);
  for (const name of ['supplier', 'bad-dev', 'viewer']) {
    const session = await api.login(name);
    assert.equal((await api.request(path, { session })).status, 403, name);
    assert.equal((await api.request(path, { method: 'PUT', session, body })).status, 403, name);
  }
  assert.equal((await api.request(path, { method: 'PUT', session: admin, csrf: null, body })).status, 403);
  assert.equal((await api.request(path, { method: 'PUT', session: admin, origin: 'http://attacker.test', body })).status, 403);
  for (const invalid of [{ ...body, workflowBase: [] }, { ...body, reason: '' },
    { ...body, forms: { ...body.forms, rawMaterial: [{ text: 'Wrong risk', risk: 'RL9', enabled: true }] } }]) {
    assert.equal((await api.request(path, { method: 'PUT', session: admin, body: invalid })).status, 400);
  }
  assert.deepEqual(await settings(api, admin), original);
  assert.equal((await api.request(`${path}?versionId=1`, { session: admin })).status, 400);
});

test('record-specific master preserves original definitions and authorized ownership while new PCNs use published options', async t => {
  const api = await startApi(t, { authService: fakeAuthService({ additionalUsers: users }) });
  const admin = await api.login('admin');
  const created = await api.request('/api/pcns', { method: 'POST', session: admin, body: { ...unsignedPayload, status: 'draft' } });
  assert.equal(created.status, 201, created.text);
  const record = created.body.data, original = await settings(api, admin);
  const forms = structuredClone(original.forms);
  const row = forms.rawMaterial.find(option => option.text === unsignedPayload.selectedChange);
  row.text = 'Published replacement'; row.risk = 'RL1';
  const saved = await api.request(path, { method: 'PUT', session: admin, body: { ...original, forms, reason: 'Change defaults only' } });
  assert.equal(saved.status, 200, saved.text);
  const masterPath = `/api/pcns/${record.id}/master-data`;
  const pinned = await api.request(masterPath, { session: admin });
  assert.equal(pinned.status, 200, pinned.text);
  assert.equal(pinned.body.data.versionId, original.versionId);
  assert.ok(pinned.body.data.formDefinitions.rawMaterial.riskOptions.some(option => option.text === unsignedPayload.selectedChange && option.risk === 'RL2'));
  const existing = await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: admin, body: { version: record.version, reason: 'Existing document edit' } });
  assert.equal(existing.status, 200, existing.text);
  assert.equal(existing.body.data.riskLevel, 'RL2');
  const resumed = await api.request(`/api/pcn-drafts/${record.id}`, { session: admin });
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.body.data.masterData.versionId, original.versionId);
  assert.equal((await api.request(masterPath, { session: await api.login('other') })).status, 404);
  assert.equal((await api.request(masterPath, { session: await api.login('viewer') })).status, 200);
  assert.equal((await api.request(`${masterPath}?version=2`, { session: admin })).status, 400);
  const newDoc = await api.request('/api/pcns', { method: 'POST', session: admin, body: { ...unsignedPayload, status: 'draft', riskLevel: 'RL1', selectedChange: row.text,
    changeRows: [{ text: row.text, optionText: row.text, risk: 'RL1' }] } });
  assert.equal(newDoc.status, 201, newDoc.text);
  assert.equal(newDoc.body.data.masterDataVersionId, saved.body.data.versionId);
  assert.equal(newDoc.body.data.riskLevel, 'RL1');
});

test('lost first-save responses retry against the issued draft master after defaults change without issuing another code', async t => {
  const api = await startApi(t), admin = await api.login('admin');
  const clientDraftKey = '57000000-0000-4000-8000-000000000001';
  const request = { clientDraftKey, document: unsignedPayload };
  const first = await api.request('/api/pcn-drafts', { method: 'POST', session: admin, body: request });
  assert.equal(first.status, 201, first.text);
  const original = first.body.data.record, settingsBefore = await settings(api, admin);
  const forms = structuredClone(settingsBefore.forms);
  const option = forms.rawMaterial.find(item => item.text === unsignedPayload.selectedChange);
  option.text = 'Replacement after first-save response was lost'; option.risk = 'RL1'; option.enabled = false;
  const published = await api.request(path, { method: 'PUT', session: admin, body: { ...settingsBefore, forms, reason: 'Reword and disable category' } });
  assert.equal(published.status, 200, published.text);
  const retry = await api.request('/api/pcn-drafts', { method: 'POST', session: admin, body: request });
  assert.equal(retry.status, 201, retry.text);
  assert.equal(retry.body.data.reused, true);
  assert.equal(retry.body.data.record.id, original.id);
  assert.equal(retry.body.data.record.masterDataVersionId, original.masterDataVersionId);
  assert.equal((await api.repository.list()).length, 1);
  assert.equal((await api.repository.getRevisions(original.id)).length, 1);
  const wrongType = await api.request('/api/pcn-drafts', { method: 'POST', session: admin,
    body: { ...request, document: { ...unsignedPayload, documentType: 'sc' } } });
  assert.equal(wrongType.status, 409, wrongType.text);
  for (const document of [{ ...unsignedPayload, status: 'submitted' }, { ...unsignedPayload, riskLevel: 'RL9' },
    { ...unsignedPayload, changeRows: [{ text: 'Forged category', risk: 'RL2' }], selectedChange: 'Forged category' }]) {
    const invalid = await api.request('/api/pcn-drafts', { method: 'POST', session: admin, body: { ...request, document } });
    assert.equal(invalid.status, 400, invalid.text);
  }
  const enabled = forms.rawMaterial.find(item => item.enabled);
  const next = await api.request('/api/pcn-drafts', { method: 'POST', session: admin,
    body: { clientDraftKey: '57000000-0000-4000-8000-000000000002', document: { ...unsignedPayload, riskLevel: enabled.risk,
      selectedChange: enabled.text, changeRows: [{ text: enabled.text, optionText: enabled.text, risk: enabled.risk }] } } });
  assert.equal(next.status, 201, next.text);
  assert.equal(Number(next.body.data.record.id.slice(-2)), Number(original.id.slice(-2)) + 1);
  assert.equal((await api.repository.list()).length, 2);
});
