const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../src/authService');
const person = Object.freeze({ employeeCode: '001234', displayName: 'Employee Name', email: null,
  sourceDepartment: 'IT', jobTitle: 'Engineer', isActive: true });

function fixture() {
  const state = { person, user: { id: 'user-1', username: '001234', employeeCode: '001234',
    normalizedEmployeeCode: '001234', identityProvider: 'employee-code', displayName: 'Employee Name',
    roles: ['qa'], department: 'qaTet', isActive: true, securityStamp: 'stamp' },
  sessions: [], lookups: [], outage: false };
  const employeeDirectory = {
    async getByCode(code) {
      state.lookups.push(code);
      if (state.onLookup) await state.onLookup();
      if (state.outage) throw new Error('private SQL connection');
      return state.person && state.person.employeeCode.toLowerCase() === code.toLowerCase() ? state.person : null;
    }
  };
  const repository = {
    async getUserByEmployeeCode(code) { return state.user?.employeeCode?.toLowerCase() === code.toLowerCase() ? state.user : null; },
    async getUserById() { return state.user; },
    async saveSession(session) { state.sessions = [...state.sessions, session]; },
    async getSession(hash) { return state.sessions.find(session => session.tokenHash === hash); },
    async revokeSession(hash) {
      state.sessions = state.sessions.map(session => session.tokenHash === hash ? { ...session, revokedAt: new Date() } : session);
    },
    async createEmployeeUser(account) { state.created = account; return { ...state.user, ...account }; },
    async linkEmployeeIdentity(id, profile) { state.linked = { id, profile }; return { ...state.user, ...profile }; }
  };
  return { state, service: new AuthService(repository, { authMode: 'employee-code', employeeDirectory }) };
}

test('password maintenance cannot convert its administrator and lose recovery access', async () => {
  const { state, service } = fixture();
  service.authMode = 'password';
  state.user = { ...state.user, identityProvider: 'password', roles: ['admin'] };
  await assert.rejects(service.linkEmployee({ userId: 'user-1', employeeCode: '001234' }), { statusCode: 409 });
  assert.equal(state.linked, undefined);
  assert.deepEqual(state.lookups, []);
});

test('employee code sign-in preserves leading zeros and uses provisioned PCN grants', async () => {
  const { state, service } = fixture();
  const login = await service.login({ employeeCode: ' 001234 ', remember: true });
  assert.equal(login.user.employeeCode, '001234');
  assert.deepEqual(login.user.roles, ['qa']);
  assert.equal(login.user.identityProvider, 'employee-code');
  assert.equal(login.user.mustChangePassword, false);
  assert.equal(login.user.passwordHash, undefined);
  assert.notEqual(state.sessions[0].tokenHash, login.token);
  assert.equal(state.lookups[0], '001234');
  assert.equal((await service.session(login.token)).user.id, 'user-1');
});

test('unknown, unassigned, disabled and retired identities cannot sign in or self-create', async () => {
  const patches = [{ person: null }, { user: null }, { user: { isActive: false } },
    { user: { identityProvider: 'password' } }, { user: { identityProvider: 'retired-windows' } },
    { user: { employeeCode: '1234' } }, { user: { normalizedEmployeeCode: '1234' } },
    { user: { employeeCode: 'invalid\\code' } }];
  for (const patch of patches) {
    const { state, service } = fixture();
    Object.assign(state, patch.user ? { user: { ...state.user, ...patch.user } } : patch);
    await assert.rejects(service.login({ employeeCode: '001234' }), error => [401, 403].includes(error.statusCode));
    assert.equal(state.sessions.length, 0);
    assert.equal(state.created, undefined);
  }
});

test('source outage fails closed with safe 503 and no session issued', async () => {
  const { state, service } = fixture();
  state.outage = true;
  await assert.rejects(service.login({ employeeCode: '001234' }), error => error.statusCode === 503 && !error.message.includes('private'));
  assert.equal(state.sessions.length, 0);
});

