const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../src/authService');
const { ApiError } = require('../src/apiError');
const { createApp } = require('../src/httpServer');
const { memoryRepository } = require('./helpers/apiHarness');
const ADMIN = '87654321-4321-4321-4321-cba987654321';
const TARGET = '12345678-1234-1234-1234-123456789abc';
const VERSION = '0011223344556677';
const REMOVAL = `/api/admin/users/${TARGET}/roles`;
async function harness(t, { adminRoles = ['admin'], provider = 'pcn-local', active = true } = {}) {
  const state = { outage: false, sessions: [], calls: [], users: [
    { id: ADMIN, employeeCode: '0000001', normalizedEmployeeCode: '0000001', username: '0000001', displayName: 'Administrator',
      identityProvider: 'pcn-local', roles: adminRoles, department: 'it', isActive: true, securityStamp: 'admin-stamp', version: VERSION },
    { id: TARGET, employeeCode: '0000002', normalizedEmployeeCode: '0000002', username: '0000002', displayName: 'Employee Name',
      identityProvider: provider, roles: ['qa'], department: 'qaTet', signingStep: 'checked', isActive: active,
      securityStamp: 'target-stamp', version: VERSION, email: 'employee@example.com', mailDirectoryId: 'mail-id',
      mailVerifiedAt: '2026-10-12T00:00:00.000Z', mailProfile: { id: 'mail-id', email: 'employee@example.com', displayName: 'Directory Name' } }
  ] };
  const employeeDirectory = { async getByCode(code) {
    state.calls.push(['lookup', code]);
    if (state.outage) throw new Error('private SQL details');
    return { employeeCode: code, displayName: 'Source Employee', isActive: true };
  } };
  const repository = {
    async getUserByEmployeeCode(code) { return state.users.find(user => user.normalizedEmployeeCode === code); },
    async getUserById(id) { return state.users.find(user => user.id === id); },
    async getSession(hash) { return state.sessions.find(session => session.tokenHash === hash); },
    async saveSession(session) { state.sessions = [...state.sessions, session]; },
    async revokeSession(hash) { state.sessions = state.sessions.map(session => session.tokenHash === hash ? { ...session, revokedAt: new Date() } : session); },
    async removeEmployeeRoles(id, account, actor, user) {
      state.calls.push(['remove', id, account, actor, user.id]);
      const prior = state.users.find(entry => entry.id === id);
      if (!prior) throw new ApiError(404, 'User not found');
      if (prior.version !== account.version) throw new ApiError(409, 'Account changed');
      if (!prior.roles.length) throw new ApiError(409, 'This user has no assigned roles');
      if (prior.roles.includes('admin') && state.users.filter(entry => entry.isActive && entry.roles.includes('admin')).length === 1) {
        throw new ApiError(409, 'Keep at least one active administrator');
      }
      const updated = { ...prior, roles: [], department: null, signingStep: null, securityStamp: 'roles-removed', version: '8899aabbccddeeff' };
      state.users = state.users.map(entry => entry.id === id ? updated : entry);
      state.sessions = state.sessions.map(session => session.userId === id ? { ...session, revokedAt: new Date() } : session);
      return updated;
    }
  };
  const authService = new AuthService(repository, { authMode: 'employee-code', employeeDirectory });
  const pcnRepository = memoryRepository();
  const app = createApp({ repository: pcnRepository, authService, employeeDirectory, authMode: 'employee-code',
    publicOrigin: 'http://localhost', secureCookies: false });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const admin = await authService.login({ employeeCode: '0000001' });
  async function request(route = REMOVAL, { method = 'DELETE', body = { version: VERSION }, session = admin,
    csrf = true, origin = 'http://localhost' } = {}) {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${route}`, { method,
      headers: { origin, 'content-type': 'application/json', ...(session ? { cookie: `pcn_session=${session.token}` } : {}),
        ...(csrf && session ? { 'x-csrf-token': session.csrfToken } : {}) },
      ...(!['GET', 'HEAD'].includes(method) ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, payload: await response.json() };
  }
  return { state, repository, authService, pcnRepository, request, admin };
}
for (const provider of ['pcn-local', 'employee-code']) test(`${provider} role removal clears grants, preserves identity and invalidates old sessions`, async t => {
  const { request, state, authService, pcnRepository } = await harness(t, { provider });
  const employee = await authService.login({ employeeCode: '0000002' });
  const before = state.users[1];
  const result = await request(); assert.equal(result.status, 200);
  assert.deepEqual(result.payload.data.roles, []); assert.equal(result.payload.data.department, null);
  assert.equal(result.payload.data.signingStep, null); assert.equal(result.payload.data.version, '8899aabbccddeeff');
  assert.equal(result.payload.data.mustChangePassword, false);
  for (const field of ['id', 'employeeCode', 'displayName', 'identityProvider', 'isActive', 'email', 'mailProfile']) {
    assert.deepEqual(result.payload.data[field], before[field]);
  }
  for (const field of ['securityStamp', 'normalizedEmployeeCode', 'mailVerifiedAt', 'mailDirectoryId']) assert.equal(result.payload.data[field], undefined);
  assert.equal(state.users.length, 2); assert.equal(state.users[1].mailDirectoryId, before.mailDirectoryId);
  assert.deepEqual(state.calls.find(call => call[0] === 'remove'), ['remove', TARGET, { version: VERSION }, `user:${ADMIN}`, ADMIN]);
  assert.equal(await authService.session(employee.token), null);
  const expired = await request('/api/session', { method: 'GET', session: employee });
  assert.deepEqual(expired.payload.data, { authenticated: false });
  const signedIn = await authService.login({ employeeCode: '0000002' }); assert.deepEqual(signedIn.user.roles, []);
  const record = await pcnRepository.create({ createdAt: '2026-10-12T00:00:00.000Z', ownerUserId: 'another-user',
    status: 'submitted', riskLevel: 'RL2', supplierName: 'Supplier', materialName: 'Material', internalReview: {} });
  assert.equal((await request('/api/pcns', { method: 'GET', session: signedIn })).status, 200);
  assert.equal((await request(`/api/pcns/${record.id}`, { method: 'GET', session: signedIn })).status, 200);
  assert.equal((await request('/api/pcns', { method: 'POST', body: {}, session: signedIn })).status, 403);
  assert.equal((await request(`/api/pcns/${record.id}`, { method: 'PATCH', body: { version: record.version }, session: signedIn })).status, 403);
  assert.equal((await request(REMOVAL, { session: signedIn, body: { version: signedIn.user.version } })).status, 403);
  assert.equal((await request('/api/auth/logout', { method: 'POST', body: {}, session: signedIn })).status, 200);
  assert.equal(await authService.session(signedIn.token), null);
});
test('role removal requires an active administrator and valid origin and CSRF', async t => {
  const admin = await harness(t);
  assert.equal((await admin.request(REMOVAL, { session: null })).status, 401);
  assert.equal((await admin.request(REMOVAL, { csrf: false })).status, 403);
  assert.equal((await admin.request(REMOVAL, { origin: 'https://evil.invalid' })).status, 403);
  assert.equal(admin.state.calls.some(call => call[0] === 'remove'), false);
  for (const adminRoles of [['reviewer'], []]) {
    const unauthorized = await harness(t, { adminRoles }); assert.equal((await unauthorized.request()).status, 403);
    assert.equal(unauthorized.state.calls.some(call => call[0] === 'remove'), false);
  }
  admin.state.users = admin.state.users.map(user => user.id === ADMIN ? { ...user, isActive: false } : user);
  assert.equal((await admin.request()).status, 401);
});
test('role removal validates user UUID, exact version body and supported method before persistence', async t => {
  const { request, state } = await harness(t);
  assert.equal((await request('/api/admin/users/invalid/roles')).status, 400);
  for (const body of [{}, { version: null }, { version: '1234' }, { version: 1234 }, { version: `${VERSION} ` },
    { version: VERSION, roles: [] }, { version: VERSION, isActive: false }, { version: VERSION, identityProvider: 'password' },
    { version: VERSION, employeeCode: '0000003' }, { version: VERSION, userId: ADMIN }]) {
    assert.equal((await request(REMOVAL, { body })).status, 400);
  }
  for (const method of ['GET', 'POST', 'PATCH', 'PUT']) assert.equal((await request(REMOVAL, { method })).status, 404);
  assert.equal(state.calls.some(call => call[0] === 'remove'), false);
});
test('role removal rejects stale versions, missing users and removing the last administrator', async t => {
  const { request, state } = await harness(t);
  assert.equal((await request(REMOVAL, { body: { version: 'aabbccddeeff0011' } })).status, 409);
  assert.equal(state.users[1].roles.length, 1);
  assert.equal((await request(`/api/admin/users/${ADMIN}/roles`)).status, 409);
  assert.deepEqual(state.users[0].roles, ['admin']);
  assert.equal((await request('/api/admin/users/12345678-1234-1234-1234-123456789abd/roles')).status, 404);
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 409);
  assert.equal((await request(REMOVAL, { body: { version: state.users[1].version } })).status, 409);
});
test('role removal preserves disabled status and performs no target source lookup', async t => {
  for (const provider of ['employee-code', 'pcn-local']) {
    const { request, state } = await harness(t, { provider, active: false }); state.outage = true;
    const result = await request(); assert.equal(result.status, 200);
    assert.equal(result.payload.data.isActive, false); assert.equal(result.payload.data.identityProvider, provider);
    assert.deepEqual(result.payload.data.roles, []); assert.equal(state.calls.some(call => call[0] === 'lookup'), false);
  }
});
test('role removal preserves legacy providers without granting employee-code sign-in', async t => {
  for (const provider of ['password', 'retired-windows']) {
    const { request, state, authService } = await harness(t, { provider });
    const result = await request(); assert.equal(result.status, 200);
    assert.equal(result.payload.data.identityProvider, provider); assert.equal(result.payload.data.isActive, true);
    assert.deepEqual(result.payload.data.roles, []);
    await assert.rejects(authService.login({ employeeCode: '0000002' }), { statusCode: 401 });
    assert.equal(state.calls.some(call => call[0] === 'lookup'), false);
  }
});
test('administrator can remove their own roles when another active administrator remains', async t => {
  const { request, state, authService, admin } = await harness(t);
  state.users = state.users.map(user => user.id === TARGET ? { ...user, roles: ['admin'], department: 'it', signingStep: null } : user);
  const result = await request(`/api/admin/users/${ADMIN}/roles`); assert.equal(result.status, 200);
  assert.deepEqual(result.payload.data.roles, []); assert.equal(await authService.session(admin.token), null);
  const viewer = await authService.login({ employeeCode: '0000001' });
  assert.deepEqual(viewer.user.roles, []);
  assert.equal((await request(REMOVAL, { session: viewer })).status, 403);
  const remainingAdmin = await authService.login({ employeeCode: '0000002' });
  assert.deepEqual(remainingAdmin.user.roles, ['admin']);
});
test('normal account creation and edit still reject empty roles', async t => {
  const { request, state } = await harness(t);
  assert.equal((await request(`/api/admin/users/${TARGET}`, { method: 'PATCH', body: { version: VERSION,
    roles: [], department: 'qaTet', signingStep: null, isActive: true } })).status, 400);
  assert.equal((await request('/api/admin/local-users', { method: 'POST', body: { employeeCode: '0000003',
    displayName: 'New Employee', roles: [], department: 'qaTet', signingStep: null } })).status, 400);
  assert.equal(state.calls.some(call => call[0] === 'remove'), false);
});
test('role removal remains available when an account has no verified work email', async t => {
  const { request, state } = await harness(t);
  state.users = state.users.map(user => user.id === TARGET ? { ...user, email: null, mailDirectoryId: null,
    mailVerifiedAt: null, mailProfile: null, signingStep: null } : user);
  const result = await request(); assert.equal(result.status, 200);
  assert.deepEqual(result.payload.data.roles, []); assert.equal(result.payload.data.mailProfile, null);
  assert.equal(result.payload.data.isActive, true);
});
test('role removal service rejects forged fields and invalid identities without repository calls', async t => {
  const { authService, state } = await harness(t);
  for (const body of [{ userId: 'invalid', version: VERSION }, { userId: TARGET, version: VERSION, roles: [] },
    { userId: TARGET, version: null }, { userId: TARGET, version: VERSION, isActive: false }]) {
    await assert.rejects(authService.removeEmployeeRoles(body), { statusCode: 400 });
  }
  assert.equal(state.calls.some(call => call[0] === 'remove'), false);
});
