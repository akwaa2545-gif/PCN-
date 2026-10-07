const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../src/authService');

const directoryId = '11111111-2222-3333-4444-555555555555';
const person = { directoryId, adSid: 'S-1-5-21-123-456-789-1001', samAccountName: '0012345', employeeCode: '0012345', displayName: 'Example Employee', email: 'employee@example.com', adDepartment: 'Information Technology', isActive: true };
const identity = { domain: 'KEMET', samAccountName: person.samAccountName };
function setup() {
  const state = { users: [], sessions: [], person };
  const repository = {
    async createEmployeeUser(fields) {
      const user = { ...fields, id: 'user-one', username: fields.employeeCode, directoryId: fields.adObjectGuid, identityProvider: 'windows', passwordHash: null, mustChangePassword: false, isActive: true, securityStamp: 'stamp' };
      state.users = [...state.users, user]; return user;
    },
    async getUserByAdObjectGuid(id) { return state.users.find(user => user.directoryId === id); },
    async getUserById(id) { return state.users.find(user => user.id === id); },
    async saveSession(session) { state.sessions = [...state.sessions, session]; },
    async getSession(hash) { return state.sessions.find(session => session.tokenHash === hash); },
    async resetLoginFailures() {},
    async linkEmployeeIdentity(userId, profile) {
      state.users = state.users.map(user => user.id === userId ? { ...user, directoryId: profile.directoryId, adSid: profile.adSid, employeeCode: profile.employeeCode, username: profile.employeeCode, identityProvider: 'windows', mustChangePassword: false, securityStamp: 'new-stamp' } : user);
      return this.getUserById(userId);
    }
  };
  const directoryService = { async getById(id) { return state.person?.directoryId === id ? state.person : null; }, async getBySamAccountName(code) { return state.person?.samAccountName.toLowerCase() === code.toLowerCase() ? state.person : null; } };
  return { state, service: new AuthService(repository, { authMode: 'windows', windowsDomain: 'KEMET', directoryService }) };
}

test('employee provision resolves directory-owned fields, preserves code and requires valid roles/department', async () => {
  const { state, service } = setup();
  const user = await service.createEmployee({ directoryId, roles: ['admin'], department: 'it', employeeCode: 'forged' });
  assert.equal(user.employeeCode, '0012345');
  assert.equal(user.username, '0012345');
  assert.equal(user.adSid, undefined);
  assert.equal(state.users[0].passwordHash, null);
  await assert.rejects(service.createEmployee({ directoryId, roles: ['bad'], department: 'it' }), /roles/i);
  await assert.rejects(service.createEmployee({ directoryId, roles: ['admin'], department: 'forged' }), /department/i);
  state.person = null;
  await assert.rejects(service.createEmployee({ directoryId, roles: ['admin'], department: 'it' }), /employee/i);
});

test('Windows login requires provisioned active immutable directory identity and denies passwords', async () => {
  const { state, service } = setup();
  await assert.rejects(service.login({ username: person.employeeCode }), /Windows/i);
  await assert.rejects(service.loginWindows(identity), /access|provisioned/i);
  await service.createEmployee({ directoryId, roles: ['reviewer'], department: 'qaTet' });
  const login = await service.loginWindows(identity);
  assert.equal(login.user.employeeCode, '0012345');
  assert.equal(login.user.mustChangePassword, false);
  assert.equal(state.sessions.length, 1);
  assert.notEqual(state.sessions[0].tokenHash, login.token);
  await assert.rejects(service.loginWindows({ ...identity, domain: 'OTHER' }), /Windows/i);
  state.users = state.users.map(user => ({ ...user, adSid: 'S-1-5-99' }));
  await assert.rejects(service.loginWindows(identity), /access|provisioned/i);
});

