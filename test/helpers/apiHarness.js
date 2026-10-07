const path = require('node:path');
const crypto = require('node:crypto');
const { ApiError } = require('../../src/apiError');
const { createApp } = require('../../src/httpServer');
const { NotificationService } = require('../../src/notificationService');
const TEST_PASSWORD = crypto.randomBytes(24).toString('hex');
const TEST_NEW_PASSWORD = crypto.randomBytes(24).toString('hex');
const TEST_ACCESS_VERSION = '0000000000000001';
const TEST_SECURITY_STAMP = '00000000-0000-4000-8000-000000000001';

const validPayload = {
  changeForm: 'rawMaterial', riskLevel: 'RL2',
  selectedChange: 'Change of specification for a raw material that is outside of the current M-Spec',
  supplierName: 'Supplier ไทย', manufacturerName: 'A.C.O. / Zhenjiang KAWACHO', materialName: 'Copper alloy strip',
  desiredStart: 'Lot TEST-001', sampleSubmitted: 'yes', currentCondition: 'Current approved material.',
  newCondition: 'Updated material tolerance.', reason: 'Quality stabilization.', identification: 'Lot suffix -T',
  sampleLocation: 'Pilot line', priceLevel: 'no-change',
  changeRows: [{ risk: 'RL2', text: 'Change of specification for a raw material that is outside of the current M-Spec',
    currentCondition: 'Current approved material.', newCondition: 'Updated material tolerance.' }],
  internalReview: { docs: { hazardousReport: true, greenProcurement: false }, decision: { agreed: true, rejected: false },
    signoff: {
      gscTet: { approved: true, checked: true, prepared: true, approvedDate: '2026-10-05', comment: 'Ready' },
      prodEngTet: { approved: true, checked: true, prepared: true }, qaTet: { approved: true, checked: true, prepared: true }
    }, tapbu: { need: true, noNeed: false, gsc: { approved: true, checked: true, prepared: true }, qa: { approved: true, checked: true, prepared: true } },
    qateFinal: { signoff: { approved: true, checked: true, prepared: true, preparedName: 'QA reviewer' } } }
};
const { internalReview: historicalReview, ...unsignedPayload } = validPayload;

function memoryRepository() {
  let records = {};
  let settings = { groups: [] };
  let counter = 0;
  const version = () => (++counter).toString(16).padStart(16, '0');
  return {
    async list(filters = {}) { return structuredClone(Object.values(records).filter(row => (!filters.status || row.status === filters.status) && (!filters.ownerUserId || row.ownerUserId === filters.ownerUserId))); },
    async findById(id) { return structuredClone(records[id] || null); },
    // Simulate a historical SQL record without creating privileged signatures through HTTP.
    async seedHistoricalReview(id, review) {
      if (!records[id]) throw new Error('Historical fixture requires an existing PCN');
      const seeded = { ...records[id], version: version(), internalReview: { ...structuredClone(review), pcnCode: id } };
      records = { ...records, [id]: seeded };
      return structuredClone(seeded);
    },
    async create(record) {
      const id = `PCN-${record.createdAt.slice(0, 4)}-${String(Object.keys(records).length + 1).padStart(4, '0')}`;
      const created = { ...structuredClone(record), id, version: version(), internalReview: { ...record.internalReview, pcnCode: id } };
      records = { ...records, [id]: created }; return structuredClone(created);
    },
    async update(id, updater, actor, expectedVersion) {
      if (!/^[a-f0-9]{16}$/i.test(expectedVersion || '')) throw new ApiError(400, 'PCN version is required');
      if (!records[id]) return null;
      if (expectedVersion !== records[id].version) throw new ApiError(409, 'PCN has been changed by another user');
      const updated = { ...await updater(structuredClone(records[id])), version: version() };
      records = { ...records, [id]: updated }; return structuredClone(updated);
    },
    async delete(id, actor, expectedVersion) {
      if (!/^[a-f0-9]{16}$/i.test(expectedVersion || '')) throw new ApiError(400, 'PCN version is required');
      if (!records[id]) return false;
      if (expectedVersion !== records[id].version) throw new ApiError(409, 'PCN has been changed by another user');
      const { [id]: deleted, ...remaining } = records; records = remaining; return true;
    },
    async getNotificationSettings() { return structuredClone(settings); },
    async saveNotificationSettings(value) { settings = structuredClone(value); return structuredClone(settings); },
    async getAudit() { return []; },
    async getMasterData() { return { versionId: 1, formDefinitions: {}, statusDefinitions: [] }; },
    async readiness() {}
  };
}

