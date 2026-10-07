const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');
const { migrationManifest } = require('../src/sqlDatabase');
const identity = Object.freeze({ employeeCode: '001Employe', department: 'qaTet', displayName: 'Employee Name', email: null, roles: ['qa'] });

function fixture(results = []) {
  const state = { calls: [], committed: false, rolledBack: false, began: false };
  function request() {
    let inputs = {};
    return {
      input(name, type, value) { inputs = { ...inputs, [name]: value }; return this; },
      async query(query) {
        const result = results[state.calls.length];
        state.calls = [...state.calls, { query, inputs }];
        if (result instanceof Error) throw result;
        return result || { rowsAffected: [1], recordset: [] };
      }
    };
  }
  const pool = { request, transaction: () => ({ request, async begin() { state.began = true; },
    async commit() { state.committed = true; }, async rollback() { state.rolledBack = true; } }) };
  return { repo: new SqlAuthRepository(pool), state };
}

function hydrated() {
  return { recordsets: [[{ Id: 'account-id', Username: identity.employeeCode, EmployeeCode: identity.employeeCode,
    NormalizedEmployeeCode: identity.employeeCode.toLowerCase(), DepartmentKey: identity.department,
    DisplayName: identity.displayName, Email: null, IdentityProvider: 'employee-code', IsActive: true,
    PasswordHash: null, SecurityStamp: 'stamp' }], [{ Name: 'qa' }]] };
}

test('employee creation preserves leading zeros and transactionally stores explicit provider and assigned role', async () => {
  const { repo, state } = fixture([{ rowsAffected: [1] }, { rowsAffected: [1] }, hydrated()]);
  const account = await repo.createEmployeeUser({ ...identity, roles: ['qa', 'qa'] });
  const insert = state.calls[0];
  assert.equal(insert.inputs.employeeCode, '001Employe');
  assert.equal(insert.inputs.normalizedEmployeeCode, '001employe');
  assert.equal(insert.inputs.username, '001Employe');
  assert.equal(insert.inputs.department, 'qaTet');
  assert.match(insert.query, /IdentityProvider/);
  assert.match(insert.query, /'employee-code'/);
  assert.equal(insert.inputs.adSid, undefined);
  assert.equal(insert.inputs.adObjectGuid, undefined);
  assert.equal(insert.inputs.hash, undefined);
  assert.equal(state.calls.length, 3);
  assert.equal(state.committed, true);
  assert.equal(account.identityProvider, 'employee-code');
  assert.equal(account.passwordHash, null);
});

test('collisions and invalid persisted grants roll back safely', async () => {
  for (const number of [2601, 2627]) {
    const { repo, state } = fixture([Object.assign(new Error('private SQL detail'), { number })]);
    await assert.rejects(repo.createEmployeeUser(identity), error => error.statusCode === 409 && !error.message.includes('private'));
    assert.equal(state.rolledBack, true);
    assert.equal(state.committed, false);
  }
  const failed = fixture([{ rowsAffected: [1] }, { rowsAffected: [0] }]);
  await assert.rejects(failed.repo.createEmployeeUser(identity), { statusCode: 400 });
  assert.equal(failed.state.rolledBack, true);
});

test('invalid source profile or assignments are rejected before SQL writes', async () => {
  const invalidProfiles = [{ employeeCode: 123 }, { employeeCode: '' }, { employeeCode: 'a'.repeat(11) },
    { employeeCode: 'user\\spoof' }, { roles: [] }, { roles: ['superadmin'] }, { email: 'invalid' },
    { department: 'unknown' }, { displayName: 42 }, { displayName: 'A'.repeat(201) }];
  for (const invalid of invalidProfiles) {
    const { repo, state } = fixture();
    await assert.rejects(repo.createEmployeeUser({ ...identity, ...invalid }), { statusCode: 400 });
    assert.equal(state.began, false);
  }
});

test('employee code lookup uses normalized parameter and provider with no SQL interpolation', async () => {
  const { repo, state } = fixture([hydrated()]);
  const user = await repo.getUserByEmployeeCode('001EMPLOYE');
  assert.equal(state.calls[0].inputs.employeeCode, '001employe');
  assert.match(state.calls[0].query, /u\.NormalizedEmployeeCode=@employeeCode/);
  assert.match(state.calls[0].query, /u\.IdentityProvider='employee-code'/);
  assert.equal(state.calls[0].query.includes('001employe'), false);
  assert.equal(user.employeeCode, identity.employeeCode);
  await assert.rejects(repo.getUserByEmployeeCode("' OR 1=1 --"), { statusCode: 400 });
});

