const test = require('node:test');
const assert = require('node:assert/strict');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');
const version = '0011223344556677';
const row = Object.freeze({ Id: 'employee-id', Username: '0012345', EmployeeCode: '0012345',
  DisplayName: 'Employee Name', IdentityProvider: 'pcn-local', IsActive: true, DepartmentKey: 'qaTet', SigningStep: 'checked',
  Email: 'employee@example.com', MailDirectoryId: 'mail-id', MailVerifiedAt: new Date('2026-10-12'),
  MailProfileJson: JSON.stringify({ id: 'mail-id', email: 'employee@example.com', displayName: 'Employee', extension: 'preserve raw value' }),
  SecurityStamp: 'old-stamp', AccessVersion: Buffer.from(version, 'hex') });
const userRows = (user = row, roles = ['qa']) => ({ recordsets: [user ? [user] : [], roles.map(Name => ({ Name }))] });
function fixture(results = []) {
  const state = { calls: [], committed: false, rolledBack: false, began: false };
  const request = () => {
    let inputs = {};
    return { input(name, type, value) { inputs = { ...inputs, [name]: value }; return this; },
      async query(query) { const next = results[state.calls.length]; state.calls = [...state.calls, { query, inputs }];
        if (next instanceof Error) throw next;
        return { rowsAffected: [1], recordset: [], ...next };
      } };
  };
  return { state, repo: new SqlAuthRepository({ request, transaction: () => ({ request,
    async begin() { state.began = true; }, async commit() { state.committed = true; }, async rollback() { state.rolledBack = true; } }) }) };
}
function success(prior = row, roles = ['qa']) {
  return fixture([{}, userRows(prior, roles), {}, {}, {}, {}, {}, {}, userRows({ ...prior, DepartmentKey: null, SigningStep: null }, [])]);
}

test('remove roles clears assignments and signing while retaining active identity and verified mail', async () => {
  const { repo, state } = success();
  const updated = await repo.removeEmployeeRoles(row.Id, { version }, 'user:administrator');
  assert.deepEqual(updated.roles, []);
  assert.equal(updated.department, null);
  assert.equal(updated.signingStep, null);
  assert.equal(updated.employeeCode, row.EmployeeCode);
  assert.equal(updated.displayName, row.DisplayName);
  assert.equal(updated.identityProvider, 'pcn-local');
  assert.equal(updated.isActive, true);
  assert.equal(updated.email, row.Email);
  assert.equal(updated.mailDirectoryId, row.MailDirectoryId);
  assert.equal(state.calls[0].inputs.mode, 'Exclusive');
  const change = state.calls.find(call => /UPDATE pcn.Users/.test(call.query));
  assert.match(change.query, /DepartmentKey=NULL,SigningStep=NULL/);
  assert.match(change.query, /AccessVersion=@version/);
  assert.ok(change.inputs.stamp);
  assert.doesNotMatch(change.query, /Email=|MailDirectoryId=|MailVerifiedAt=|MailProfileJson=|IsActive=|Username=|EmployeeCode=|DisplayName=|IdentityProvider=/);
  assert.ok(state.calls.some(call => /DELETE FROM pcn.UserRoles/.test(call.query)));
  assert.ok(state.calls.some(call => /UPDATE pcn.Sessions/.test(call.query) && /AccountTokens/.test(call.query)));
  assert.equal(state.calls.some(call => /INSERT pcn.UserRoles|DELETE FROM pcn.Users|PcnRequests|Documents/.test(call.query)), false);
  const audit = state.calls.find(call => /INSERT pcn.AuditLogs/.test(call.query));
  assert.equal(audit.inputs.action, 'account-roles-removed');
  assert.equal(audit.inputs.actor, 'user:administrator');
  assert.deepEqual(JSON.parse(audit.inputs.metadata).roles, []);
  assert.equal(state.committed, true);
});

