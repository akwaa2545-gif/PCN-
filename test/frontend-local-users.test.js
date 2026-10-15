const test = require('node:test');
const assert = require('node:assert/strict');
const { usersPage, employee, verifiedMail } = require('./helpers/users-page');

function identity(page, code = '1234567', name = 'New Employee') {
  page.element('employeeManualCode').value = code;
  page.element('employeeManualCode').events.input();
  page.element('employeeManualName').value = name;
  page.element('employeeManualName').events.input();
}
function assignment(page, role = 'admin', department = 'it') {
  page.element('employeeRole').value = role;
  page.element('employeeRole').events.change();
  page.element('employeeDepartment').value = department;
  page.element('employeeDepartment').events.change();
}
const submit = page => page.element('employeeUserForm').events.submit({ preventDefault() {} });

test('Create user opens manual identity with role selection and validates seven digit code and name', async () => {
  const page = await usersPage(); page.openManual();
  assert.equal(page.element('employeeFormTitle').textContent, 'Create user');
  assert.equal(page.element('employeeCreateButton').textContent, 'Create user');
  assert.equal(page.element('employeeManualFields').hidden, false);
  assert.equal(page.element('employeeDirectoryFields').hidden, true);
  assert.equal(page.element('employeeAssignments').hidden, false);
  assert.equal(page.document.activeElement, page.element('employeeManualCode'));
  assignment(page);
  for (const [code, name] of [['123456', 'Name'], ['12345678', 'Name'], ['12a4567', 'Name'], ['1234567', '  ']]) {
    identity(page, code, name);
    assert.equal(page.element('employeeCreateButton').disabled, true);
    await submit(page);
  }
  assert.equal(page.calls.filter(call => call.options?.method === 'POST').length, 0);
  identity(page, '0123456', ' New Employee ');
  assert.equal(page.element('employeeCreateButton').disabled, false);
  await submit(page);
  const write = page.calls.find(call => call.options?.method === 'POST');
  assert.equal(write.url, '/api/admin/local-users');
  assert.deepEqual(JSON.parse(write.options.body), { employeeCode: '0123456', displayName: 'New Employee', roles: ['admin'], department: 'it', signingStep: null });
  assert.equal(page.element('employeeUserDialog').open, false);
  assert.equal(page.document.activeElement, page.element('usersCreateButton'));
});

test('manual signing account requires verified mail and debounces full name search without selection', async () => {
  const page = await usersPage(); page.openManual(); identity(page); assignment(page, 'checked', 'qaTet');
  assert.equal(page.element('employeeCreateButton').disabled, true);
  assert.equal(page.element('employeeMailLoading').hidden, false);
  await page.runMailTimer();
  assert.equal(page.element('employeeMailSelected').textContent, '');
  page.element('employeeMailResults').firstElementChild.events.click();
  assert.equal(page.element('employeeCreateButton').disabled, false);
  await submit(page);
  assert.deepEqual(JSON.parse(page.calls.find(call => call.options?.method === 'POST').options.body), {
    employeeCode: '1234567', displayName: 'New Employee', roles: ['qa'], department: 'qaTet', signingStep: 'checked', mailSelection: { id: verifiedMail.id, email: verifiedMail.email }
  });
});

test('manual names retain 200 characters while automatic mail queries stay bounded to 100', async () => {
  const page = await usersPage(); page.openManual();
  const fullName = 'Employee '.repeat(22).slice(0, 200).trim();
  identity(page, '1234567', fullName); assignment(page);
  assert.equal(page.element('employeeCreateButton').disabled, false);
  await page.runMailTimer();
  const lookup = page.calls.find(call => call.url.startsWith('/api/admin/directory-users?'));
  assert.equal(new URL(lookup.url, 'http://localhost').searchParams.get('query').length, 100);
  await submit(page);
  assert.equal(JSON.parse(page.calls.find(call => call.options?.method === 'POST').options.body).displayName, fullName);
  page.openManual(); identity(page, '1234567', 'A'.repeat(201)); assignment(page);
  assert.equal(page.element('employeeCreateButton').disabled, true);
});

test('manual identity edits cancel stale mail results and Cancel resets all fields', async () => {
  let release; let signal;
  const page = await usersPage([], { fetch(url, options) {
    if (url.startsWith('/api/admin/directory-users?')) { signal = options.signal; return new Promise(resolve => { release = resolve; }); }
  } });
  page.openManual(); identity(page); const pending = page.runMailTimer();
  identity(page, '7654321', 'Changed Person');
  assert.equal(signal.aborted, true);
  release({ users: [verifiedMail] }); await pending;
  assert.equal(page.element('employeeMailResults').children.length, 0);
  page.element('employeeCancelButton').events.click();
  assert.equal(page.element('employeeManualCode').value, '');
  assert.equal(page.element('employeeManualName').value, '');
  assert.equal(page.element('employeeMailLoading').hidden, true);
  page.openCreate();
  assert.equal(page.element('employeeFormTitle').textContent, 'Add role');
  assert.equal(page.element('employeeManualFields').hidden, true);
});

