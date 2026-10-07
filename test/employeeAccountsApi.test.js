const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/httpServer');
const { AuthService } = require('../src/authService');
const { memoryRepository } = require('./helpers/apiHarness');
const USER_ID = '87654321-4321-4321-4321-cba987654321';
const profile = Object.freeze({ employeeCode: '001234', displayName: 'Employee Name', email: null,
  sourceDepartment: 'IT', jobTitle: 'Engineer', isActive: true });

async function harness(t, { roles = ['admin'], directory = true } = {}) {
  const calls = [];
  const state = { outage: false, sessions: [], user: { id: USER_ID, username: '001234', employeeCode: '001234',
    normalizedEmployeeCode: '001234', identityProvider: 'employee-code', displayName: 'Employee Name',
    roles, isActive: true, securityStamp: 'stamp' } };
  const employeeDirectory = directory ? {
    async search(query) { if (state.outage) throw new Error('private SQL'); calls.push(['search', query]); return [profile]; },
    async getByCode(code) { if (state.outage) throw new Error('private SQL'); return code === profile.employeeCode ? profile : null; }
  } : undefined;
  const repository = {
    async getUserByEmployeeCode(code) { return code === '001234' ? state.user : null; },
    async getUserById(id) { return id === USER_ID ? state.user : null; },
    async saveSession(value) { state.sessions = [...state.sessions, value]; },
    async getSession(hash) { return state.sessions.find(session => session.tokenHash === hash); },
    async revokeSession(hash) {
      state.sessions = state.sessions.map(session => session.tokenHash === hash ? { ...session, revokedAt: new Date() } : session);
    },
    async listUsers() { return [{ ...state.user, passwordHash: 'private', adSid: 'private', securityStamp: 'private' }]; },
    async createEmployeeUser(account) { calls.push(['create', account]); return { ...state.user, ...account }; },
    async linkEmployeeIdentity(id, person) { calls.push(['link', id, person]); return { ...state.user, ...person }; }
  };
  const authService = new AuthService(repository, { authMode: 'employee-code', employeeDirectory });
  const app = createApp({ repository: memoryRepository(), authService, employeeDirectory, authMode: 'employee-code',
    publicOrigin: 'http://localhost', secureCookies: false });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  let cookie = '';
  let csrfToken = '';
  async function request(route, { method = 'GET', body, session = true, csrf = true, origin = 'http://localhost', headers = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${route}`, { method, headers: {
      ...(session ? { cookie } : {}),
      ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrfToken } : {}) }),
      ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    const payload = text.startsWith('{') ? JSON.parse(text) : undefined;
    if (payload?.data?.csrfToken) csrfToken = payload.data.csrfToken;
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, headers: response.headers, body: payload, text };
  }
  async function login() { return request('/api/auth/login', { method: 'POST', session: false, body: { employeeCode: '001234' } }); }
  return { request, login, calls, state };
}

test('employee code HTTP login works without Windows headers and public config contains no secrets', async t => {
  const { request, login } = await harness(t);
  assert.deepEqual((await request('/api/auth/config')).body.data, { mode: 'employee-code', employeeProvisioningConfigured: true });
  const result = await login();
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(result.body.data.user.identityProvider, 'employee-code');
  assert.equal((await request('/api/master-data')).status, 200);
  assert.equal((await request('/api/auth/windows', { method: 'POST', body: {} })).status, 404);
});

test('login rejects privilege/profile/password body forgery and forged AD headers cannot authenticate', async t => {
  const { request } = await harness(t);
  const bodies = [{ employeeCode: '001234', roles: ['admin'] }, { employeeCode: '001234', displayName: 'spoof' },
    { employeeCode: '001234', password: 'x' }, { username: '001234', password: 'x' }];
  for (const body of bodies) assert.equal((await request('/api/auth/login', { method: 'POST', session: false, body })).status, 400);
  assert.deepEqual((await request('/api/session', { session: false,
    headers: { 'x-pcn-windows-user': 'KEMET\\001234', 'x-pcn-windows-auth-key': 'forged' } })).body.data, { authenticated: false });
  assert.equal((await request('/api/auth/login', { method: 'POST', session: false,
    origin: 'https://evil.invalid', body: { employeeCode: '001234' } })).status, 403);
});

test('employee search and user listing redact private fields and retain canonical source DTO', async t => {
  const { request, login } = await harness(t);
  await login();
  assert.deepEqual((await request('/api/admin/employees?query=001')).body.data,
    [{ employeeCode: '001234', displayName: 'Employee Name', email: null, sourceDepartment: 'IT', jobTitle: 'Engineer' }]);
  const listed = await request('/api/admin/users');
  for (const name of ['passwordHash', 'adSid', 'securityStamp', 'directoryId']) assert.equal(listed.body.data[0][name], undefined);
});

test('employee provision and explicit link require selected code with role/department assignments and CSRF', async t => {
  const { request, login, calls } = await harness(t);
  await login();
  const body = { employeeCode: '001234', roles: ['qa'], department: 'qaTet' };
  assert.equal((await request('/api/admin/users', { method: 'POST', body })).status, 201);
  assert.equal(calls.find(call => call[0] === 'create')[1].displayName, profile.displayName);
  for (const extra of [{ email: 'spoof@test.invalid' }, { displayName: 'spoof' }, { directoryId: 'old-ad' }]) {
    assert.equal((await request('/api/admin/users', { method: 'POST', body: { ...body, ...extra } })).status, 400);
  }
  assert.equal((await request(`/api/admin/users/${USER_ID}/employee`, { method: 'POST', body: { employeeCode: '001234' } })).status, 200);
  assert.equal((await request(`/api/admin/users/${USER_ID}/employee`, { method: 'POST', body: { employeeCode: '001234', roles: ['admin'] } })).status, 400);
  assert.equal((await request('/api/admin/users', { method: 'POST', csrf: false, body })).status, 403);
  assert.equal((await request('/api/admin/users/invalid/employee', { method: 'POST', body: { employeeCode: '001234' } })).status, 400);
});

test('employee routes require administrator access and configured source', async t => {
  const user = await harness(t, { roles: ['supplier'] });
  await user.login();
  assert.equal((await user.request('/api/admin/users')).status, 403);
  assert.equal((await user.request('/api/admin/employees?query=001')).status, 403);
  const unavailable = await harness(t, { directory: false });
  assert.equal((await unavailable.request('/api/auth/config')).body.data.employeeProvisioningConfigured, false);
  assert.equal((await unavailable.login()).status, 503);
});

test('source outages fail closed for sessions while logout keeps CSRF protection and revokes session', async t => {
  const { request, login, state } = await harness(t);
  await login();
  state.outage = true;
  assert.equal((await request('/api/session')).status, 503);
  assert.equal((await request('/api/master-data')).status, 503);
  assert.equal((await request('/api/auth/logout', { method: 'POST', body: {}, csrf: false })).status, 403);
  assert.equal((await request('/api/auth/logout', { method: 'POST', body: {}, origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await request('/api/auth/logout', { method: 'POST', body: {} })).status, 200);
  assert.ok(state.sessions[0].revokedAt);
  state.outage = false;
  assert.deepEqual((await request('/api/session')).body.data, { authenticated: false });
});

test('disabled employee sessions lose API access without AD header checks', async t => {
  const { request, login, state } = await harness(t);
  await login();
  state.user = { ...state.user, isActive: false };
  assert.equal((await request('/api/master-data')).status, 401);
  assert.deepEqual((await request('/api/session')).body.data, { authenticated: false });
});