test('normal updates still reject empty roles and cannot request internal removal through body flags', async () => {
  const { repo, state } = fixture();
  await assert.rejects(repo.updateEmployeeAccount(row.Id, { roles: [], department: 'qaTet', isActive: true, version, roleRemoval: true }), { statusCode: 400 });
  assert.equal(state.began, false);
  for (const input of [{}, { version: 'short' }, { version: 7 }, null]) {
    await assert.rejects(repo.removeEmployeeRoles(row.Id, input), { statusCode: 400 });
    assert.equal(state.began, false);
  }
});

test('role removal supports source, local and assigned legacy identities without changing active state', async () => {
  for (const IdentityProvider of ['employee-code', 'pcn-local', 'password', 'retired-windows']) {
    const prior = { ...row, IdentityProvider, IsActive: false };
    const { repo, state } = success(prior);
    const updated = await repo.removeEmployeeRoles(row.Id, { version });
    assert.equal(updated.identityProvider, IdentityProvider);
    assert.equal(updated.isActive, false);
    assert.deepEqual(updated.roles, []);
    assert.equal(state.committed, true);
  }
});

test('stale, missing and raced role removal roll back before clearing grants', async () => {
  const cases = [
    [fixture([{}, userRows(null, [])]), 404],
    [fixture([{}, userRows({ ...row, AccessVersion: Buffer.from('8899aabbccddeeff', 'hex') })]), 409],
    [fixture([{}, userRows(), { rowsAffected: [0] }]), 409]
  ];
  for (const [{ repo, state }, statusCode] of cases) {
    await assert.rejects(repo.removeEmployeeRoles(row.Id, { version }), { statusCode });
    assert.equal(state.rolledBack, true);
    assert.equal(state.committed, false);
    assert.equal(state.calls.some(call => /DELETE FROM pcn.UserRoles/.test(call.query)), false);
  }
});

test('already roleless removal reports conflict without account or session writes', async () => {
  const { repo, state } = fixture([{}, userRows(row, [])]);
  await assert.rejects(repo.removeEmployeeRoles(row.Id, { version }), { statusCode: 409, message: 'This user has no assigned roles' });
  assert.equal(state.calls.some(call => /UPDATE|DELETE|INSERT/.test(call.query)), false);
  assert.equal(state.rolledBack, true);
});

test('removal rechecks caller and protects last active code-based administrator across providers', async () => {
  const revoked = fixture([{}, { recordset: [{ IsActive: false }] }]);
  await assert.rejects(revoked.repo.removeEmployeeRoles(row.Id, { version }, 'user:admin',
    { id: 'admin-id', version, sessionSecurityStamp: 'stamp' }), { statusCode: 401 });
  assert.equal(revoked.state.calls.some(call => /UPDATE pcn.Users/.test(call.query)), false);
  for (const IdentityProvider of ['employee-code', 'pcn-local']) {
    const last = fixture([{}, userRows({ ...row, IdentityProvider }, ['admin']), { recordset: [{ Total: 1 }] }]);
    await assert.rejects(last.repo.removeEmployeeRoles(row.Id, { version }), { statusCode: 409 });
    assert.match(last.state.calls.at(-1).query, /IdentityProvider IN \('employee-code','pcn-local'\)/);
    assert.equal(last.state.rolledBack, true);
    assert.equal(last.state.calls.some(call => /UPDATE pcn.Users/.test(call.query)), false);
  }
});

test('routing and audit errors roll back removal, grants and session changes atomically', async () => {
  const badRouting = fixture([{}, userRows(), {}, {}, {}, { recordset: [{ SettingsJson: '{invalid' }] }]);
  await assert.rejects(badRouting.repo.removeEmployeeRoles(row.Id, { version }), { statusCode: 503 });
  assert.equal(badRouting.state.rolledBack, true);
  assert.equal(badRouting.state.calls.some(call => /INSERT pcn.AuditLogs/.test(call.query)), false);
  const badAudit = fixture([{}, userRows(), {}, {}, {}, {}, {}, new Error('audit unavailable')]);
  await assert.rejects(badAudit.repo.removeEmployeeRoles(row.Id, { version }), /audit unavailable/);
  assert.equal(badAudit.state.rolledBack, true);
  assert.equal(badAudit.state.committed, false);
});
