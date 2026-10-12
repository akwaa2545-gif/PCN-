const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService, safeUser } = require('../src/authService');
const { ApiError } = require('../src/apiError');
const { createApp } = require('../src/httpServer');
const { memoryRepository } = require('./helpers/apiHarness');
const ADMIN = '87654321-4321-4321-4321-cba987654321';
const LOCAL = '12345678-1234-1234-1234-123456789abc';
const code = '0000123';
const body = () => ({ employeeCode: ` ${code} `, displayName: ' New Employee ', roles: ['qa'], department: 'qaTet', signingStep: null });
function harness({ mode = 'employee-code', roles = ['admin'] } = {}) {
  const state = { outage: false, profiles: [], sessions: [], calls: [], users: [{ id: ADMIN, username: '0012345',
    employeeCode: '0012345', normalizedEmployeeCode: '0012345', identityProvider: 'pcn-local',
    displayName: 'Administrator', roles, department: 'it', isActive: true, securityStamp: 'admin-stamp' }] };
  const directory = { async getByCode(value) {
    state.calls.push(['source', value]);
    if (state.outage) throw new Error('private connection details');
    return state.profiles.find(profile => profile.employeeCode === value) || null;
  } };
  const repository = {
    async getUserByEmployeeCode(value) { return state.users.find(user => user.normalizedEmployeeCode === value); },
    async getUserById(id) { return state.users.find(user => user.id === id); },
    async getUserByLogin(login) { return state.users.find(user => user.username === login); },
    async createLocalEmployeeUser(account) {
      state.calls.push(['create', account]);
      if (state.users.some(user => user.normalizedEmployeeCode === account.employeeCode.toLowerCase())) throw new ApiError(409, 'Employee code is already assigned');
      const user = { ...account, id: LOCAL, username: account.employeeCode, normalizedEmployeeCode: account.employeeCode.toLowerCase(),
        identityProvider: 'pcn-local', isActive: true, securityStamp: 'local-stamp', version: '0011223344556677' };
      state.users = [...state.users, user];
      return user;
    },
    async createEmployeeViewer(profile) {
      const user = { ...profile, id: LOCAL, username: profile.employeeCode, normalizedEmployeeCode: profile.employeeCode.toLowerCase(),
        identityProvider: 'employee-code', roles: [], isActive: true, securityStamp: 'viewer-stamp' };
      state.users = [...state.users, user]; return user;
    },
    async saveSession(session) { state.sessions = [...state.sessions, session]; },
    async getSession(hash) { return state.sessions.find(session => session.tokenHash === hash); },
    async revokeSession(hash) { state.sessions = state.sessions.map(session => session.tokenHash === hash ? { ...session, revokedAt: new Date() } : session); },
    async updateEmployeeAccount(id, account) {
      state.users = state.users.map(user => user.id === id ? { ...user, ...account, securityStamp: 'updated' } : user);
      return state.users.find(user => user.id === id);
    },
    async linkEmployeeIdentity(id, profile) {
      state.users = state.users.map(user => user.id === id ? { ...user, employeeCode: profile.employeeCode,
        normalizedEmployeeCode: profile.employeeCode.toLowerCase(), displayName: profile.displayName,
        identityProvider: 'employee-code', securityStamp: 'linked' } : user);
      return state.users.find(user => user.id === id);
    },
    async recordLoginFailure() {}, async resetLoginFailures() {}
  };
  const mail = { id: 'mail-user', email: 'employee@example.com', displayName: 'Directory Person' };
  const service = new AuthService(repository, { authMode: mode, employeeDirectory: directory,
    passwordHasher: async value => `hashed:${value}`, passwordVerifier: async (hash, value) => hash === `hashed:${value}`,
    integrationService: { async directory() { return { users: [mail] }; } } });
  return { state, service, repository, directory, mail };
}
const status = expected => error => error.statusCode === expected;
test('manual employee creation normalizes leading-zero identity, redacts secrets and stores selected roles', async () => {
  const { service, state } = harness();
  const user = await service.createLocalEmployee(body());
  assert.equal(user.employeeCode, code); assert.equal(user.displayName, 'New Employee');
  assert.equal(user.identityProvider, 'pcn-local'); assert.deepEqual(user.roles, ['qa']);
  assert.equal(user.mustChangePassword, false);
  for (const field of ['passwordHash', 'securityStamp', 'normalizedEmployeeCode', 'mailVerifiedAt']) assert.equal(user[field], undefined);
  assert.deepEqual(state.calls[0], ['source', code]);
  assert.equal(state.calls[1][1].employeeCode, code);
});
test('manual creation validates exact fields, numeric code, name and assignments before persistence', async () => {
  const { service, state } = harness();
  for (const change of [{ employeeCode: '123456' }, { employeeCode: 1234567 }, { employeeCode: 'AB12345' },
    { displayName: '' }, { displayName: 'x'.repeat(201) }, { displayName: 'Bad\nName' }, { displayName: 3 },
    { roles: [] }, { roles: ['unknown'] }, { department: 'wrong' }, { password: 'x' }, { identityProvider: 'employee-code' },
    { email: 'employee@example.com' }, { signingStep: 'checked' }]) {
    await assert.rejects(service.createLocalEmployee({ ...body(), ...change }), status(400));
  }
  assert.equal(state.calls.some(call => call[0] === 'create'), false);
});
test('manual creation rejects any source match, duplicates and unavailable source without fallback', async () => {
  const { service, state } = harness();
  for (const isActive of [true, false]) {
    state.profiles = [{ employeeCode: code, displayName: 'Existing', isActive }];
    await assert.rejects(service.createLocalEmployee(body()), status(409));
  }
  state.profiles = []; state.outage = true;
  await assert.rejects(service.createLocalEmployee(body()), error => error.statusCode === 503 && !error.message.includes('private'));
  await assert.rejects(service.createLocalEmployee(body(), null), status(503));
  assert.equal(state.calls.some(call => call[0] === 'create'), false);
  state.outage = false; await service.createLocalEmployee(body());
  await assert.rejects(service.createLocalEmployee(body()), status(409));
});
test('manual signing assignments require a server-verified selected email and can be edited', async () => {
  const { service, mail } = harness();
  const assignment = { ...body(), signingStep: 'checked', mailSelection: { id: mail.id, email: mail.email } };
  const user = await service.createLocalEmployee(assignment);
  assert.equal(user.mailProfile.displayName, 'Directory Person');
  assert.equal(user.signingStep, 'checked');
  await assert.rejects(service.createLocalEmployee({ ...assignment, employeeCode: '0000124', mailSelection: { id: 'forged', email: mail.email } }), status(400));
  const updated = await service.updateEmployee({ userId: user.id, roles: ['qa'], department: 'qaTet', signingStep: 'checked',
    isActive: true, version: user.version });
  assert.equal(updated.signingStep, 'checked');
});
test('manual creation refuses malformed absence responses and unavailable mail verification', async () => {
  const { service, state, mail } = harness();
  for (const profile of [undefined, false, [], {}, { employeeCode: '0000124', displayName: 'Different Employee' }]) {
    await assert.rejects(service.createLocalEmployee(body(), { async getByCode() { return profile; } }), status(503));
  }
  service.integrationService = { async directory() { throw new Error('private mail workflow'); } };
  await assert.rejects(service.createLocalEmployee({ ...body(), signingStep: 'checked', mailSelection: { id: mail.id, email: mail.email } }), status(503));
  assert.equal(state.calls.some(call => call[0] === 'create'), false);
});
test('local login and sessions use current PCN identity and grants during source outage or later appearance', async () => {
  const { service, state } = harness(); const created = await service.createLocalEmployee(body());
  state.outage = true; const before = state.calls.length;
  const login = await service.login({ employeeCode: ` ${code} ` });
  assert.equal(login.user.id, created.id); assert.equal(login.user.mustChangePassword, false);
  state.users = state.users.map(user => user.id === LOCAL ? { ...user, roles: ['reviewer'] } : user);
  assert.deepEqual((await service.session(login.token)).user.roles, ['reviewer']);
  assert.equal(state.calls.length, before);
  state.outage = false; state.profiles = [{ employeeCode: code, displayName: 'Source appeared', isActive: true }];
  assert.equal((await service.login({ employeeCode: code })).user.identityProvider, 'pcn-local');
  assert.equal((await service.session(login.token)).user.identityProvider, 'pcn-local');
  assert.equal(state.calls.length, before);
});
test('local sessions reject disable, changed stamp, revocation and provider mismatch', async () => {
  for (const change of [{ isActive: false }, { securityStamp: 'withdrawn' }, { identityProvider: 'password' },
    { normalizedEmployeeCode: 'wrong' }, { employeeCode: 'ABC' }]) {
    const { service, state } = harness(); await service.createLocalEmployee(body()); const login = await service.login({ employeeCode: code });
    state.users = state.users.map(user => user.id === LOCAL ? { ...user, ...change } : user);
    assert.equal(await service.session(login.token), null);
    if (!change.securityStamp) await assert.rejects(service.login({ employeeCode: code }), status(401));
    else assert.equal((await service.login({ employeeCode: code })).user.id, LOCAL);
  }
  const { service } = harness(); await service.createLocalEmployee(body()); const login = await service.login({ employeeCode: code });
  await service.logout(login.token); assert.equal(await service.session(login.token), null);
});
test('local session recheck rejects concurrent account or session withdrawal', async () => {
  for (const withdraw of ['user', 'session']) {
    const { service, repository, state } = harness(); await service.createLocalEmployee(body()); const login = await service.login({ employeeCode: code });
    const original = repository.getSession; let reads = 0;
    repository.getSession = async hash => {
      reads += 1;
      if (reads === 2) {
        if (withdraw === 'user') state.users = state.users.map(user => user.id === LOCAL ? { ...user, isActive: false } : user);
        else state.sessions = state.sessions.map(session => ({ ...session, revokedAt: new Date() }));
      }
      return original(hash);
    };
    assert.equal(await service.session(login.token), null);
  }
});
test('local login rejects account withdrawal while resolving the latest PCN account', async () => {
  for (const change of [{ isActive: false }, { securityStamp: 'changed' }, { identityProvider: 'employee-code' }]) {
    const { service, state, repository } = harness(); await service.createLocalEmployee(body());
    const original = repository.getUserById;
    repository.getUserById = async id => {
      state.users = state.users.map(user => user.id === id ? { ...user, ...change } : user);
      return original(id);
    };
    await assert.rejects(service.login({ employeeCode: code }), status(401));
    assert.equal(state.sessions.length, 0);
  }
});
test('registered non-employee providers cannot switch to employee sign-in during source outage', async () => {
  for (const identityProvider of ['password', 'retired-windows', 'unknown-provider']) {
    const { service, state } = harness(); await service.createLocalEmployee(body());
    state.users = state.users.map(user => user.id === LOCAL ? { ...user, identityProvider } : user); state.outage = true;
    const prior = state.calls.length;
    await assert.rejects(service.login({ employeeCode: code }), status(401));
    assert.equal(state.calls.length, prior); assert.equal(state.sessions.length, 0);
  }
});
test('source employees continue requiring healthy source and unknown employees become viewers', async () => {
  const { service, state } = harness(); state.profiles = [{ employeeCode: code, displayName: 'Source Employee', isActive: true }];
  const login = await service.login({ employeeCode: code }); assert.deepEqual(login.user.roles, []);
  state.outage = true;
  await assert.rejects(service.login({ employeeCode: code }), status(503));
  await assert.rejects(service.session(login.token), status(503));
  state.outage = false; state.profiles = [];
  await assert.rejects(service.login({ employeeCode: code }), status(401));
});
test('source login uses account grants after delayed directory verification', async () => {
  const { service, state, directory } = harness();
  state.profiles = [{ employeeCode: code, displayName: 'Source Employee', isActive: true }];
  await service.login({ employeeCode: code });
  const lookup = directory.getByCode;
  directory.getByCode = async value => {
    state.users = state.users.map(user => user.id === LOCAL ? { ...user, isActive: false } : user);
    return lookup(value);
  };
  await assert.rejects(service.login({ employeeCode: code }), status(401));
  assert.equal(state.sessions.length, 1);
});
test('password mode cannot authenticate local users or accept their employee-mode sessions', async () => {
  const { service, state, repository } = harness(); await service.createLocalEmployee(body()); const login = await service.login({ employeeCode: code });
  state.users = state.users.map(user => user.id === LOCAL ? { ...user, passwordHash: 'hashed:secret' } : user);
  const passwordService = new AuthService(repository, { authMode: 'password', passwordHasher: async value => `hashed:${value}`,
    passwordVerifier: async (hash, value) => hash === `hashed:${value}` });
  await assert.rejects(passwordService.login({ username: code, password: 'secret' }), status(401));
  assert.equal(await passwordService.session(login.token), null);
  assert.equal(safeUser({ ...state.users[1], mustChangePassword: true }).mustChangePassword, false);
});
test('explicit source link preserves local account id and grants and revokes previous source semantics', async () => {
  const { service, state } = harness(); const user = await service.createLocalEmployee(body()); const login = await service.login({ employeeCode: code });
  state.profiles = [{ employeeCode: code, displayName: 'Source Employee', isActive: true }];
  const linked = await service.linkEmployee({ userId: user.id, employeeCode: code });
  assert.equal(linked.id, user.id); assert.deepEqual(linked.roles, user.roles); assert.equal(linked.department, 'qaTet');
  assert.equal(linked.identityProvider, 'employee-code'); assert.equal(await service.session(login.token), null);
  assert.equal((await service.login({ employeeCode: code })).user.id, user.id);
});
async function httpHarness(t, options) {
  const fixture = harness(options);
  const app = createApp({ repository: memoryRepository(), authService: fixture.service, employeeDirectory: fixture.directory,
    authMode: 'employee-code', publicOrigin: 'http://localhost', secureCookies: false });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const login = await fixture.service.login({ employeeCode: '0012345' });
  async function request({ authenticated = true, csrf = true, origin = 'http://localhost', requestBody = body() } = {}) {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/admin/local-users`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...(authenticated ? { cookie: `pcn_session=${login.token}` } : {}),
        ...(csrf ? { 'x-csrf-token': login.csrfToken } : {}) }, body: JSON.stringify(requestBody) });
    return { status: response.status, payload: await response.json() };
  }
  return { ...fixture, request };
}
test('local creation HTTP route requires administrator, same origin and CSRF', async t => {
  const admin = await httpHarness(t);
  assert.equal((await admin.request({ authenticated: false })).status, 401);
  assert.equal((await admin.request({ csrf: false })).status, 403);
  assert.equal((await admin.request({ origin: 'https://evil.invalid' })).status, 403);
  assert.equal(admin.state.calls.some(call => call[0] === 'create'), false);
  const result = await admin.request(); assert.equal(result.status, 201); assert.equal(result.payload.data.identityProvider, 'pcn-local');
  const reviewer = await httpHarness(t, { roles: ['reviewer'] }); assert.equal((await reviewer.request()).status, 403);
});
test('local creation HTTP route rejects forged fields and reports source failure without saving', async t => {
  const { request, state } = await httpHarness(t);
  for (const patch of [{ password: 'ignored' }, { identityProvider: 'employee-code' }, { employeeCode: '12345' },
    { roles: [] }, { displayName: 'Invalid\u0000Name' }]) assert.equal((await request({ requestBody: { ...body(), ...patch } })).status, 400);
  state.outage = true; const unavailable = await request(); assert.equal(unavailable.status, 503);
  assert.equal(JSON.stringify(unavailable.payload).includes('private'), false);
  assert.equal(state.calls.some(call => call[0] === 'create'), false);
});
