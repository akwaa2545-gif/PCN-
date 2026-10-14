const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hasRole, isInternal, canViewAllRecords, assertRecordAccess, assertReviewUpdate } = require('../src/workflowAccess');
const { actions, departments, canSign } = require('../src/signingPermissions');
const { managedRecipient } = require('../src/userMailRouting');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');
const { migrationManifest } = require('../src/sqlDatabase');
const { requirePrincipal } = require('../src/authHttp');

const developer = Object.freeze({ id: 'developer-id', isActive: true, roles: ['developer'],
  department: 'developer', signingStep: null, employeeCode: '2512501', identityProvider: 'employee-code' });

test('Developer sessions have Administrator-equivalent policy without storing an admin role', () => {
  assert.equal(hasRole(developer, 'admin'), true);
  assert.equal(hasRole(developer, 'developer'), true);
  assert.equal(isInternal(developer), true);
  assert.equal(canViewAllRecords(developer), true);
  assert.doesNotThrow(() => assertRecordAccess({ ownerUserId: 'other' }, developer));
  assert.doesNotThrow(() => assertReviewUpdate({}, { materialCodeDescription: 'internal edit' }, developer, 'RL0'));
  assert.deepEqual(developer.roles, ['developer']);
  assert.equal(hasRole({ roles: ['supplier'] }, 'admin'), false);
  assert.equal(hasRole({ roles: ['admin'] }, 'developer'), false);
  assert.equal(canViewAllRecords({ ...developer, isActive: false }), false);
});

test('Developer can sign known workflow actions but inactive accounts and invalid targets cannot', () => {
  for (const { key } of departments) {
    for (const action of actions) assert.equal(canSign(developer, key, action), true);
  }
  assert.equal(canSign({ ...developer, isActive: false }, 'qaTet', 'approved'), false);
  assert.equal(canSign(developer, 'developer', 'approved'), false);
  assert.equal(canSign(developer, 'qaTet', 'unknown'), false);
});

test('malformed Developer assignments never acquire Administrator authority', () => {
  for (const assignment of [{ department: 'it' }, { roles: ['developer', 'supplier'] },
    { signingStep: 'approved' }, { department: null }]) {
    const user = { ...developer, ...assignment };
    assert.equal(hasRole(user, 'admin'), false);
    assert.equal(canSign(user, 'qaTet', 'approved'), false);
  }
});

test('principal role gate accepts Developer for Administrator routes without expanding stored roles', () => {
  assert.equal(requirePrincipal({ user: developer }, { roles: ['admin'] }), developer);
  assert.throws(() => requirePrincipal({ user: { ...developer, department: 'it' } }, { roles: ['admin'] }), { statusCode: 403 });
});

test('inactive Developer cannot acquire Administrator authority through the central principal gate', () => {
  const inactive = { ...developer, isActive: false };
  assert.equal(hasRole(inactive, 'admin'), false);
  assert.throws(() => requirePrincipal({ user: inactive }, { roles: ['admin'] }), { statusCode: 403 });
});

test('Developer non-signing assignment never becomes an automatic signing mail recipient', () => {
  const profile = { id: 'mail-id', email: 'developer@example.com' };
  assert.equal(managedRecipient({ ...developer, email: profile.email, mailDirectoryId: profile.id,
    mailVerifiedAt: new Date().toISOString(), mailProfile: profile }), null);
});

function sqlFixture(roleAffected = 1) {
  const state = { calls: [], committed: false, rolledBack: false };
  function request() {
    let inputs = {};
    return { input(name, type, value) { inputs = { ...inputs, [name]: value }; return this; },
      async query(query) {
        state.calls = [...state.calls, { query, inputs }];
        if (/SELECT u\.\*/.test(query)) return { recordsets: [[{ Id: developer.id, EmployeeCode: developer.employeeCode,
          IdentityProvider: developer.identityProvider, DepartmentKey: developer.department, IsActive: true }], [{ Name: 'developer' }]] };
        return { rowsAffected: [/INSERT pcn\.UserRoles/.test(query) ? roleAffected : 1], recordset: [] };
      } };
  }
  const pool = { request, transaction: () => ({ request, async begin() {},
    async commit() { state.committed = true; }, async rollback() { state.rolledBack = true; } }) };
  return { repository: new SqlAuthRepository(pool), state };
}

