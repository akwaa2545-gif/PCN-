const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const TEST_PASSWORD = crypto.randomBytes(24).toString('hex');
const TEST_NEW_PASSWORD = crypto.randomBytes(24).toString('hex');
const { AuthService } = require('../src/authService');
const { enforceSameOrigin, enforceCsrf, requirePrincipal, setSessionCookie, clearSessionCookie, readSessionToken } = require('../src/authHttp');

function setup(options = {}) {
  const state = { users: [], sessions: [] };
  const repo = {
    async createUser(user) { const result = { ...user, id: 'user-1', isActive: true, securityStamp: 'stamp', failedLoginCount: 0 }; state.users = [...state.users, result]; return result; },
    async getUserByLogin(login) { return state.users.find(u => u.username.toLowerCase() === login || u.email?.toLowerCase() === login); },
    async getUserById(id) { return state.users.find(u => u.id === id); },
    async saveSession(session) { state.sessions = [...state.sessions, session]; },
    async getSession(hash) { return state.sessions.find(s => s.tokenHash === hash && !s.revokedAt); },
    async revokeSession(hash) { state.sessions = state.sessions.filter(s => s.tokenHash !== hash); },
    async resetLoginFailures() {},
    async recordLoginFailure() {},
    async updatePassword(id, hash, stamp) { state.users = state.users.map(u => u.id === id ? { ...u, passwordHash: hash, securityStamp: stamp, mustChangePassword: false } : u); state.sessions = []; }
  };
  return { state, service: new AuthService(repo, { authMode: 'password', passwordHasher: async p => `hashed:${p}`, passwordVerifier: async (h, p) => h === `hashed:${p}`, ...options }) };
}

test('bootstrap temporary password requires change and hashed session persistence', async () => {
  const { service, state } = setup();
  await service.createUser({ username: 'itadmin', password: 'test', roles: ['admin'], bootstrap: true, mustChangePassword: true });
  const login = await service.login({ username: 'ITADMIN', password: 'test' });
  assert.equal(login.user.email, null);
  assert.equal(login.user.mustChangePassword, true);
  assert.equal(login.user.passwordHash, undefined);
  assert.notEqual(state.sessions[0].tokenHash, login.token);
  assert.throws(() => requirePrincipal(login), /Change your password/);
  assert.equal((await service.session(login.token)).user.username, 'itadmin');
  await service.changePassword(login.token, { currentPassword: 'test', newPassword: TEST_NEW_PASSWORD });
  assert.equal(await service.session(login.token), null);
  assert.equal((await service.login({ username: 'itadmin', password: TEST_NEW_PASSWORD })).user.mustChangePassword, false);
});

test('password validation, generic login failure and logout', async () => {
  const { service } = setup();
  await assert.rejects(service.createUser({ username: 'user', password: '', roles: ['supplier'] }), /password/i);
  await assert.rejects(service.createUser({ username: 'user', password: 'abcd', bootstrap: true, mustChangePassword: false }), /change/);
  await service.createUser({ username: 'user', password: TEST_PASSWORD, roles: ['supplier'] });
  await assert.rejects(service.login({ username: 'missing', password: 'nope' }), /Invalid username or password/);
  await assert.rejects(service.login({ username: 'user', password: 'nope' }), /Invalid username or password/);
  const login = await service.login({ username: 'user', password: TEST_PASSWORD });
  await assert.rejects(service.changePassword(login.token, { currentPassword: 'wrong', newPassword: TEST_NEW_PASSWORD }), /Invalid current password/);
  await service.logout(login.token);
  assert.equal(await service.session(login.token), null);
});

test('short nonempty passwords work for new accounts and password changes', async () => {
  const { service } = setup();
  await service.createUser({username:'short-user',password:'a',roles:['supplier']});
  const login=await service.login({username:'short-user',password:'a'});
  await assert.rejects(service.changePassword(login.token,{currentPassword:'a',newPassword:''}), /password/i);
  await assert.rejects(service.changePassword(login.token,{currentPassword:'a',newPassword:'b'.repeat(129)}), /128/);
  await service.changePassword(login.token,{currentPassword:'a',newPassword:'5678'});
  assert.equal(await service.session(login.token),null);
  assert.equal((await service.login({username:'short-user',password:'5678'})).user.username,'short-user');
});

