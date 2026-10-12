const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, fakeAuthService } = require('./helpers/apiHarness');

test('self profile requires sign-in and rejects every user selector without lookup', async t => {
  let calls = 0;
  const api = await startApi(t, { integrationService: { async directory() { calls++; return { users: [] }; } } });
  assert.equal((await api.request('/api/profile')).status, 401);
  const session = await api.login('admin');
  for (const route of ['/api/profile?userId=other', '/api/profile?query=name', '/api/profile?employeeCode=other']) {
    assert.equal((await api.request(route, { session })).status, 400);
  }
  assert.equal((await api.request('/api/profile', { method: 'POST', session, body: { userId: 'other' } })).status, 405);
  assert.equal(calls, 0);
});

test('roleless employee can read their own display profile and Records while administration remains forbidden', async t => {
  const queries = [];
  const api = await startApi(t, { authService: fakeAuthService({ additionalUsers: [{ username: 'viewer', roles: [], employeeCode: '2205529', identityProvider: 'employee-code' }] }),
    employeeDirectory: { async getByCode(code) { assert.equal(code, '2205529'); return { employeeCode: code, englishName: 'Current Person' }; } },
    integrationService: { async directory(query) { queries.push(query); return { users: [{ id: 'id1', displayName: 'Current Person', email: 'current@example.test', photo: 'data:image/png;base64,aGVsbG8=' }] }; } } });
  const session = await api.login('viewer');
  const profile = await api.request('/api/profile', { session });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.email, 'current@example.test');
  assert.equal(profile.body.data.status, 'available');
  assert.deepEqual(queries, ['Current Person']);
  assert.equal((await api.request('/api/pcns', { session })).status, 200);
  assert.equal((await api.request('/api/master-data', { session })).status, 200);
  for (const route of ['/api/admin/directory-users?query=someone']) {
    assert.equal((await api.request(route, { session })).status, 403);
  }
  assert.equal((await api.request('/api/profile', { session })).status, 200);
  assert.equal(queries.length, 1);
  await api.request('/api/auth/logout', { method: 'POST', session });
  assert.equal((await api.request('/api/profile', { session })).status, 401);
  assert.equal(queries.length, 1);
});
