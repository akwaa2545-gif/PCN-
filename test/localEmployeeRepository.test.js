const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');
const { validateLocalEmployeeAccount } = require('../src/employeeAccounts');

const account = Object.freeze({ employeeCode: '0012345', displayName: ' Local Employee ', department: 'qaTet', roles: ['qa'] });
function fixture(results = []) {
  const state = { calls: [], committed: false, rolledBack: false, began: false };
  const request = () => {
    let inputs = {};
    return { input(name, type, value) { inputs = { ...inputs, [name]: value }; return this; },
      async query(query) {
        const next = results[state.calls.length];
        state.calls = [...state.calls, { query, inputs }];
        if (next instanceof Error) throw next;
        return { rowsAffected: [1], recordset: [], ...next };
      } };
  };
  const pool = { request, transaction: () => ({ request, async begin(level) { state.began = true; state.level = level; },
    async commit() { state.committed = true; }, async rollback() { state.rolledBack = true; } }) };
  return { repo: new SqlAuthRepository(pool), state };
}
const hydrated = { recordsets: [[{ Id: 'local-id', IdentityProvider: 'pcn-local', EmployeeCode: '0012345',
  DisplayName: 'Local Employee', IsActive: true, PasswordHash: null }], [{ Name: 'qa' }]] };

test('local creation stores seven-digit code, trimmed name and assigned role without source/password identity', async () => {
  const { repo, state } = fixture([{}, {}, {}, {}, {}, {}, {}, hydrated]);
  const result = await repo.createLocalEmployeeUser(account, 'user:administrator');
  assert.equal(result.identityProvider, 'pcn-local');
  assert.equal(result.passwordHash, null);
  assert.equal(state.committed, true);
  const unique = state.calls.find(call => /UPDLOCK,HOLDLOCK/.test(call.query));
  assert.equal(unique.inputs.employeeCode, '0012345');
  assert.match(unique.query, /NormalizedEmployeeCode=@employeeCode/);
  assert.match(unique.query, /NormalizedUsername=@employeeCode/);
  assert.doesNotMatch(unique.query, /IsActive=1|IdentityProvider=/);
  const insert = state.calls.find(call => /INSERT pcn.Users/.test(call.query));
  assert.equal(insert.inputs.employeeCode, '0012345');
  assert.equal(insert.inputs.displayName, 'Local Employee');
  assert.match(insert.query, /'pcn-local'/);
  assert.equal(insert.inputs.hash, undefined);
  const audit = state.calls.find(call => /INSERT pcn.AuditLogs/.test(call.query));
  assert.equal(audit.inputs.actor, 'user:administrator');
  assert.equal(audit.inputs.action, 'local-account-created');
  assert.doesNotMatch(audit.inputs.metadata, /password|stamp|mailProfile/);
});

test('local identity and assignments fail validation before opening a transaction', async () => {
  assert.equal(typeof validateLocalEmployeeAccount, 'function');
  for (const change of [{ employeeCode: '123456' }, { employeeCode: '12345678' }, { employeeCode: '001a345' },
    { employeeCode: 1234567 }, { displayName: '' }, { displayName: '   ' }, { displayName: 'X'.repeat(201) },
    { displayName: 'Local\nEmployee' }, { displayName: '\tLocal Employee' }, { displayName: 'Local Employee\u007f' },
    { displayName: 'Local\u0000Employee' },
    { roles: [] }, { roles: ['unknown'] }, { department: 'unknown' }, { signingStep: 'checked' },
    { email: 'x@example.com', mailDirectoryId: 'bad', mailVerifiedAt: null, mailProfile: {} }]) {
    const { repo, state } = fixture();
    await assert.rejects(repo.createLocalEmployeeUser({ ...account, ...change }), { statusCode: 400 });
    assert.equal(state.began, false);
  }
});

test('global employee-code conflicts and SQL constraints roll back local creation safely', async () => {
  const duplicate = fixture([{}, { recordset: [{ Id: 'existing-inactive-or-legacy' }] }]);
  await assert.rejects(duplicate.repo.createLocalEmployeeUser(account), { statusCode: 409 });
  assert.equal(duplicate.state.rolledBack, true);
  assert.equal(duplicate.state.calls.some(call => /INSERT pcn.Users/.test(call.query)), false);
  for (const number of [2601, 2627]) {
    const conflict = fixture([{}, {}, Object.assign(new Error('SQL private detail'), { number })]);
    await assert.rejects(conflict.repo.createLocalEmployeeUser(account), error => error.statusCode === 409 && !error.message.includes('private'));
    assert.equal(conflict.state.committed, false);
    assert.equal(conflict.state.rolledBack, true);
  }
  const badGrant = fixture([{}, {}, {}, { rowsAffected: [0] }]);
  await assert.rejects(badGrant.repo.createLocalEmployeeUser(account), { statusCode: 400 });
  assert.equal(badGrant.state.rolledBack, true);
});

test('local creation rechecks revoked browser principal before any account write', async () => {
  const { repo, state } = fixture([{}, { recordset: [{ IsActive: false }] }]);
  await assert.rejects(repo.createLocalEmployeeUser(account, 'user:admin',
    { id: 'admin-id', version: '0011223344556677', sessionSecurityStamp: 'stamp' }), { statusCode: 401 });
  assert.equal(state.rolledBack, true);
  assert.equal(state.calls.some(call => /INSERT pcn.Users/.test(call.query)), false);
});