test('SQL persists Developer role and department without an Administrator alias', async () => {
  const { repository, state } = sqlFixture();
  const result = await repository.createEmployeeUser({ ...developer, displayName: 'Developer employee' });
  const accountInsert = state.calls.find(call => /INSERT pcn\.Users/.test(call.query));
  assert.equal(accountInsert.inputs.department, 'developer');
  assert.equal(accountInsert.inputs.signingStep, null);
  assert.deepEqual(state.calls.filter(call => /INSERT pcn\.UserRoles/.test(call.query)).map(call => call.inputs.role), ['developer']);
  assert.deepEqual(result.roles, ['developer']);
  assert.equal(state.committed, true);
});

test('SQL missing Developer seed rolls back account creation rather than silently losing access', async () => {
  const { repository, state } = sqlFixture(0);
  await assert.rejects(repository.createEmployeeUser({ ...developer, displayName: 'Developer employee' }), { statusCode: 400 });
  assert.equal(state.rolledBack, true);
  assert.equal(state.committed, false);
  assert.ok(state.calls.some(call => /INSERT pcn\.UserRoles/.test(call.query)));
});

test('migration 007 is append-only role seed with no existing account grants or credentials', () => {
  assert.equal(migrationManifest.at(-1), '007_developer_role.sql');
  const migration = fs.readFileSync(path.join(__dirname, '../sql/migrations/007_developer_role.sql'), 'utf8');
  assert.match(migration, /INSERT\s+(?:INTO\s+)?pcn\.Roles/i);
  assert.match(migration, /N'developer'/);
  assert.match(migration, /NOT EXISTS/i);
  assert.doesNotMatch(migration, /UPDATE pcn\.Users|INSERT\s+(?:INTO\s+)?pcn\.UserRoles|PasswordHash|\bGO\b/i);
});

test('legacy SQL password account creation cannot grant an unpaired Developer role', async () => {
  const { repository, state } = sqlFixture();
  await assert.rejects(repository.createUser({ username: 'maintenance', roles: ['developer'],
    passwordHash: 'unusable-test-hash', mustChangePassword: false }), { statusCode: 400 });
  assert.equal(state.calls.length, 0);
});

test('explicit password-maintenance Developer creation persists its paired department and non-signing assignment', async () => {
  const { repository, state } = sqlFixture();
  await repository.createUser({ username: 'maintenance', roles: ['developer'], department: 'developer',
    signingStep: null, passwordHash: 'unusable-test-hash', mustChangePassword: false });
  const accountInsert = state.calls.find(call => /INSERT pcn.Users/.test(call.query));
  assert.equal(accountInsert.inputs.department, 'developer');
  assert.equal(accountInsert.inputs.signingStep, null);
  assert.match(accountInsert.query, /DepartmentKey/);
  assert.match(accountInsert.query, /SigningStep/);
  assert.deepEqual(state.calls.filter(call => /INSERT pcn.UserRoles/.test(call.query)).map(call => call.inputs.role), ['developer']);
});

test('changing the last actual Administrator into Developer remains prohibited', async () => {
  const { repository, state } = sqlFixture();
  repository.userQuery = async () => ({ ...developer, roles: ['admin'], department: 'it', version: '0011223344556677' });
  await assert.rejects(repository.updateEmployeeAccount(developer.id, { ...developer,
    version: '0011223344556677' }), { statusCode: 409 });
  const count = state.calls.find(call => /COUNT\(DISTINCT u.Id\)/.test(call.query));
  assert.ok(count);
  assert.match(count.query, /r.Name='admin'/);
  assert.doesNotMatch(count.query, /developer/);
  assert.equal(state.rolledBack, true);
  assert.equal(state.calls.some(call => /UPDATE pcn.Users/.test(call.query)), false);
});