test('employee session revalidates source membership, provider, active state, stamp and code', async () => {
  const updates = [state => { state.person = null; },
    state => { state.user = { ...state.user, identityProvider: 'password' }; },
    state => { state.user = { ...state.user, isActive: false }; },
    state => { state.user = { ...state.user, securityStamp: 'new' }; },
    state => { state.user = { ...state.user, employeeCode: '1234' }; },
    state => { state.user = { ...state.user, normalizedEmployeeCode: 'wrong' }; },
    state => { state.user = { ...state.user, employeeCode: null }; }];
  for (const update of updates) {
    const { state, service } = fixture();
    const login = await service.login({ employeeCode: '001234' });
    update(state);
    assert.equal(await service.session(login.token), null);
  }
  const { state, service } = fixture();
  const login = await service.login({ employeeCode: '001234' });
  state.outage = true;
  await assert.rejects(service.session(login.token), { statusCode: 503 });
  assert.ok(await service.session(login.token, { skipEmployeeLookup: true }));
  await service.logout(login.token);
  assert.equal(await service.session(login.token, { skipEmployeeLookup: true }), null);
});

test('employee provisioning validates assignments and only copies re-resolved SQL profile', async () => {
  const { state, service } = fixture();
  await service.createEmployee({ employeeCode: '001234', roles: ['qa', 'qa'], department: 'qaTet' });
  assert.deepEqual(state.created, { employeeCode: '001234', displayName: 'Employee Name', email: null,
    roles: ['qa'], department: 'qaTet' });
  await assert.rejects(service.createEmployee({ employeeCode: '001234', roles: ['superadmin'], department: 'qaTet' }), { statusCode: 400 });
  await assert.rejects(service.createEmployee({ employeeCode: '001234', roles: ['qa'], department: 'unknown' }), { statusCode: 400 });
  await service.linkEmployee({ userId: 'user-1', employeeCode: '001234' });
  assert.equal(state.linked.profile.employeeCode, '001234');
});

test('employee-code mode rejects passwords, identity assertions and privilege fields', async () => {
  const { service } = fixture();
  const bodies = [{ username: '001234', password: 'anything' }, { employeeCode: '001234', roles: ['admin'] },
    { employeeCode: '001234', displayName: 'spoof' }, { employeeCode: '001234', password: 'x' },
    { employeeCode: '001234', remember: 'yes' }, { employeeCode: 1234 }, { employeeCode: 'a'.repeat(11) }];
  for (const body of bodies) await assert.rejects(service.login(body), error => [400, 401].includes(error.statusCode));
  await assert.rejects(service.changePassword('token', {}), { statusCode: 403 });
});

test('employee sign-in retains IP attempt throttling', async () => {
  const { service } = fixture();
  for (let i = 0; i < 15; i++) await assert.rejects(service.login({ employeeCode: 'missing' }, { ip: 'same' }));
  await assert.rejects(service.login({ employeeCode: '001234' }, { ip: 'same' }), { statusCode: 429 });
});

test('session rechecks SQL authority after a delayed employee lookup before authorizing a request', async () => {
  const updates = [state => { state.user = { ...state.user, isActive: false }; },
    state => { state.user = { ...state.user, roles: ['supplier'], securityStamp: 'new-stamp' }; },
    state => { state.user = { ...state.user, identityProvider: 'retired-windows' }; },
    state => { state.user = { ...state.user, employeeCode: '1234', normalizedEmployeeCode: '1234' }; },
    state => { state.sessions = state.sessions.map(session => ({ ...session, revokedAt: new Date() })); },
    state => { state.sessions = state.sessions.map(session => ({ ...session, expiresAt: '2000-01-01T00:00:00Z' })); },
    state => { state.sessions = []; }, state => { state.user = null; }];
  for (const update of updates) {
    const { state, service } = fixture();
    const login = await service.login({ employeeCode: '001234' });
    state.onLookup = () => update(state);
    assert.equal(await service.session(login.token), null, 'the pre-lookup principal must never authorize a concurrently revoked grant');
  }
  const { state, service } = fixture();
  const login = await service.login({ employeeCode: '001234' });
  state.onLookup = () => { state.user = { ...state.user, roles: ['supplier'] }; };
  assert.deepEqual((await service.session(login.token)).user.roles, ['supplier'], 'response must contain the fresh SQL grants');
});
