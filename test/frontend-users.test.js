const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function users() {
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'admin-users.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'window.USERS_TEST = { provisioningBody, directoryBody };})();');
  vm.runInNewContext(source, { window, document: { addEventListener() {} } });
  return window.USERS_TEST;
}

const employee = { directoryId: 'ad-guid', employeeCode: 'EMP001', displayName: 'Employee', email: 'employee@example.test' };
test('AD provisioning sends only a selected directory identity and fixed PCN assignments', () => {
  const api = users();
  const body = api.provisioningBody(employee, 'admin', 'it');
  assert.equal(JSON.stringify(body), JSON.stringify({ directoryId: 'ad-guid', roles: ['admin'], department: 'it' }));
  for (const profile of [null, {}, { employeeCode: 'typed' }, { directoryId: 'id' }]) {
    assert.throws(() => api.provisioningBody(profile, 'reviewer', 'qaTet'), /select/i);
  }
  assert.throws(() => api.provisioningBody(employee, 'superuser', 'qaTet'), /role/i);
  assert.throws(() => api.provisioningBody(employee, 'reviewer', 'arbitrary'), /department/i);
});
test('linking an existing user sends directory identity without altering permissions or department', () => {
  assert.equal(JSON.stringify(users().directoryBody(employee)), JSON.stringify({ directoryId: 'ad-guid' }));
});