test('HTTP auth verifies origin, CSRF, roles and secure cookie', () => {
  assert.throws(() => enforceSameOrigin({ headers: {} }, 'https://pcn.example'), /origin/i);
  assert.throws(() => enforceSameOrigin({ headers: { origin: 'https://evil.example' } }, 'https://pcn.example'), /origin/i);
  enforceSameOrigin({ headers: { origin: 'https://pcn.example' } }, 'https://pcn.example');
  assert.throws(() => enforceCsrf({ headers: { 'x-csrf-token': 'wrong' } }, { csrfToken: 'abc' }), /CSRF/);
  assert.throws(() => enforceCsrf({ headers: { 'x-csrf-token': 'ééé' } }, { csrfToken: 'abc' }), /CSRF/);
  enforceCsrf({ headers: { 'x-csrf-token': 'abc' } }, { csrfToken: 'abc' });
  assert.throws(() => requirePrincipal({ user: { roles: ['supplier'] } }, { roles: ['admin'] }), /permission/);
  const headers = {};
  setSessionCookie({ setHeader(k, v) { headers[k] = v; } }, { token: 'abc', expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.match(headers['Set-Cookie'], /HttpOnly; SameSite=Strict; Secure/);
  assert.equal(readSessionToken({ headers: { cookie: 'other=x; pcn_session=abc' } }), 'abc');
  assert.equal(readSessionToken({ headers: {} }), null);
  clearSessionCookie({ setHeader(k, v) { headers[k] = v; } }, { secure: false });
  assert.match(headers['Set-Cookie'], /Max-Age=0/);
  assert.doesNotMatch(headers['Set-Cookie'], /; Secure/);
  assert.throws(() => requirePrincipal(null), /Sign in/);
  assert.equal(requirePrincipal({ user: { id: 'one', roles: ['admin'] } }, { roles: ['admin'] }).id, 'one');
});

test('expired, disabled and changed-stamp sessions are rejected', async () => {
  let now = new Date('2026-01-01T00:00:00Z');
  const { service, state } = setup({ clock: () => now });
  await service.createUser({ username: 'user', password: TEST_PASSWORD });
  const login = await service.login({ username: 'user', password: TEST_PASSWORD });
  state.users = state.users.map(u => ({ ...u, isActive: false }));
  assert.equal(await service.session(login.token), null);
  state.users = state.users.map(u => ({ ...u, isActive: true, securityStamp: 'different' }));
  assert.equal(await service.session(login.token), null);
  state.users = state.users.map(u => ({ ...u, securityStamp: 'stamp' }));
  now = new Date('2026-01-02T00:00:00Z');
  assert.equal(await service.session(login.token), null);
  assert.equal(await service.session('bad-token'), null);
});

test('login lockout and per-address throttling reject authentication', async () => {
  const { service, state } = setup();
  await service.createUser({ username: 'user', password: TEST_PASSWORD });
  state.users = state.users.map(u => ({ ...u, lockoutUntil: new Date(Date.now() + 600000) }));
  await assert.rejects(service.login({ username: 'user', password: TEST_PASSWORD }), /Invalid username or password/);
  for (let i = 0; i < 15; i++) await assert.rejects(service.login({ username: 'missing', password: 'wrong' }, { ip: 'one-address' }), /Invalid username or password/);
  await assert.rejects(service.login({ username: 'missing', password: 'wrong' }, { ip: 'one-address' }), error => error.statusCode === 429);
});

test('Argon2id stores salted hashes and verifies passwords', async () => {
  const { hashPassword, verifyPassword } = require('../src/passwords');
  const hash = await hashPassword('example-password-123');
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(hash, 'example-password-123'), true);
  assert.equal(await verifyPassword(hash, 'wrong'), false);
});
