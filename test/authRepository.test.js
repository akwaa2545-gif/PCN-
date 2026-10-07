const test = require('node:test');
const assert = require('node:assert/strict');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');

function fixture(results) {
  const state = { calls: [], committed: false, rolledBack: false };
  const request = () => {
    let inputs = {};
    return {
      input(name, type, value) { inputs = { ...inputs, [name]: value }; return this; },
      async query(query) {
        state.calls = [...state.calls, { query, inputs }];
        const result = results[state.calls.length - 1];
        if (result instanceof Error) throw result;
        return result || { rowsAffected: [1], recordset: [] };
      }
    };
  };
  const pool = { request, transaction: () => ({ request, async begin() {}, async commit() { state.committed = true; }, async rollback() { state.rolledBack = true; } }) };
  return { repo: new SqlAuthRepository(pool), state };
}

test('SQL auth binds hostile login input and hydrates role grants', async () => {
  const { repo, state } = fixture([{ recordsets: [[{ Id: 'id', Username: 'user', PasswordHash: 'secret', IsActive: true, SecurityStamp: 'stamp' }], [{ Name: 'admin' }, { Name: 'qa' }]] }]);
  const hostile = "someone' OR 1=1 --";
  const user = await repo.getUserByLogin(hostile);
  assert.deepEqual(user.roles, ['admin', 'qa']);
  assert.equal(state.calls[0].inputs.login, hostile);
  assert.equal(state.calls[0].query.includes(hostile), false);
});

test('SQL auth finds Employee ID with a bound parameter', async () => {
  const { repo, state } = fixture([{ recordsets: [[{ Id: 'id', Username: 'operator', EmployeeId: '0012345' }], [{ Name: 'gsc' }]] }]);
  const user = await repo.getUserByEmployeeId('0012345');
  assert.equal(user.employeeId, '0012345');
  assert.deepEqual(user.roles, ['gsc']);
  assert.equal(state.calls[0].inputs.employeeId, '0012345');
  assert.equal(state.calls[0].query.includes('0012345'), false);
});

test('assigning Employee ID revokes prior sessions and clears password-change requirement', async () => {
  const { repo, state } = fixture([
    { rowsAffected: [1] },
    { rowsAffected: [1] },
    { recordsets: [[{ Id: 'id', Username: 'itadmin', EmployeeId: '0012345', MustChangePassword: false }], [{ Name: 'admin' }]] }
  ]);
  const user = await repo.assignEmployeeId('ITadmin', '0012345');
  assert.equal(user.employeeId, '0012345');
  assert.equal(state.calls[0].inputs.username, 'itadmin');
  assert.equal(state.calls[0].inputs.employeeId, '0012345');
  assert.match(state.calls[0].query, /MustChangePassword=0/);
  assert.match(state.calls[1].query, /pcn\.Sessions/);
  assert.equal(state.committed, true);
});

test('password change rolls back when account stamp changed concurrently', async () => {
  const { repo, state } = fixture([{ rowsAffected: [0] }]);
  await assert.rejects(repo.updatePassword('id', 'new-hash', 'new-stamp', 'old-stamp'), error => error.statusCode === 409);
  assert.equal(state.rolledBack, true);
  assert.equal(state.committed, false);
  assert.equal(state.calls.length, 1);
});

test('password change updates stamp and revokes sessions/tokens in one transaction', async () => {
  const { repo, state } = fixture([{ rowsAffected: [1] }, { rowsAffected: [3, 1] }]);
  await repo.updatePassword('id', 'new-hash', 'new-stamp', 'old-stamp');
  assert.equal(state.committed, true);
  assert.equal(state.calls[0].inputs.expected, 'old-stamp');
  assert.equal(state.calls[0].inputs.hash, 'new-hash');
  assert.equal(state.calls[1].inputs.id, 'id');
});

test('user list groups multiple roles without exposing password hashes', async () => {
  const { repo } = fixture([{ recordset: [{ Id: 'one', Username: 'user', Email: null, IsActive: true, Role: 'admin' }, { Id: 'one', Username: 'user', IsActive: true, Role: 'qa' }, { Id: 'two', Username: 'another', Role: null }] }]);
  const users = await repo.listUsers();
  assert.equal(users.length, 2);
  assert.deepEqual(users[0].roles, ['admin', 'qa']);
  assert.deepEqual(users[1].roles, []);
  assert.equal(users[0].passwordHash, undefined);
});

test('create user stores hash and commits normalized identity and role together', async () => {
  const { repo, state } = fixture([{ rowsAffected: [1] }, { rowsAffected: [1] }, { recordsets: [[{ Id: 'created', Username: 'ITadmin', Email: null }], [{ Name: 'admin' }]] }]);
  const result = await repo.createUser({ username: 'ITadmin', email: null, passwordHash: 'salted-hash', roles: ['admin'], mustChangePassword: true });
  assert.equal(result.username, 'ITadmin');
  assert.equal(state.calls[0].inputs.normalizedUsername, 'itadmin');
  assert.equal(state.calls[0].inputs.normalizedEmail, null);
  assert.equal(state.calls[0].inputs.hash, 'salted-hash');
  assert.equal(state.calls[0].inputs.change, true);
  assert.equal(state.committed, true);
});

test('duplicate identity creation rolls back and reports safe conflict', async () => {
  const duplicate = Object.assign(new Error('internal unique key SQL detail'), { number: 2627 });
  const { repo, state } = fixture([duplicate]);
  await assert.rejects(repo.createUser({ username: 'user', email: 'user@example.com', passwordHash: 'hash', roles: ['supplier'], mustChangePassword: false }), error => error.statusCode === 409 && !error.message.includes('internal'));
  assert.equal(state.rolledBack, true);
});

test('SQL sessions persist hash instead of token and hydrate expiry', async () => {
  const expires = new Date('2026-01-02');
  const { repo, state } = fixture([{ rowsAffected: [1] }, { recordset: [{ Id: 'session', UserId: 'user', TokenHash: 'hash', CsrfToken: 'csrf', SecurityStamp: 'stamp', ExpiresAt: expires, RevokedAt: null }] }, { recordset: [] }]);
  await repo.saveSession({ id: 'session', userId: 'user', tokenHash: 'hash', csrfToken: 'csrf', securityStamp: 'stamp', createdAt: '2026-01-01', expiresAt: expires });
  assert.equal(state.calls[0].inputs.hash, 'hash');
  const session = await repo.getSession('hash');
  assert.equal(session.userId, 'user');
  assert.equal(session.expiresAt, expires);
  assert.equal(await repo.getSession('missing'), null);
  await repo.revokeSession('hash');
  await repo.recordLoginFailure('user', expires);
  await repo.resetLoginFailures('user');
  await repo.deactivateUser('user');
  assert.equal(state.calls.at(-1).inputs.id, 'user');
  assert.ok(state.calls.at(-1).inputs.stamp);
});

test('role changes invalidate old session stamp and roll back missing user', async () => {
  const first = fixture([{ rowsAffected: [1, 1] }, { rowsAffected: [1] }]);
  await first.repo.setUserRoles('user', ['qa', 'qa']);
  assert.equal(first.state.calls.length, 2);
  assert.equal(first.state.committed, true);
  assert.ok(first.state.calls[0].inputs.stamp);
  const missing = fixture([{ rowsAffected: [0] }]);
  await assert.rejects(missing.repo.setUserRoles('missing', ['supplier']), error => error.statusCode === 404);
  assert.equal(missing.state.rolledBack, true);
  await assert.rejects(first.repo.setUserRoles('user', ['invalid']), error => error.statusCode === 400);
});
