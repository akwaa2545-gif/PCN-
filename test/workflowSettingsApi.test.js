const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, fakeAuthService } = require('./helpers/apiHarness');
const route = '/api/admin/workflow-settings';
const body = { schemaVersion: 1, version: 0, pendingDays: { gscTet: null, prodEngTet: 3, prodEngTa: 3, prodEngSc: 3, qaTet: 3, gscTapbu: null, qaTapbu: null, qaFinal: null } };

test('administrator reads and saves fixed workflow policy with stale-editor protection', async t => {
  const app = await startApi(t);
  const session = await app.login('admin');
  const initial = await app.request(route, { session });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.data.version, 0);
  assert.equal(initial.body.data.rules.length, 8);
  const saved = await app.request(route, { session, method: 'PUT', body: { ...body, pendingDays: { ...body.pendingDays, qaFinal: 7 } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.version, 1);
  assert.equal(saved.body.data.updatedBy, 'user:admin-id');
  assert.equal(saved.body.data.pendingDays.qaFinal, 7);
  assert.ok(saved.body.data.updatedAt);
  assert.equal((await app.request(route, { session })).body.data.version, 1);
  assert.equal((await app.request(route, { session, method: 'PUT', body })).status, 409);
});

test('settings API enforces authentication role CSRF origin exact keys and method boundaries', async t => {
  const app = await startApi(t);
  const session = await app.login('admin');
  const supplier = await app.login('supplier');
  assert.equal((await app.request(route)).status, 401);
  assert.equal((await app.request(route, { session: supplier })).status, 403);
  assert.equal((await app.request(route, { session, method: 'PUT', csrf: null, body })).status, 403);
  assert.equal((await app.request(route, { session, method: 'PUT', origin: 'https://evil.test', body })).status, 403);
  assert.equal((await app.request(`${route}?version=0`, { session })).status, 400);
  assert.equal((await app.request(route, { session, method: 'PATCH', body })).status, 405);
  assert.equal((await app.request(route, { session, method: 'PUT', body: { ...body, rules: [] } })).status, 400);
  assert.equal((await app.request(route, { session, method: 'PUT', body: { ...body, pendingDays: { ...body.pendingDays, qaTet: '3' } } })).status, 400);
  assert.deepEqual(app.messages, []);
});

test('Developer-equivalent accounts use the existing Administrator permission model', async t => {
  const app = await startApi(t, { authService: fakeAuthService({ additionalUsers: [
    { username: 'developer', roles: ['developer'], department: 'developer', signingStep: null }
  ] }) });
  const session = await app.login('developer');
  assert.equal((await app.request(route, { session })).status, 200);
  assert.equal((await app.request(route, { session, method: 'PUT', body })).status, 200);
});

test('two administrator editors cannot silently overwrite each other', async t => {
  const app = await startApi(t);
  const first = await app.login('admin'); const second = await app.login('admin');
  const results = await Promise.all([
    app.request(route, { session: first, method: 'PUT', body: { ...body, pendingDays: { ...body.pendingDays, qaTet: 5 } } }),
    app.request(route, { session: second, method: 'PUT', body: { ...body, pendingDays: { ...body.pendingDays, qaTet: 8 } } })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await app.request(route, { session: first })).body.data.version, 1);
});
