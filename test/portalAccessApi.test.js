const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, fakeAuthService, unsignedPayload } = require('./helpers/apiHarness');

test('portal record reads support every assigned role while administration stays restricted', async t => {
  const roles = ['reviewer', 'gsc', 'productionengineering', 'qa', 'tapbu'];
  const api = await startApi(t, { authService: fakeAuthService({ additionalUsers: [
    ...roles.map(role => ({ username: role, roles: [role] })),
    { username: 'viewer', roles: [], identityProvider: 'employee-code', employeeCode: '0012345' }
  ] }) });
  const supplier = await api.login('supplier');
  const other = await api.login('other');
  const own = await api.request('/api/pcns', { method: 'POST', session: supplier, body: unsignedPayload });
  const privateRecord = await api.request('/api/pcns', { method: 'POST', session: other, body: unsignedPayload });
  assert.equal(own.status, 201);
  assert.equal(privateRecord.status, 201);
  assert.deepEqual((await api.request('/api/pcns', { session: supplier })).body.data.map(record => record.id), [own.body.data.id]);
  assert.equal((await api.request(`/api/pcns/${privateRecord.body.data.id}`, { session: supplier })).status, 404);
  for (const username of ['supplier', ...roles]) {
    const session = await api.login(username);
    const list = await api.request('/api/pcns', { session });
    assert.equal(list.status, 200, username);
    assert.equal(list.body.data.length, username === 'supplier' ? 1 : 2, username);
    for (const route of ['/api/admin/users', '/api/notification-settings', '/api/admin/notifications/health']) {
      assert.equal((await api.request(route, { session })).status, 403, `${username}: ${route}`);
    }
  }
  const viewer = await api.login('viewer');
  const viewerList = await api.request('/api/pcns', { session: viewer });
  assert.equal(viewerList.status, 200);
  assert.deepEqual(viewerList.body.data.map(record => record.id).sort(), [own.body.data.id, privateRecord.body.data.id].sort());
  assert.equal((await api.request('/api/pcns')).status, 401);
});
