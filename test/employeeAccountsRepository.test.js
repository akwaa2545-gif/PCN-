const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');
const { migrationManifest } = require('../src/sqlDatabase');

const identity = Object.freeze({ employeeCode: '001Employee', department: 'qaTet',
  adObjectGuid: 'b1931258-a194-4a50-8fb8-7f8153215ab2', adSid: 'S-1-5-21-100-200-300-400',
  displayName: 'Employee Name', email: 'employee@example.test', roles: ['qa'] });

function fixture(results = []) {
  const state = { calls: [], committed: false, rolledBack: false, began: false };
  function request() {
    let inputs = {};
    return { input(name, type, value) { inputs = { ...inputs, [name]: value }; return this; },
      async query(query) {
        const offset = state.calls.length;
        state.calls = [...state.calls, { query, inputs }];
        const result = results[offset];
        if (result instanceof Error) throw result;
        return result || { rowsAffected: [1], recordset: [] };
      } };
  }
  const pool = { request, transaction: () => ({ request, async begin() { state.began = true; },
    async commit() { state.committed = true; }, async rollback() { state.rolledBack = true; } }) };
  return { repo: new SqlAuthRepository(pool), state };
}

function hydratedResult() {
  return { recordsets: [[{ Id: 'account-id', Username: identity.employeeCode, EmployeeCode: identity.employeeCode,
    DepartmentKey: identity.department, AdObjectGuid: identity.adObjectGuid, AdSid: identity.adSid,
    DisplayName: identity.displayName, Email: identity.email, IsActive: true, MustChangePassword: false,
    PasswordHash: null, SecurityStamp: 'stamp' }], [{ Name: 'qa' }]] };
}

test('employee account creation keeps SamAccountName as a string and atomically creates passwordless grants', async () => {
  const { repo, state } = fixture([{ rowsAffected: [1] }, { rowsAffected: [1] }, hydratedResult()]);
  const account = await repo.createEmployeeUser({ ...identity, roles: ['qa', 'qa'] });
  const insert = state.calls[0];
  assert.equal(insert.inputs.employeeCode, '001Employee');
  assert.equal(insert.inputs.normalizedEmployeeCode, '001employee');
  assert.equal(insert.inputs.username, '001Employee');
  assert.equal(insert.inputs.normalizedUsername, '001employee');
  assert.equal(insert.inputs.adObjectGuid, identity.adObjectGuid);
  assert.equal(insert.inputs.adSid, identity.adSid);
  assert.equal(insert.inputs.department, 'qaTet');
  assert.match(insert.query, /NULL,1,0/);
  assert.equal(insert.inputs.hash, undefined);
  assert.equal(state.calls.length, 3, 'duplicate role grants must be deduplicated');
  assert.equal(state.committed, true);
  assert.equal(account.employeeCode, identity.employeeCode);
  assert.equal(account.department, identity.department);
  assert.equal(account.passwordHash, null);
  assert.deepEqual(account.roles, ['qa']);
});

test('employee account identity collisions are safe conflicts and never replace a legacy user', async () => {
  for (const number of [2601, 2627]) {
    const duplicate = Object.assign(new Error('SQL private index and domain details'), { number });
    const { repo, state } = fixture([duplicate]);
    await assert.rejects(repo.createEmployeeUser(identity), error => error.statusCode === 409 && !/SQL private/.test(error.message));
    assert.equal(state.rolledBack, true);
    assert.equal(state.committed, false);
    assert.equal(state.calls.some(call => /UPDATE|DELETE/.test(call.query)), false);
  }
});

test('invalid role persistence rolls employee insertion back instead of leaving an account without grants', async () => {
  const { repo, state } = fixture([{ rowsAffected: [1] }, { rowsAffected: [0] }]);
  await assert.rejects(repo.createEmployeeUser(identity), { statusCode: 400 });
  assert.equal(state.rolledBack, true);
  assert.equal(state.committed, false);
});