test('verified signing assignments are stored for local accounts and routing failure rolls back all grants', async () => {
  const mailProfile = { id: 'mail-id', email: 'employee@example.com' };
  const signed = { ...account, signingStep: 'checked', email: mailProfile.email, mailProfile,
    mailDirectoryId: mailProfile.id, mailVerifiedAt: new Date('2026-10-12T00:00:00Z') };
  const created = fixture([{}, {}, {}, {}, {}, {}, {}, hydrated]);
  await created.repo.createLocalEmployeeUser(signed);
  const insert = created.state.calls.find(call => /INSERT pcn.Users/.test(call.query));
  assert.equal(insert.inputs.signingStep, 'checked');
  assert.equal(insert.inputs.mailId, mailProfile.id);
  assert.deepEqual(JSON.parse(insert.inputs.mailProfile), mailProfile);
  const full = fixture([{}, {}, {}, {}, { recordset: [{ SettingsJson: '{invalid' }] }]);
  await assert.rejects(full.repo.createLocalEmployeeUser(signed), { statusCode: 503 });
  assert.equal(full.state.rolledBack, true);
  assert.equal(full.state.committed, false);
  assert.equal(full.state.calls.some(call => /INSERT pcn.AuditLogs/.test(call.query)), false);

  const row = { Id: 'local-id', IdentityProvider: 'pcn-local', IsActive: true,
    AccessVersion: Buffer.from('0011223344556677', 'hex') };
  const updated = fixture([{}, { recordsets: [[row], [{ Name: 'qa' }]] }, {}, {}, {}, {}, {}, {}, {}, hydrated]);
  await updated.repo.updateEmployeeAccount('local-id', { ...signed, isActive: true, version: '0011223344556677' });
  assert.equal(updated.state.committed, true);
  assert.equal(updated.state.calls.find(call => /UPDATE pcn.Users/.test(call.query)).inputs.signingStep, 'checked');
});

test('last active local administrator guard counts both code-based providers', async () => {
  const row = { Id: 'local-id', IsActive: true, IdentityProvider: 'pcn-local', AccessVersion: Buffer.from('0011223344556677', 'hex') };
  const { repo, state } = fixture([{}, { recordsets: [[row], [{ Name: 'admin' }]] }, { recordset: [{ Total: 1 }] }]);
  await assert.rejects(repo.updateEmployeeAccount('local-id', { roles: ['qa'], department: 'qaTet',
    isActive: true, version: '0011223344556677' }), { statusCode: 409 });
  const count = state.calls.find(call => /COUNT\(DISTINCT/.test(call.query));
  assert.match(count.query, /IdentityProvider IN \('employee-code','pcn-local'\)/);
  assert.equal(state.calls.some(call => /UPDATE pcn.Users/.test(call.query)), false);
});

test('explicit local identity link requires same code and preserves grants while revoking sessions', async () => {
  const wrong = fixture([{}, { recordset: [{ Id: 'local-id', IsActive: true, IdentityProvider: 'pcn-local', EmployeeCode: '0012345' }] }]);
  await assert.rejects(wrong.repo.linkEmployeeIdentity('local-id', { employeeCode: '0099999' }), { statusCode: 409 });
  assert.equal(wrong.state.rolledBack, true);
  const sourceHydrated = { recordsets: [[{ ...hydrated.recordsets[0][0], IdentityProvider: 'employee-code' }], hydrated.recordsets[1]] };
  const linked = fixture([{}, { recordset: [{ Id: 'local-id', IsActive: true, IdentityProvider: 'pcn-local', EmployeeCode: '0012345' }] }, {}, {}, {}, {}, {}, sourceHydrated]);
  const source = await linked.repo.linkEmployeeIdentity('local-id', { employeeCode: '0012345', displayName: 'Directory Employee' });
  assert.equal(source.identityProvider, 'employee-code');
  assert.equal(source.id, 'local-id');
  const update = linked.state.calls.find(call => /UPDATE pcn.Users SET/.test(call.query));
  assert.match(update.query, /IdentityProvider='employee-code'/);
  assert.doesNotMatch(update.query, /DepartmentKey=|UserRoles|PcnRequests/);
  assert.match(update.query, /Email=CASE WHEN MailVerifiedAt IS NOT NULL THEN Email/);
  assert.ok(linked.state.calls.some(call => /UPDATE pcn.Sessions/.test(call.query)));
  assert.equal(linked.state.committed, true);
});

test('local provider migration preserves historical rows and global identity indexes', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '006_pcn_local_employee.sql'), 'utf8');
  assert.match(content, /pcn-local/);
  assert.match(content, /CK_Users_LocalEmployeeIdentity/);
  assert.match(content, /PasswordHash IS NULL/);
  assert.match(content, /LEN\(EmployeeCode\)=7/);
  assert.match(content, /NOT LIKE N'%\[\^0-9\]%'/);
  assert.match(content, /CK_Users_VerifiedSigningMail/);
  assert.doesNotMatch(content, /UPDATE pcn.Users|DROP INDEX|JSON_VALUE|ISJSON/);
});