test('explicit linking preserves user ownership, assigned department and roles while removing credentials and old AD identity', async () => {
  const { repo, state } = fixture([{ recordset: [{ Id: 'old', IdentityProvider: 'retired-windows', EmployeeCode: 'old-sam', IsActive: true }] },
    { rowsAffected: [1] }, { rowsAffected: [2, 1] }, hydrated()]);
  const user = await repo.linkEmployeeIdentity('old', identity);
  const update = state.calls[1];
  assert.equal(update.inputs.employeeCode, '001Employe');
  assert.match(update.query, /IdentityProvider='employee-code'/);
  assert.match(update.query, /AdObjectGuid=NULL,AdSid=NULL/);
  assert.match(update.query, /PasswordHash=NULL/);
  assert.match(update.query, /SecurityStamp=@stamp/);
  assert.doesNotMatch(update.query, /DepartmentKey=|UserRoles|PcnRequests/);
  assert.match(state.calls[2].query, /UPDATE pcn.Sessions SET RevokedAt/);
  assert.match(state.calls[2].query, /UPDATE pcn.AccountTokens SET UsedAt/);
  assert.equal(state.committed, true);
  assert.equal(user.identityProvider, 'employee-code');
});

test('linking rejects conflicting employee links and missing or disabled accounts with no partial mutation', async () => {
  const cases = [[[], 404], [[{ IdentityProvider: 'employee-code', EmployeeCode: 'other', IsActive: true }], 409],
    [[{ IdentityProvider: 'password', IsActive: false }], 400]];
  for (const [recordset, status] of cases) {
    const { repo, state } = fixture([{ recordset }]);
    await assert.rejects(repo.linkEmployeeIdentity('old', identity), { statusCode: status });
    assert.equal(state.rolledBack, true);
    assert.equal(state.calls.length, 1);
  }
  const collision = fixture([{ recordset: [{ IdentityProvider: 'password', IsActive: true }] },
    Object.assign(new Error('private constraint'), { number: 2601 })]);
  await assert.rejects(collision.repo.linkEmployeeIdentity('old', identity), error => error.statusCode === 409 && !error.message.includes('private'));
  assert.equal(collision.state.committed, false);
});

test('user lists expose explicit provider but no AD identifiers, credentials or session stamps', async () => {
  const { repo } = fixture([{ recordset: [{ Id: 'one', Username: '001234', EmployeeCode: '001234', IdentityProvider: 'employee-code',
    DepartmentKey: 'qaTet', DisplayName: 'Name', AdObjectGuid: 'private', AdSid: 'private', PasswordHash: 'private', Role: 'qa' },
    { Id: 'old', Username: 'legacy', EmployeeCode: null, IdentityProvider: 'password', Role: 'admin' }] }]);
  const users = await repo.listUsers();
  assert.equal(users[0].identityProvider, 'employee-code');
  for (const name of ['directoryId', 'adSid', 'passwordHash', 'securityStamp']) assert.equal(users[0][name], undefined);
  assert.equal(users[1].employeeCode, null);
  assert.equal(users[1].identityProvider, 'password');
});

test('migration003 explicitly retires old Windows mappings and revokes sessions without assigning source codes', () => {
  assert.equal(migrationManifest.includes('003_employee_code_auth.sql'), true);
  const migration = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '003_employee_code_auth.sql'), 'utf8');
  assert.match(migration, /ADD IdentityProvider/);
  assert.match(migration, /retired-windows/);
  assert.match(migration, /NEWID\(\)/);
  assert.match(migration, /UPDATE pcn.Sessions/);
  assert.match(migration, /UPDATE pcn.AccountTokens/);
  assert.doesNotMatch(migration, /SET[^;]*IdentityProvider='employee-code'/i);
  assert.doesNotMatch(migration, /\b(?:ISJSON|OPENJSON|JSON_VALUE)\s*\(/i);
});

test('migration003 defers statements using newly added provider column until SQL2014 compiles them after ALTER', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '003_employee_code_auth.sql'), 'utf8');
  const statements = ['UPDATE pcn.Users', 'UPDATE pcn.Sessions', 'UPDATE pcn.AccountTokens',
    'ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_IdentityProvider',
    'ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_EmployeeCodeAuthentication'];
  for (const statement of statements) assert.match(migration, new RegExp("EXEC\\(N'" + statement));
});