function fakeAuthService({ additionalUsers = [] } = {}) {
  let users = ['admin', 'supplier', 'other', 'temporary'].map(username => ({ id: `${username}-id`, username,
    email: null, roles: username === 'supplier' || username === 'other' ? ['supplier'] : ['admin'],
    isActive: true, version: TEST_ACCESS_VERSION, mustChangePassword: username === 'temporary', password: TEST_PASSWORD }));
  users = [...users, ...additionalUsers.map(user => ({ id: `${user.username}-id`, email: null,
    isActive: true, mustChangePassword: false, password: TEST_PASSWORD, ...structuredClone(user) }))];
  let sessions = {};
  let counter = 0;
  const safeUser = candidate => {
    const { password: omitted, ...safe } = candidate;
    return structuredClone(safe);
  };
  return {
    authMode: 'password',
    repository: { async listUsers() { return users.map(safeUser); } },
    async createUser(input) {
      const created = { ...input, id: `new-${users.length}`, isActive: true };
      users = [...users, created];
      return safeUser(created);
    },
    async login({ username, password }) {
      const user = users.find(candidate => candidate.username === username && candidate.password === password);
      if (!user) throw new ApiError(401, 'Invalid username or password');
      const { password: omitted, ...safe } = user;
      const token = `test-session-${++counter}`;
      const result = { token, user: safe, csrfToken: `test-csrf-${counter}`, expiresAt: new Date(Date.now() + 3600000).toISOString() };
      sessions = { ...sessions, [token]: result }; return structuredClone(result);
    },
    async session(token) {
      if (!sessions[token]) return null;
      const { token: omitted, ...principal } = sessions[token];
      const result = structuredClone(principal);
      Object.defineProperty(result.user, 'sessionSecurityStamp', { value: TEST_SECURITY_STAMP });
      return result;
    },
    async logout(token) { const { [token]: removed, ...remaining } = sessions; sessions = remaining; },
    async changePassword(token, input) {
      const session = sessions[token];
      const user = users.find(candidate => candidate.id === session?.user.id);
      if (!user || input.currentPassword !== user.password) throw new ApiError(400, 'Invalid current password');
      users = users.map(candidate => candidate.id === user.id ? { ...candidate, password: input.newPassword, mustChangePassword: false } : candidate);
      sessions = Object.fromEntries(Object.entries(sessions).filter(([key, value]) => value.user.id !== user.id));
    }
  };
}

async function startApi(t, overrides = {}) {
  const repository = memoryRepository();
  const messages = [];
  const notificationPool = { transaction() {
    return { async begin() {}, async commit() {}, async rollback() {}, request() {
      return { input() { return this; }, async query(statement) {
        if (statement.includes('sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
        if (statement.includes('SELECT IsActive,SecurityStamp,AccessVersion')) return { recordset: [{ IsActive: true, SecurityStamp: TEST_SECURITY_STAMP, AccessVersion: Buffer.from(TEST_ACCESS_VERSION, 'hex') }] };
        if (statement.includes('SELECT SettingsJson')) return { recordset: [{ SettingsJson: JSON.stringify(await repository.getNotificationSettings()) }] };
        messages.push('job-write'); throw new Error('Unexpected outbox write');
      } };
    } };
  } };
  const notificationService = new NotificationService(notificationPool,
    { repository, publicOrigin: 'http://localhost', mailUrl: 'https://mail.example.test' });
  const app = createApp({ repository, authService: fakeAuthService(), publicOrigin: 'http://localhost', secureCookies: false,
    rootDir: path.resolve(__dirname, '../..'), notificationService, ...overrides });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  async function request(route, options = {}) {
    const headers = { ...(options.session ? { cookie: options.session.cookie } : {}) };
    if ((options.method || 'GET') !== 'GET') {
      if (options.origin !== null) headers.origin = options.origin || 'http://localhost';
      if (options.csrf !== null && (options.csrf || options.session)) headers['x-csrf-token'] = options.csrf || options.session.csrfToken;
    }
    if (options.body !== undefined || options.raw !== undefined) headers['content-type'] = options.contentType || 'application/json';
    const response = await fetch(`${base}${route}`, { method: options.method || 'GET', headers,
      body: options.raw !== undefined ? options.raw : options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = undefined; }
    return { status: response.status, headers: response.headers, text, body };
  }
  async function login(username, password = TEST_PASSWORD) {
    const result = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    if (result.status !== 200) throw new Error(`Login failed: ${result.status} ${result.text}`);
    const setCookie = result.headers.get('set-cookie');
    return { cookie: setCookie.split(';')[0], setCookie, csrfToken: result.body.data.csrfToken };
  }
  return { repository, messages, request, login };
}

module.exports = { startApi, validPayload, unsignedPayload, memoryRepository, fakeAuthService, TEST_PASSWORD, TEST_NEW_PASSWORD };
