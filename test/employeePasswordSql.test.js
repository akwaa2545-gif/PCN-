const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = require('mssql');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');

function fixture(results = []) {
  const state = { calls: [], committed: false, rolledBack: false, isolation: null };
  const request = () => {
    let inputs = {};
    return {
      input(name, type, value) { inputs = { ...inputs, [name]: value }; return this; },
      async query(query) {
        state.calls = [...state.calls, { query, inputs }];
        const result = results[state.calls.length - 1];
        if (result instanceof Error) throw result;
        return { rowsAffected: [1], recordset: [], ...result };
      }
    };
  };
  const pool = { request, transaction: () => ({ request,
    async begin(isolation) { state.isolation = isolation; },
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; }
  }) };
  return { repo: new SqlAuthRepository(pool), state };
}

const session = { id: 'session', userId: 'user', tokenHash: 'a'.repeat(64), csrfToken: 'b'.repeat(64),
  securityStamp: 'stamp', createdAt: '2026-11-20T00:00:00Z', expiresAt: '2026-11-20T00:10:00Z' };

test('legacy session writes remain compatible before migration 010', async () => {
  for (const value of [undefined, null]) {
    const { repo, state } = fixture();
    await repo.saveSession({ ...session, authenticationMethod: value });
    assert.doesNotMatch(state.calls[0].query, /AuthenticationMethod/);
    assert.equal(Object.hasOwn(state.calls[0].inputs, 'authenticationMethod'), false);
  }
});

test('password and setup sessions bind their authentication method separately from token hashes', async () => {
  for (const method of ['employee-password', 'password-setup', 'password', 'employee-code']) {
    const { repo, state } = fixture();
    await repo.saveSession({ ...session, authenticationMethod: method });
    assert.match(state.calls[0].query, /AuthenticationMethod/);
    assert.equal(state.calls[0].inputs.authenticationMethod, method);
    assert.equal(state.calls[0].inputs.hash, session.tokenHash);
    assert.equal(state.calls[0].query.includes(method), false);
  }
  const { repo, state } = fixture();
  await assert.rejects(repo.saveSession({ ...session, authenticationMethod: "hostile'" }), { statusCode: 400 });
  assert.equal(state.calls.length, 0);
});

test('session hydration keeps authentication purpose and tolerates a pre-010 row', async () => {
  const { repo } = fixture([
    { recordset: [{ Id: 'setup', AuthenticationMethod: 'password-setup' }] },
    { recordset: [{ Id: 'old' }] }
  ]);
  assert.equal((await repo.getSession('hash')).authenticationMethod, 'password-setup');
  assert.equal((await repo.getSession('old')).authenticationMethod, null);
});

test('private user hydration records enrollment time without adding it to administrator user lists', async () => {
  const time = new Date('2026-11-20T00:00:00Z');
  const { repo } = fixture([
    { recordsets: [[{ Id: 'one', PasswordHash: 'private-hash', PasswordSetAt: time }], []] },
    { recordsets: [[{ Id: 'old' }], []] },
    { recordset: [{ Id: 'one', Username: 'one', PasswordHash: 'private-hash', PasswordSetAt: time }] }
  ]);
  assert.equal((await repo.getUserById('one')).passwordSetAt, time);
  assert.equal((await repo.getUserById('old')).passwordSetAt, null);
  const publicUsers = await repo.listUsers();
  assert.equal(Object.hasOwn(publicUsers[0], 'passwordHash'), false);
  assert.equal(Object.hasOwn(publicUsers[0], 'passwordSetAt'), false);
});

for (const firstSetup of [true, false]) {
  test(`employee credential ${firstSetup ? 'setup' : 'change'} is a parameterized compare-and-set with atomic revocation`, async () => {
    const { repo, state } = fixture();
    const hostileHash = "argon-hash'; DROP TABLE pcn.Users; --";
    await repo.updateEmployeePassword('user', hostileHash, 'new-stamp', 'prior-stamp', { firstSetup });
    assert.equal(state.isolation, sql.ISOLATION_LEVEL.SERIALIZABLE);
    assert.equal(state.committed, true);
    assert.equal(state.rolledBack, false);
    const change = state.calls[0];
    assert.equal(change.inputs.hash, hostileHash);
    assert.equal(change.inputs.expected, 'prior-stamp');
    assert.equal(change.inputs.stamp, 'new-stamp');
    assert.equal(change.query.includes(hostileHash), false);
    assert.match(change.query, /IsActive=1/);
    assert.match(change.query, /SecurityStamp=@expected/);
    assert.match(change.query, /IdentityProvider IN \(N?'employee-code',N?'pcn-local'\)/);
    assert.match(change.query, firstSetup ? /PasswordHash IS NULL AND PasswordSetAt IS NULL/ : /PasswordHash IS NOT NULL AND PasswordSetAt IS NOT NULL/);
    assert.match(change.query, /PasswordSetAt=COALESCE\(PasswordSetAt,SYSUTCDATETIME\(\)\)/);
    assert.match(state.calls[1].query, /UPDATE pcn\.Sessions.*RevokedAt/);
    assert.match(state.calls[1].query, /UPDATE pcn\.AccountTokens.*UsedAt/);
    assert.equal(state.calls[1].inputs.id, 'user');
    assert.equal(state.calls.some(call => /UserRoles|PcnRequests|MailProfile/.test(call.query)), false);
  });
}

