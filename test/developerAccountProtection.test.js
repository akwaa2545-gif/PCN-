const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../src/authService');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');
const { usersPage, verifiedMail } = require('./helpers/users-page');

const version = '0011223344556677';
const developer = { id: '12345678-1234-1234-1234-123456789abc', roles: ['developer'], department: 'developer', signingStep: null,
  employeeCode: '0012345', username: '0012345', identityProvider: 'employee-code', displayName: 'Developer User',
  isActive: true, version, email: verifiedMail.email, mailDirectoryId: verifiedMail.id,
  mailVerifiedAt: '2026-10-15T00:00:00Z', mailProfile: verifiedMail };
const admin = { id: 'administrator', roles: ['admin'], isActive: true, version, sessionSecurityStamp: 'stamp' };
const developerActor = { ...developer, id: 'developer-actor', sessionSecurityStamp: 'stamp' };
const assignment = { userId: developer.id, roles: ['developer'], department: 'developer', signingStep: null, isActive: true, version };
const protectedAccount = error => error.statusCode === 403 && /only a Developer/i.test(error.message);

function serviceFixture() {
  const calls = [];
  const repository = { async getUserById() { calls.push('read'); return developer; },
    async updateEmployeeAccount(id, account) { calls.push('write'); return { ...developer, ...account }; },
    async removeEmployeeRoles() { calls.push('remove'); return { ...developer, roles: [] }; } };
  return { calls, service: new AuthService(repository, { developerPasswordHash: 'fixture-hash',
    passwordVerifier: async () => { calls.push('password'); return true; } }) };
}

test('Administrator cannot edit, deactivate, demote or remove current Developer before password or persistence', async () => {
  for (const patch of [{}, { isActive: false }, { roles: ['admin'], department: 'it' }]) {
    const { service, calls } = serviceFixture();
    await assert.rejects(service.updateEmployee({ ...assignment, ...patch, developerPassword: 'fixture' }, 'user:administrator', admin), protectedAccount);
    assert.deepEqual(calls, ['read']);
  }
  const { service, calls } = serviceFixture();
  await assert.rejects(service.removeEmployeeRoles({ userId: developer.id, version }, 'user:administrator', admin), protectedAccount);
  assert.deepEqual(calls, ['read']);
});

test('Developer actor retains password gate for edits and may remove another Developer role', async () => {
  const { service, calls } = serviceFixture();
  await assert.rejects(service.updateEmployee(assignment, 'user:developer', developerActor), error => error.code === 'DEVELOPER_PASSWORD_REQUIRED');
  const updated = await service.updateEmployee({ ...assignment, developerPassword: 'fixture' }, 'user:developer', developerActor);
  assert.deepEqual(updated.roles, ['developer']);
  assert.equal(calls.filter(value => value === 'password').length, 1);
  assert.deepEqual((await service.removeEmployeeRoles({ userId: developer.id, version }, 'user:developer', developerActor)).roles, []);
});

function sqlFixture(target = developer) {
  const state = { calls: [], committed: false, rolledBack: false };
  const request = () => {
    const inputs = {};
    return { input(name, type, value) { inputs[name] = value; return this; }, async query(query) {
      state.calls.push({ query, inputs });
      if (/SELECT IsActive,SecurityStamp,AccessVersion/.test(query)) return { recordset: [{ IsActive: true, SecurityStamp: 'stamp', AccessVersion: Buffer.from(version, 'hex') }] };
      return { recordset: [], rowsAffected: [1] };
    } };
  };
  const repository = new SqlAuthRepository({ request, transaction: () => ({ request, async begin() {},
    async commit() { state.committed = true; }, async rollback() { state.rolledBack = true; } }) });
  repository.userQuery = async () => { state.calls.push({ query: 'read-current-target' }); return target; };
  return { repository, state };
}

test('locked SQL guard rejects newly promoted Developer even with stale form/version before any write', async () => {
  for (const removal of [false, true]) for (const actor of [admin, undefined, { ...developerActor, department: 'it' }, { ...developerActor, isActive: false }]) {
    const { repository, state } = sqlFixture({ ...developer, version: '8899aabbccddeeff' });
    const operation = removal ? repository.removeEmployeeRoles(developer.id, { version }, 'user:admin', actor)
      : repository.updateEmployeeAccount(developer.id, { ...developer, roles: ['admin'], department: 'it' }, 'user:admin', actor);
    await assert.rejects(operation, protectedAccount);
    assert.equal(state.calls[0].inputs.mode, 'Exclusive');
    assert.equal(state.calls.some(call => /UPDATE|INSERT|DELETE/.test(call.query)), false);
    assert.equal(state.rolledBack, true);
  }
});

test('locked SQL guard permits valid Developer principal while retaining version conflicts', async () => {
  const success = sqlFixture();
  const updated = await success.repository.removeEmployeeRoles(developer.id, { version }, 'user:developer', developerActor);
  assert.equal(updated.id, developer.id);
  assert.equal(success.state.committed, true);
  const stale = sqlFixture({ ...developer, version: '8899aabbccddeeff' });
  await assert.rejects(stale.repository.removeEmployeeRoles(developer.id, { version }, 'user:developer', developerActor), { statusCode: 409 });
});

test('Administrator sees protected Developer actions; disabled handlers cannot open or remove access', async () => {
  const page = await usersPage([{ ...developer, identityProvider: 'pcn-local' }]);
  const buttons = page.firstUserRow().lastElementChild.firstElementChild.children;
  const edit = buttons.find(button => button.getAttribute('data-user-action') === 'edit');
  const remove = buttons.find(button => button.getAttribute('data-user-action') === 'remove');
  const link = buttons.find(button => button.getAttribute('data-user-action') === 'link');
  for (const button of [edit, remove, link]) {
    assert.equal(button.disabled, true);
    assert.match(button.getAttribute('title'), /only a Developer/i);
    await button.events.click();
  }
  assert.equal(page.element('employeeUserDialog').open, false);
  assert.equal(page.confirmations.length, 0);
  assert.equal(page.calls.some(call => call.options?.method), false);
});

test('Developer viewer can open Developer Edit access and still must enter assignment password', async () => {
  const page = await usersPage([developer], { user: developerActor });
  const buttons = page.firstUserRow().lastElementChild.firstElementChild.children;
  const edit = buttons.find(button => button.getAttribute('data-user-action') === 'edit');
  const remove = buttons.find(button => button.getAttribute('data-user-action') === 'remove');
  assert.equal(edit.disabled, false); assert.equal(remove.disabled, false);
  edit.events.click();
  assert.equal(page.element('employeeUserDialog').open, true);
  assert.equal(page.element('employeeDeveloperPasswordField').hidden, false);
  assert.equal(page.element('employeeCreateButton').disabled, true);
});