test('manual server error retains draft and disables controls while saving', async () => {
  let reject; const page = await usersPage([], { fetch(url) {
    if (url === '/api/admin/local-users') return new Promise((resolve, fail) => { reject = fail; });
  } });
  page.openManual(); identity(page); assignment(page); const pending = submit(page);
  assert.equal(page.element('employeeManualCode').disabled, true);
  assert.equal(page.element('employeeManualName').disabled, true);
  assert.equal(page.element('usersAddRoleButton').disabled, true);
  const conflict = new Error('Employee code already exists.'); conflict.status = 409;
  reject(conflict); await pending;
  assert.equal(page.element('employeeUserDialog').open, true);
  assert.equal(page.element('employeeManualCode').value, '1234567');
  assert.match(page.element('employeeDialogMessage').textContent, /already exists/);
  assert.equal(page.element('employeeManualName').disabled, false);
});

test('Add role finds existing local users and edits exact existing access instead of creating a duplicate', async () => {
  const local = { id: 'local-id', ...employee, employeeCode: '1234567', displayName: 'Local Person', identityProvider: 'pcn-local', roles: [], department: null, mailProfile: verifiedMail, isActive: true, version: '0011223344556677' };
  const page = await usersPage([local], { fetch(url) { if (url.startsWith('/api/admin/employees?')) return []; } });
  page.openCreate(); page.element('employeeSearch').value = 'Local'; page.element('employeeSearch').events.input(); await page.runMailTimer();
  assert.equal(page.element('employeeResults').children.length, 1);
  page.element('employeeResults').firstElementChild.events.click(); assignment(page); await submit(page);
  const write = page.calls.find(call => call.options?.method === 'PATCH');
  assert.equal(write.url, '/api/admin/users/local-id');
  assert.equal(page.calls.some(call => call.options?.method === 'POST'), false);
  assert.equal(page.firstUserRow().children[7].textContent, 'Employee code');
});

test('unconfigured source still permits Add role for cached PCN accounts without directory requests', async () => {
  const local = { id: 'local-id', ...employee, employeeCode: '1234567', displayName: 'Local Person', identityProvider: 'pcn-local', roles: [], department: null, mailProfile: verifiedMail, isActive: true, version: '0011223344556677' };
  const page = await usersPage([local], { configured: false });
  assert.equal(page.element('usersAddRoleButton').disabled, false);
  assert.equal(page.element('usersCreateButton').disabled, true);
  page.openCreate();
  assert.equal(page.element('employeeSearch').disabled, false);
  page.element('employeeSearch').value = 'Local'; page.element('employeeSearch').events.input(); await page.runMailTimer();
  assert.equal(page.calls.some(call => call.url.startsWith('/api/admin/employees?')), false);
  assert.equal(page.element('employeeResults').children.length, 1);
  page.element('employeeResults').firstElementChild.events.click(); assignment(page); await submit(page);
  assert.equal(page.calls.find(call => call.options?.method === 'PATCH').url, '/api/admin/users/local-id');
  assert.equal(page.calls.some(call => call.options?.method === 'POST'), false);
});

test('Link employee searches only the source and both new buttons require configuration', async () => {
  const local = { id: 'local-id', ...employee, employeeCode: '1234567', displayName: 'Local Person', identityProvider: 'pcn-local', roles: [], department: null, mailProfile: verifiedMail, isActive: true, version: '0011223344556677' };
  const page = await usersPage([local], { fetch(url) { if (url.startsWith('/api/admin/employees?')) return []; } });
  page.firstUserRow().lastElementChild.firstElementChild.firstElementChild.events.click();
  page.element('employeeSearch').value = 'Local'; page.element('employeeSearch').events.input(); await page.runMailTimer();
  assert.equal(page.element('employeeResults').children.length, 0);
  const unavailable = await usersPage([], { configured: false });
  unavailable.openManual(); unavailable.openCreate();
  assert.equal(unavailable.element('usersCreateButton').disabled, true);
  assert.equal(unavailable.element('usersAddRoleButton').disabled, true);
  assert.equal(unavailable.element('employeeUserDialog').open, false);
});
