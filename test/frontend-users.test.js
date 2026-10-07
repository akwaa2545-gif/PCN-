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

const employee = { employeeCode: '001234', displayName: 'Employee', email: null, sourceDepartment: 'ORG001', jobTitle: 'Engineer', isActive: true };
test('employee provisioning sends the selected employee code and fixed PCN assignments', () => {
  const api = users();
  const body = api.provisioningBody(employee, 'admin', 'it');
  assert.equal(JSON.stringify(body), JSON.stringify({ employeeCode: '001234', roles: ['admin'], department: 'it' }));
  for (const profile of [null, {}, { employeeCode: 'typed' }, { employeeCode: '12345678901', displayName: 'Employee' }, { employeeCode: 'a b', displayName: 'Employee' }]) {
    assert.throws(() => api.provisioningBody(profile, 'reviewer', 'qaTet'), /select/i);
  }
  assert.throws(() => api.provisioningBody(employee, 'superuser', 'qaTet'), /role/i);
  assert.throws(() => api.provisioningBody(employee, 'reviewer', 'arbitrary'), /department/i);
});
test('linking an existing user sends employee code without altering permissions or department', () => {
  assert.equal(JSON.stringify(users().directoryBody(employee)), JSON.stringify({ employeeCode: '001234' }));
});

async function usersPage(assignedUsers = []) {
  let init;
  const elements = new Map();
  const pendingTimers = new Map();
  const calls = [];
  function createElement() {
    return {
      value: '', hidden: true, disabled: false, required: false, textContent: '', children: [], events: {}, options: [],
      addEventListener(name, handler) { this.events[name] = handler; }, setAttribute() {}, focus() { this.focused = true; },
      replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); },
      querySelectorAll() { return this.children; },
      get firstElementChild() { return this.children[0]; }, get lastElementChild() { return this.children.at(-1); }
    };
  }
  function element(id) {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  }
  element('employeeUserForm').reset = () => {
    for (const id of ['employeeSearch', 'employeeCode', 'employeeRole', 'employeeDepartment']) element(id).value = '';
  };
  const window = {
    location: { hash: '#users' }, addEventListener() {}, confirm: () => true,
    PCN_SESSION: {
      require: async () => ({ authenticated: true, user: { roles: ['admin'] } }),
      async fetch(url, options) {
        calls.push({ url, options });
        if (url === '/api/auth/config') return { mode: 'employee-code', employeeProvisioningConfigured: true };
        if (url.startsWith('/api/admin/employees?')) return [employee];
        if (url === '/api/admin/users' && !options) return assignedUsers;
        return { id: 'created', ...employee, roles: ['admin'], department: 'it', identityProvider: 'employee-code' };
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'admin-users.js'), 'utf8'), {
    window, AbortController,
    document: {
      getElementById: element, createElement, addEventListener(name, handler) { if (name === 'DOMContentLoaded') init = handler; }
    },
    setTimeout(callback) { const id = pendingTimers.size + 1; pendingTimers.set(id, callback); return id; },
    clearTimeout(id) { pendingTimers.delete(id); }
  });
  await init();
  async function select() {
    element('employeeSearch').value = '001';
    element('employeeSearch').events.input();
    const timer = [...pendingTimers.values()].at(-1);
    assert.ok(timer, 'employee input starts lookup');
    await timer();
    element('employeeResults').firstElementChild.events.click();
  }
  return { element, calls, select };
}

test('employee creation requires selecting a lookup result and editing search clears that selection', async () => {
  const page = await usersPage();
  const submit = () => page.element('employeeUserForm').events.submit({ preventDefault() {} });
  page.element('employeeRole').value = 'admin';
  page.element('employeeDepartment').value = 'it';
  assert.equal(page.element('employeeCreateButton').disabled, true);
  await submit();
  assert.equal(page.calls.filter((call) => call.options?.method === 'POST').length, 0);
  await page.select();
  assert.equal(page.element('employeeCode').value, '001234');
  assert.match(page.element('employeeProfile').textContent, /Engineer.*Organization: ORG001/);
  assert.equal(page.element('employeeCreateButton').disabled, false);
  page.element('employeeSearch').value = 'a different employee';
  page.element('employeeSearch').events.input();
  assert.equal(page.element('employeeCode').value, '');
  assert.equal(page.element('employeeCreateButton').disabled, true);
  await submit();
  assert.equal(page.calls.filter((call) => call.options?.method === 'POST').length, 0);
  await page.select();
  await submit();
  const call = page.calls.find((entry) => entry.options?.method === 'POST');
  assert.equal(call.url, '/api/admin/users');
  assert.equal(call.options.body, JSON.stringify({ employeeCode: '001234', roles: ['admin'], department: 'it' }));
});

test('an existing retired administrator can be linked using only the selected employee code', async () => {
  const page = await usersPage([{ id: 'old-admin', username: 'former-admin', displayName: 'Existing Admin', identityProvider: 'retired-windows', roles: ['admin'], department: 'it', isActive: true }]);
  const row = page.element('adminUsersRows').firstElementChild;
  const button = row.lastElementChild.firstElementChild;
  assert.equal(button.textContent, 'Link employee');
  assert.equal(button.disabled, false);
  button.events.click();
  assert.equal(page.element('employeeAssignments').hidden, true);
  assert.match(page.element('employeeFormTitle').textContent, /Existing Admin/);
  await page.select();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const call = page.calls.find((entry) => entry.options?.method === 'POST');
  assert.equal(call.url, '/api/admin/users/old-admin/employee');
  assert.equal(call.options.body, JSON.stringify({ employeeCode: '001234' }));
});
