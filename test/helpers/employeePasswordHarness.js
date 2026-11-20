const crypto = require('node:crypto');
const { AuthService, hashToken } = require('../../src/authService');
const { ApiError } = require('../../src/apiError');
const passwords = require('../../src/passwords');

const TEST_EMPLOYEE_PASSWORD = 'Abcd1234';
const stamp = () => crypto.randomUUID();

async function createEmployeePasswordFixture(options = {}) {
  const realPasswords = options.realPasswords === true;
  const hash = realPasswords ? passwords.hashPassword : async value => `fixture-hash:${value}`;
  const verify = realPasswords ? passwords.verifyPassword : async (value, supplied) => value === `fixture-hash:${supplied}`;
  const state = { now: options.now ?? Date.now(), users: [], sessions: [], tokens: [], writes: [], lookups: [], outage: false,
    passwordVerifications: [], profileOverrides: new Map() };
  const definitions = [{ id: '11111111-1111-4111-8111-111111111111', employeeCode: options.employeeCode || '0012345',
    identityProvider: options.provider || 'employee-code', roles: options.roles || ['qa'],
    enrolled: options.enrolled === true, ...options.userOverrides }, ...(options.additionalUsers || [])];
  for (const definition of definitions) {
    const { password = TEST_EMPLOYEE_PASSWORD, enrolled = false, ...attributes } = definition;
    const employeeCode = attributes.employeeCode;
    state.users = [...state.users, { username: employeeCode, normalizedEmployeeCode: employeeCode.toLowerCase(),
      displayName: 'Synthetic Employee', roles: [], department: 'qaTet', signingStep: 'prepared',
      isActive: true, securityStamp: stamp(), version: '0000000000000001', failedLoginCount: 0, lockoutUntil: null,
      mustChangePassword: false, passwordHash: enrolled ? await hash(password) : null,
      passwordSetAt: enrolled ? new Date(state.now).toISOString() : null, ...attributes }];
  }
  const patchUser = (id, changes) => {
    state.users = state.users.map(user => user.id === id ? { ...user, ...changes } : user);
    return state.users.find(user => user.id === id);
  };
  const repository = {
    async getUserByEmployeeCode(code) { return state.users.find(user => user.normalizedEmployeeCode === code) || null; },
    async getUserByLogin(login) { return state.users.find(user => user.username.toLowerCase() === login) || null; },
    async getUserById(id) { if (state.onGetUserById) await state.onGetUserById(id); return state.users.find(user => user.id === id) || null; },
    async createEmployeeViewer(profile) {
      if (state.users.some(user => user.normalizedEmployeeCode === profile.employeeCode.toLowerCase())) throw new ApiError(409, 'Account exists');
      const user = { id: stamp(), username: profile.employeeCode, employeeCode: profile.employeeCode,
        normalizedEmployeeCode: profile.employeeCode.toLowerCase(), displayName: profile.displayName, roles: [],
        identityProvider: 'employee-code', department: null, signingStep: null, isActive: true, securityStamp: stamp(),
        version: '0000000000000001', passwordHash: null, passwordSetAt: null, failedLoginCount: 0, lockoutUntil: null };
      state.users = [...state.users, user];
      return user;
    },
    async saveSession(session) { if (state.onSaveSession) await state.onSaveSession(session); state.sessions = [...state.sessions, { ...session }]; },
    async getSession(tokenHash) { return state.sessions.find(session => session.tokenHash === tokenHash) || null; },
    async revokeSession(tokenHash) { state.sessions = state.sessions.map(session => session.tokenHash === tokenHash ? { ...session, revokedAt: new Date(state.now).toISOString() } : session); },
    async recordLoginFailure(id) {
      const user = state.users.find(entry => entry.id === id);
      const expired = user.lockoutUntil && new Date(user.lockoutUntil).getTime() <= state.now;
      const count = expired ? 1 : (user.failedLoginCount || 0) + 1;
      patchUser(id, { failedLoginCount: count, lockoutUntil: count >= 5 ? new Date(state.now + 900000).toISOString() : null });
    },
    async resetLoginFailures(id) { patchUser(id, { failedLoginCount: 0, lockoutUntil: null }); },
    async updateEmployeePassword(id, passwordHash, securityStamp, expectedStamp, { firstSetup }) {
      if (state.onPasswordUpdate) await state.onPasswordUpdate({ id, firstSetup });
      const user = state.users.find(entry => entry.id === id);
      const empty = user?.passwordHash == null && user?.passwordSetAt == null;
      const enrolled = typeof user?.passwordHash === 'string' && Boolean(user.passwordSetAt);
      if (!user?.isActive || !['employee-code', 'pcn-local'].includes(user.identityProvider)
        || user.securityStamp !== expectedStamp || !(firstSetup ? empty : enrolled)) throw new ApiError(409, 'Account changed. Sign in again');
      patchUser(id, { passwordHash, securityStamp, passwordSetAt: user.passwordSetAt || new Date(state.now).toISOString(),
        mustChangePassword: false, failedLoginCount: 0, lockoutUntil: null });
      state.sessions = state.sessions.map(session => session.userId === id ? { ...session, revokedAt: new Date(state.now).toISOString() } : session);
      state.tokens = state.tokens.map(token => token.userId === id ? { ...token, usedAt: new Date(state.now).toISOString() } : token);
      state.writes = [...state.writes, { action: firstSetup ? 'password-setup' : 'password-change', userId: id }];
    }
  };
  const employeeDirectory = {
    async getByCode(code) {
      state.lookups = [...state.lookups, code];
      if (state.onLookup) await state.onLookup(code);
      if (state.outage) throw new Error('Synthetic directory unavailable');
      if (state.profileOverrides.has(code)) return state.profileOverrides.get(code);
      const user = state.users.find(entry => entry.employeeCode === code && entry.identityProvider === 'employee-code');
      return user ? { employeeCode: code, displayName: user.displayName, isActive: true } : null;
    }
  };
  const service = new AuthService(repository, { authMode: options.authMode || 'employee-password', employeeDirectory,
    clock: () => new Date(state.now), passwordHasher: hash,
    passwordVerifier: async (value, supplied) => {
      state.passwordVerifications = [...state.passwordVerifications, { suppliedLength: typeof supplied === 'string' ? supplied.length : null }];
      if (state.onVerify) await state.onVerify();
      return verify(value, supplied);
    } });
  async function seedSession(userId = state.users[0].id, authenticationMethod = 'employee-password', extra = {}) {
    const user = state.users.find(entry => entry.id === userId);
    const token = crypto.randomBytes(32).toString('hex');
    const session = { id: stamp(), userId, tokenHash: hashToken(token), csrfToken: crypto.randomBytes(32).toString('hex'),
      securityStamp: user.securityStamp, expiresAt: new Date(state.now + 3600000).toISOString(),
      ...(authenticationMethod ? { authenticationMethod } : {}), ...extra };
    await repository.saveSession(session);
    return { token, session };
  }
  return { state, repository, employeeDirectory, service, patchUser, seedSession, password: TEST_EMPLOYEE_PASSWORD };
}

module.exports = { createEmployeePasswordFixture, TEST_EMPLOYEE_PASSWORD };