test('employee account boundaries reject malformed identifiers before beginning SQL writes', async () => {
  for (const invalid of [{ employeeCode: 123 }, { employeeCode: '' }, { employeeCode: 'user\\spoof' },
    { adObjectGuid: "' OR 1=1 --" }, { adSid: 'arbitrary' }, { roles: ['superadmin'] }, { roles: [] },
    { email: 'invalid' }, { department: '' }, { displayName: 42 }, { displayName: 'A'.repeat(201) },
    { adSid: 'S-1-5-' + '1'.repeat(185) }, { email: 'a'.repeat(310) + '@example.test' }]) {
    const { repo, state } = fixture();
    await assert.rejects(repo.createEmployeeUser({ ...identity, ...invalid }), { statusCode: 400 });
    assert.equal(state.began, false);
    assert.equal(state.calls.length, 0);
  }
});

test('AD sign-in lookup uses immutable GUID and parameterized SQL rather than employee code alone', async () => {
  const { repo, state } = fixture([hydratedResult()]);
  const account = await repo.getUserByAdObjectGuid(identity.adObjectGuid.toUpperCase());
  assert.equal(state.calls[0].inputs.adObjectGuid, identity.adObjectGuid);
  assert.match(state.calls[0].query, /u\.AdObjectGuid=@adObjectGuid/);
  assert.equal(state.calls[0].query.includes(identity.adObjectGuid), false);
  assert.equal(account.directoryId, identity.adObjectGuid);
  await assert.rejects(repo.getUserByAdObjectGuid('invalid'), { statusCode: 400 });
  const missing = fixture([{ recordsets: [[], []] }]);
  assert.equal(await missing.repo.getUserByAdObjectGuid(identity.adObjectGuid), null);
});

test('employee list exposes assigned department and display details without credentials or AD security identifiers', async () => {
  const { repo, state } = fixture([{ recordset: [{ Id: 'one', Username: identity.employeeCode,
    EmployeeCode: identity.employeeCode, DepartmentKey: identity.department, DisplayName: identity.displayName,
    AdObjectGuid: identity.adObjectGuid, AdSid: identity.adSid,
    Email: identity.email, IsActive: true, MustChangePassword: false, PasswordHash: null, Role: 'qa' },
    { Id: 'old', Username: 'legacy', EmployeeCode: null, DepartmentKey: null, DisplayName: null, Role: 'admin' }] }]);
  const users = await repo.listUsers();
  assert.equal(users[0].employeeCode, identity.employeeCode);
  assert.equal(users[0].department, identity.department);
  assert.equal(users[0].displayName, identity.displayName);
  assert.equal(users[0].directoryId, identity.adObjectGuid);
  assert.equal(users[0].identityProvider, 'windows');
  assert.equal(users[0].passwordHash, undefined);
  assert.equal(users[0].adSid, undefined);
  assert.equal(users[1].employeeCode, null, 'legacy usernames must not be mapped automatically');
  assert.equal(users[1].directoryId, null);
  assert.equal(users[1].identityProvider, 'password');
  assert.match(state.calls[0].query, /u\.EmployeeCode/);
});

test('employee identity migration is additive, SQL2014 compatible and preserves legacy accounts', () => {
  assert.equal(migrationManifest.includes('002_employee_identity.sql'), true);
  const migration = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '002_employee_identity.sql'), 'utf8');
  for (const column of ['EmployeeCode', 'NormalizedEmployeeCode', 'DepartmentKey', 'AdObjectGuid', 'AdSid', 'DisplayName']) {
    assert.match(migration, new RegExp(`ADD ${column} `));
  }
  assert.match(migration, /ALTER COLUMN PasswordHash nvarchar\(512\) NULL/i);
  for (const identityColumn of ['NormalizedEmployeeCode', 'AdObjectGuid', 'AdSid']) {
    assert.match(migration, new RegExp(`CREATE UNIQUE INDEX [^\\n]+ON pcn.Users\\(${identityColumn}\\) WHERE ${identityColumn} IS NOT NULL`, 'i'));
  }
  assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE|DROP)\b/i);
  assert.doesNotMatch(migration, /\b(?:ISJSON|OPENJSON|JSON_VALUE)\s*\(/i);
});

