const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/httpServer');
const { ApiError } = require('../src/apiError');
const { AuthService } = require('../src/authService');
const { memoryRepository } = require('./helpers/apiHarness');

const GUID = '12345678-1234-1234-1234-123456789abc';
const USER_ID = '87654321-4321-4321-4321-cba987654321';
const profile = { directoryId: GUID, samAccountName: '001234', employeeCode: '001234', displayName: 'Test Employee', email: null, adDepartment: 'Information Technology', adSid: 'S-1-5-21-1234', isActive: true };

async function harness(t, { mode = 'password', roles = ['admin'], directory = true, refreshedRoles = roles, realAuth = false } = {}) {
  const calls = [];
  const state = { offline: false, sessions: [] };
  let cookie = 'pcn_session=test-token';
  let csrfToken = 'test-csrf';
  const key = crypto.randomBytes(32).toString('hex');
  const user = { id: USER_ID, username: '001234', employeeCode: '001234', roles, isActive: true, directoryId: GUID, adSid: profile.adSid, securityStamp: 'test-stamp' };
  const principal = { user, csrfToken: 'test-csrf', expiresAt: new Date(Date.now() + 60000).toISOString() };
  const directoryService = directory ? {
    async search(query) { calls.push(['search', query]); return [profile]; },
    async getBySamAccountName(code) { if (state.offline) throw new ApiError(503, 'Directory service is unavailable'); return code === profile.samAccountName ? profile : null; }
  } : undefined;
  const actualRepository = {
    async getUserByAdObjectGuid(guid) { return guid === GUID ? user : null; },
    async getUserById(id) { return id === USER_ID ? user : null; },
    async saveSession(value) { state.sessions = [...state.sessions, value]; },
    async getSession(hash) { return state.sessions.find(value => value.tokenHash === hash); },
    async revokeSession(hash) { state.sessions = state.sessions.map(value => value.tokenHash === hash ? { ...value, revokedAt: new Date().toISOString() } : value); },
    async listUsers() { return [user]; }
  };
  const authService = realAuth ? new AuthService(actualRepository, { authMode: mode, windowsDomain: 'KEMET', directoryService }) : {
    authMode: mode, directoryService,
    repository: { async listUsers() { return [{ ...user, passwordHash: 'private', adSid: profile.adSid, securityStamp: 'private-stamp' }]; } },
    async session(token) { return token === 'test-token' ? principal : null; },
    async validateWindowsPrincipal(value, identity) { calls.push(['verify', identity]); return { ...value, user: { ...value.user, roles: refreshedRoles } }; },
    async loginWindows(identity) { calls.push(['loginWindows', identity]); return { ...principal, token: 'test-token' }; },
    async login() { calls.push(['passwordLogin']); return { ...principal, token: 'test-token' }; },
    async createEmployee(input) { calls.push(['create', input]); return { ...user, ...input }; },
    async linkEmployee(input) { calls.push(['link', input]); return user; },
    async logout(token) { calls.push(['logout', token]); }
  };
  const app = createApp({ repository: memoryRepository(), authService, directoryService, authMode: mode,
    windowsAuth: { mode, domain: 'KEMET', proxyKey: key }, publicOrigin: 'http://localhost', secureCookies: false });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  async function request(route, { method = 'GET', body, session = true, proof = true, csrf = true, origin = 'http://localhost', headers = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${route}`, { method, headers: {
      ...(session ? { cookie } : {}),
      ...(proof ? { 'x-pcn-windows-user': 'KEMET\\001234', 'x-pcn-windows-auth-key': key } : {}),
      ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrfToken } : {}) }), ...headers
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    const payload = text.startsWith('{') ? JSON.parse(text) : undefined;
    if (payload?.data?.csrfToken) csrfToken = payload.data.csrfToken;
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, headers: response.headers, body: payload, text };
  }
  return { request, calls, state, authService };
}

test('public capability endpoint exposes mode and provisioning flag only', async t => {
  const { request } = await harness(t, { mode: 'windows' });
  assert.deepEqual((await request('/api/auth/config', { session: false, proof: false })).body.data, { mode: 'windows', employeeProvisioningConfigured: true });
});
test('Windows sign-in uses proxy identity and rejects browser-asserted code and password fallback', async t => {
  const { request, calls } = await harness(t, { mode: 'windows' });
  const result = await request('/api/auth/windows', { method: 'POST', session: false, body: {} });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /HttpOnly/);
  assert.deepEqual(calls[0], ['loginWindows', { domain: 'KEMET', samAccountName: '001234' }]);
  assert.equal((await request('/api/auth/windows', { method: 'POST', session: false, body: { employeeCode: 'other' } })).status, 400);
  assert.equal((await request('/api/auth/windows', { method: 'POST', session: false, proof: false, body: {} })).status, 401);
  assert.equal((await request('/api/auth/windows', { method: 'POST', origin: 'https://attacker.invalid', body: {} })).status, 403);
  for (const route of ['/api/auth/login', '/api/admin/login', '/api/auth/change-password']) assert.equal((await request(route, { method: 'POST', body: {} })).status, 403);
  assert.ok(!calls.some(call => call[0] === 'passwordLogin'));
});
test('Windows proof is required for every authenticated session and protected API', async t => {
  const { request } = await harness(t, { mode: 'windows' });
  for (const route of ['/api/session', '/api/admin/users', '/api/master-data']) assert.equal((await request(route, { proof: false })).status, 401);
  assert.equal((await request('/api/session')).body.data.authenticated, true);
  assert.deepEqual((await request('/api/session', { session: false, proof: false })).body.data, { authenticated: false });
});
test('routes use refreshed Windows authority after directory lookup', async t => {
  const { request } = await harness(t, { mode: 'windows', refreshedRoles: ['supplier'] });
  assert.equal((await request('/api/admin/users')).status, 403);
  assert.deepEqual((await request('/api/session')).body.data.user.roles, ['supplier']);
});
test('employee search and user list redact private AD/session/password fields', async t => {
  const { request } = await harness(t);
  const result = await request('/api/admin/employees?query=001');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, [{ directoryId: GUID, employeeCode: '001234', displayName: 'Test Employee', email: null, adDepartment: 'Information Technology' }]);
  const listed = await request('/api/admin/users');
  assert.equal(listed.status, 200);
  for (const name of ['passwordHash', 'adSid', 'securityStamp']) assert.equal(listed.body.data[0][name], undefined);
});
test('employee creation and explicit linking accept selection and PCN assignments only', async t => {
  const { request, calls } = await harness(t);
  const body = { directoryId: GUID, roles: ['qa'], department: 'qaTet' };
  assert.equal((await request('/api/admin/users', { method: 'POST', body })).status, 201);
  assert.deepEqual(calls.find(call => call[0] === 'create'), ['create', body]);
  assert.equal((await request('/api/admin/users', { method: 'POST', body: { ...body, employeeCode: 'spoof' } })).status, 400);
  assert.equal((await request(`/api/admin/users/${USER_ID}/directory`, { method: 'POST', body: { directoryId: GUID } })).status, 200);
  assert.deepEqual(calls.find(call => call[0] === 'link'), ['link', { userId: USER_ID, directoryId: GUID }]);
  assert.equal((await request(`/api/admin/users/${USER_ID}/directory`, { method: 'POST', body: { directoryId: GUID, roles: ['admin'] } })).status, 400);
  assert.equal((await request('/api/admin/users', { method: 'POST', csrf: false, body })).status, 403);
});
test('employee endpoints enforce administrator access and configuration availability', async t => {
  const nonAdmin = await harness(t, { roles: ['supplier'] });
  assert.equal((await nonAdmin.request('/api/admin/employees?query=001')).status, 403);
  assert.equal((await nonAdmin.request('/api/admin/users', { method: 'POST', body: { directoryId: GUID } })).status, 403);
  const disabled = await harness(t, { directory: false });
  assert.equal((await disabled.request('/api/admin/employees?query=001')).status, 503);
  assert.equal((await disabled.request('/api/auth/config')).body.data.employeeProvisioningConfigured, false);
});
test('forged proxy key does not accept a Windows cookie by itself', async t => {
  const { request, calls } = await harness(t, { mode: 'windows' });
  assert.equal((await request('/api/master-data', { headers: { 'x-pcn-windows-auth-key': 'invalid' } })).status, 401);
  assert.equal(calls.length, 0);
});
test('real Windows service signs in through HTTP and refuses directory outage or rollback cookie', async t => {
  const { request, state, authService } = await harness(t, { mode: 'windows', realAuth: true });
  assert.equal((await request('/api/auth/windows', { method: 'POST', session: false, body: {} })).status, 200);
  assert.equal((await request('/api/master-data')).status, 200);
  const session = await request('/api/session');
  assert.equal(session.body.data.user.employeeCode, '001234');
  assert.equal(session.body.data.user.adSid, undefined);
  assert.equal(session.body.data.sessionTokenHash, undefined);
  state.offline = true;
  assert.equal((await request('/api/master-data')).status, 503);
  assert.equal((await request('/api/session')).status, 503);
  state.offline = false;
  authService.authMode = 'password';
  assert.equal((await request('/api/master-data')).status, 401);
  assert.deepEqual((await request('/api/session')).body.data, { authenticated: false });
});
test('employee controller is served as a public static asset without exposing scripts', async t => {
  const { request } = await harness(t);
  assert.equal((await request('/admin-users.js')).status, 200);
  assert.equal((await request('/scripts/ad-directory.ps1')).status, 404);
});
test('Windows logout revokes the SQL session during AD outage while enforcing origin and CSRF', async t => {
  const { request, state } = await harness(t, { mode: 'windows', realAuth: true });
  assert.equal((await request('/api/auth/windows', { method: 'POST', session: false, body: {} })).status, 200);
  state.offline = true;
  assert.equal((await request('/api/auth/logout', { method: 'POST', body: {}, csrf: false })).status, 403);
  assert.equal((await request('/api/auth/logout', { method: 'POST', body: {}, origin: 'https://attacker.invalid' })).status, 403);
  const result = await request('/api/auth/logout', { method: 'POST', body: {}, proof: false });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  assert.ok(state.sessions[0].revokedAt);
  state.offline = false;
  assert.deepEqual((await request('/api/session')).body.data, { authenticated: false });
  assert.equal((await request('/api/auth/windows', { method: 'POST', session: false, body: {} })).status, 200);
  const wrongIdentity = { 'x-pcn-windows-user': 'OTHER\\someone', 'x-pcn-windows-auth-key': 'invalid' };
  assert.equal((await request('/api/master-data', { headers: wrongIdentity })).status, 401);
  assert.equal((await request('/api/admin/logout', { method: 'POST', body: {}, headers: wrongIdentity })).status, 200);
  assert.ok(state.sessions.every(value => value.revokedAt));
});