test('a losing enrollment, stale stamp or wrong account state cannot overwrite credentials or revoke sessions', async () => {
  const { repo, state } = fixture([{ rowsAffected: [0] }]);
  await assert.rejects(repo.updateEmployeePassword('user', 'new-hash', 'new-stamp', 'old-stamp', { firstSetup: true }), { statusCode: 409 });
  assert.equal(state.calls.length, 1);
  assert.equal(state.rolledBack, true);
  assert.equal(state.committed, false);
});

test('revocation failure rolls back the credential update', async () => {
  const { repo, state } = fixture([{}, new Error('revocation failed')]);
  await assert.rejects(repo.updateEmployeePassword('user', 'new-hash', 'new-stamp', 'old-stamp', { firstSetup: false }), /revocation failed/);
  assert.equal(state.rolledBack, true);
  assert.equal(state.committed, false);
});

test('invalid setup state is rejected before any SQL statement', async () => {
  const { repo, state } = fixture();
  await assert.rejects(repo.updateEmployeePassword('user', 'hash', 'stamp', 'prior', { firstSetup: 'true' }), { statusCode: 400 });
  assert.equal(state.calls.length, 0);
});

test('same employee relinking preserves enrolled credentials without requiring migration 010 columns in the old query', async () => {
  const { repo, state } = fixture([
    { recordset: [{ LockResult: 0 }] },
    { recordset: [{ Id: 'user', IdentityProvider: 'employee-code', EmployeeCode: '0012345', IsActive: true }] },
    {}, {}, {}, {}, {}, { recordsets: [[{ Id: 'user' }], []] }
  ]);
  await repo.linkEmployeeIdentity('user', { employeeCode: '0012345', displayName: 'Same Employee', isActive: true });
  const update = state.calls.find(call => /UPDATE pcn.Users SET Username/.test(call.query));
  assert.match(update.query, /PasswordHash=PasswordHash/);
  assert.doesNotMatch(update.query, /PasswordSetAt/);
  assert.equal(state.committed, true);
});

test('migration 010 is SQL 2014 compatible schema only and pairs hashes with enrollment time', () => {
  const content = fs.readFileSync(path.join(__dirname, '../sql/migrations/010_employee_password_auth.sql'), 'utf8');
  assert.match(content, /ADD PasswordSetAt datetime2\(3\) NULL/);
  assert.match(content, /ADD AuthenticationMethod nvarchar\(30\) NULL/);
  assert.match(content, /PasswordHash IS NULL AND PasswordSetAt IS NULL/);
  assert.match(content, /PasswordHash IS NOT NULL AND PasswordSetAt IS NOT NULL/);
  for (const field of ['EmployeeCode IS NOT NULL', 'NormalizedEmployeeCode IS NOT NULL', 'AdObjectGuid IS NULL', 'AdSid IS NULL']) assert(content.includes(field));
  assert.match(content, /WITH CHECK ADD CONSTRAINT CK_Users_EmployeeCodeAuthentication/);
  assert.match(content, /WITH CHECK ADD CONSTRAINT CK_Sessions_AuthenticationMethod/);
  for (const method of ['employee-code', 'employee-password', 'password-setup', 'password']) assert(content.includes(method));
  assert.doesNotMatch(content, /\b(?:UPDATE|INSERT|DELETE|MERGE)\s+(?:INTO\s+)?pcn\.|DROP\s+TABLE|\b(?:ISJSON|OPENJSON|JSON_VALUE|JSON_QUERY|JSON_MODIFY)\s*\(|\bGO\b/i);
});