test('explicit employee linking retains existing identity, roles and credentials while revoking previous sessions', async () => {
  const { repo, state } = fixture([{ recordset: [{ Id: 'old-account', AdObjectGuid: null }] }, { rowsAffected: [1] },
    { rowsAffected: [2, 1] }, hydratedResult()]);
  const profile = { samAccountName: identity.employeeCode, directoryId: identity.adObjectGuid,
    adSid: identity.adSid, displayName: identity.displayName, email: identity.email };
  const account = await repo.linkEmployeeIdentity('old-account', profile);
  const update = state.calls[1];
  assert.equal(update.inputs.id, 'old-account');
  assert.equal(update.inputs.department, null, 'omitted department must retain the assigned value');
  assert.match(update.query, /DepartmentKey=COALESCE\(@department,DepartmentKey\)/);
  assert.match(update.query, /SecurityStamp=@stamp/);
  assert.match(update.query, /MustChangePassword=0/);
  assert.doesNotMatch(update.query, /PasswordHash|UserRoles|PcnRequests/);
  assert.match(state.calls[2].query, /UPDATE pcn.Sessions SET RevokedAt/);
  assert.match(state.calls[2].query, /UPDATE pcn.AccountTokens SET UsedAt/);
  assert.equal(state.committed, true);
  assert.equal(account.employeeCode, identity.employeeCode);
});

test('explicit linking rejects missing, conflicting and already-linked accounts without partial changes', async () => {
  const absent = fixture([{ recordset: [] }]);
  await assert.rejects(absent.repo.linkEmployeeIdentity('missing', identity), { statusCode: 404 });
  assert.equal(absent.state.rolledBack, true);
  assert.equal(absent.state.calls.length, 1);
  const linked = fixture([{ recordset: [{ Id: 'old', AdObjectGuid: 'a1931258-a194-4a50-8fb8-7f8153215ab2' }] }]);
  await assert.rejects(linked.repo.linkEmployeeIdentity('old', identity), { statusCode: 409 });
  assert.equal(linked.state.calls.length, 1);
  const duplicate = Object.assign(new Error('private SQL identity details'), { number: 2601 });
  const collision = fixture([{ recordset: [{ Id: 'old', AdObjectGuid: null }] }, duplicate]);
  await assert.rejects(collision.repo.linkEmployeeIdentity('old', identity), error => error.statusCode === 409 && !error.message.includes('private'));
  assert.equal(collision.state.rolledBack, true);
  assert.equal(collision.state.committed, false);
  assert.equal(collision.state.calls.length, 2);
});

test('employee identity validation preserves leading zeros and rejects codes exceeding AD SamAccountName length', async () => {
  const { validateEmployeeIdentity, employeeDepartments } = require('../src/employeeAccounts');
  assert.doesNotThrow(() => validateEmployeeIdentity({ ...identity, employeeCode: '00123', department: 'it' }));
  assert.doesNotThrow(() => validateEmployeeIdentity({ ...identity, department: 'other' }));
  for (const invalid of [null, [], { ...identity, department: 'unknown' }, { ...identity, adSid: null }]) {
    assert.throws(() => validateEmployeeIdentity(invalid), { statusCode: 400 });
  }
  assert.equal(employeeDepartments.length, 7);
  const { repo, state } = fixture();
  await assert.rejects(repo.createEmployeeUser({ ...identity, employeeCode: 'a'.repeat(21) }), { statusCode: 400 });
  await assert.rejects(repo.linkEmployeeIdentity('existing', { ...identity, department: 'unknown' }), { statusCode: 400 });
  assert.equal(state.began, false);
});
