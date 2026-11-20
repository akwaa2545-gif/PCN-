const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, unsignedPayload, fakeAuthService } = require('./helpers/apiHarness');

test('typed record aliases and shared code rules are served without replacing legacy links', async t => {
  const api = await startApi(t);
  for (const path of ['/T-19112601', '/S-19112602', '/PCN-2026-0001', '/pcn-types.js']) {
    const response = await api.request(path);
    assert.equal(response.status, 200, path);
  }
  assert.equal((await api.request('/T-31022601')).status, 404);
});

test('TA and SC API routes allow authorized reads and preserve roleless write denial', async t => {
  const api = await startApi(t, { authService: fakeAuthService({ additionalUsers: [
    { username: 'typed-viewer', id: 'typed-viewer-id', roles: [], identityProvider: 'employee-code', employeeCode: '7654321' }
  ] }) });
  const admin = await api.login('admin');
  const viewer = await api.login('typed-viewer');
  for (const documentType of ['ta', 'sc']) {
    const created = await api.request('/api/pcns', { method: 'POST', session: admin, body: { ...unsignedPayload, documentType } });
    assert.equal(created.status, 201, created.text);
    const record = created.body.data;
    const read = await api.request(`/api/pcns/${record.id}`, { session: viewer });
    assert.equal(read.status, 200, read.text);
    assert.equal(read.body.data.documentType, documentType);
    assert.equal((await api.request(`/api/pcns/${record.id}/progress`, { session: viewer })).status, 200);
    assert.equal((await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: viewer,
      body: { version: record.version, reason: 'Forbidden change' } })).status, 403);
  }
});