test('every Windows principal rejects wrong browser user, disabled/reassigned/renamed AD and legacy cookies', async () => {
  const { state, service } = setup();
  await service.createEmployee({ directoryId, roles: ['admin'], department: 'it' });
  const login = await service.loginWindows(identity);
  const principal = await service.session(login.token);
  await service.validateWindowsPrincipal(principal, identity);
  await assert.rejects(service.validateWindowsPrincipal(principal, { ...identity, samAccountName: 'other' }), /Windows/i);
  for (const changed of [null, { ...person, isActive: false }, { ...person, directoryId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, { ...person, adSid: 'S-1-5-99' }, { ...person, samAccountName: 'renamed' }]) {
    state.person = changed;
    await assert.rejects(service.validateWindowsPrincipal(principal, identity), /Windows/i);
  }
  state.person = person;
  state.users = state.users.map(user => ({ ...user, directoryId: null, identityProvider: 'password' }));
  await assert.rejects(service.validateWindowsPrincipal(principal, identity), /Windows/i);
});

test('explicit directory linking preserves existing user ID and roles and invalidates prior session', async () => {
  const { state, service } = setup();
  state.users = [{ id: 'old-user', username: 'old-admin', roles: ['admin'], isActive: true, securityStamp: 'stamp', mustChangePassword: true }];
  const linked = await service.linkEmployee({ userId: 'old-user', directoryId });
  assert.equal(linked.id, 'old-user');
  assert.deepEqual(linked.roles, ['admin']);
  assert.equal(linked.employeeCode, '0012345');
  assert.equal(state.users[0].securityStamp, 'new-stamp');
});

test('password-mode administrator linking is blocked until Windows sign-in is enabled', async () => {
  const { state, service } = setup();
  state.users = [{ id: 'old-user', username: 'old-admin', roles: ['admin'], isActive: true, securityStamp: 'stamp', mustChangePassword: false }];
  service.authMode = 'password';
  await assert.rejects(service.linkEmployee({ userId: 'old-user', directoryId }), error => error.statusCode === 400 && /Enable Windows sign-in before linking an existing administrator/.test(error.message));
  assert.equal(state.users[0].directoryId, undefined);
  assert.equal(state.users[0].securityStamp, 'stamp');
  const staged = await service.createEmployee({ directoryId, roles: ['admin'], department: 'it' });
  assert.equal(staged.employeeCode, person.samAccountName);
  service.authMode = 'windows';
  const linked = await service.linkEmployee({ userId: 'old-user', directoryId });
  assert.equal(linked.id, 'old-user');
});

test('Windows request rechecks revoked sessions and changed authority after AD lookup', async () => {
  const { state, service } = setup();
  await service.createEmployee({ directoryId, roles: ['admin'], department: 'it' });
  const login = await service.loginWindows(identity);
  const principal = await service.session(login.token);
  assert.equal(JSON.stringify(principal).includes('sessionTokenHash'), false);
  assert.equal(JSON.stringify(principal).includes('sessionSecurityStamp'), false);
  state.users = state.users.map(user => ({ ...user, roles: ['reviewer'] }));
  assert.deepEqual((await service.validateWindowsPrincipal(principal, identity)).user.roles, ['reviewer']);
  state.users = state.users.map(user => ({ ...user, securityStamp: 'new-stamp' }));
  await assert.rejects(service.validateWindowsPrincipal(principal, identity), /Windows/i);
  state.users = state.users.map(user => ({ ...user, securityStamp: 'stamp' }));
  state.sessions = state.sessions.map(session => ({ ...session, revokedAt: new Date().toISOString() }));
  await assert.rejects(service.validateWindowsPrincipal(principal, identity), /Windows/i);
});

test('linked accounts cannot use a preserved local password even before Windows mode is enabled', async () => {
  const { state, service } = setup();
  await service.createEmployee({ directoryId, roles: ['admin'], department: 'it' });
  const login = await service.loginWindows(identity);
  service.authMode = 'password';
  service.repository.getUserByLogin = async () => ({ ...state.users[0], passwordHash: 'preserved-hash' });
  service.hashPassword = async () => 'dummy-hash';
  service.verifyPassword = async () => true;
  service.repository.recordLoginFailure = async () => {};
  const previousPassword = ['old', 'password'].join('-');
  await assert.rejects(service.login({ username: person.employeeCode, password: previousPassword }), /Invalid username or password/);
  await assert.rejects(service.changePassword(login.token, { currentPassword: 'old-password', newPassword: 'new-password' }), /Sign in required/);
});

test('Windows sessions are invalid when authentication is rolled back to password mode', async () => {
  const { service } = setup();
  await service.createEmployee({ directoryId, roles: ['admin'], department: 'it' });
  const login = await service.loginWindows(identity);
  assert.ok(await service.session(login.token));
  service.authMode = 'password';
  assert.equal(await service.session(login.token), null);
});
