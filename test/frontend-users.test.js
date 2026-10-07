const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function users() {
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'admin-users.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'window.USERS_TEST = { provisioningBody, directoryBody, assignmentBody, editBody };})();');
  vm.runInNewContext(source, { window, document: { addEventListener() {} } });
  return window.USERS_TEST;
}

const employee = { employeeCode: '001234', displayName: 'Employee', email: null, sourceDepartment: 'ORG001', jobTitle: 'Engineer', isActive: true };
test('employee provisioning sends the selected employee code and fixed PCN assignments', () => {
  const api = users();
  const body = api.provisioningBody(employee, 'admin', 'it');
  assert.equal(JSON.stringify(body), JSON.stringify({ employeeCode: '001234', roles: ['admin'], department: 'it', signingStep: null }));
  for (const profile of [null, {}, { employeeCode: 'typed' }, { employeeCode: '12345678901', displayName: 'Employee' }, { employeeCode: 'a b', displayName: 'Employee' }]) {
    assert.throws(() => api.provisioningBody(profile, 'approved', 'qaTet'), /select/i);
  }
  assert.throws(() => api.provisioningBody(employee, 'superuser', 'qaTet'), /role/i);
  assert.throws(() => api.provisioningBody(employee, 'approved', 'arbitrary'), /department/i);
});
test('linking an existing user sends employee code without altering permissions or department', () => {
  assert.equal(JSON.stringify(users().directoryBody(employee)), JSON.stringify({ employeeCode: '001234' }));
});

async function usersPage(assignedUsers = [], options = {}) {
  let init;
  const elements = new Map();
  const pendingTimers = new Map();
  const calls = [];
  const confirmations = [];
  function createElement() {
    return {
      value: '', hidden: true, disabled: false, required: false, textContent: '', innerHTML: '', children: [], events: {}, options: [],
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
    for (const id of ['employeeSearch', 'employeeCode', 'employeeRole', 'employeeDepartment', 'employeeMailSearch']) element(id).value = '';
  };
  const window = {
    location: { hash: '#users' }, addEventListener() {}, confirm: (message) => { confirmations.push(message); return pageOptions.confirm !== false; },
    PCN_SESSION: {
      require: async () => ({ authenticated: true, user: { roles: ['admin'] } }),
      async fetch(url, options) {
        calls.push({ url, options });
        if (url === '/api/auth/config') return { mode: 'employee-code', employeeProvisioningConfigured: true };
        if (url.startsWith('/api/admin/employees?')) return [pageOptions.employee || employee];
        if (url.startsWith('/api/admin/directory-users?')) return { users: pageOptions.mailProfiles || [verifiedMail, { ...verifiedMail, id: 'another-id', email: 'another@example.test' }] };
        if (url === '/api/admin/users' && !options) return assignedUsers;
        if (options?.method === 'PATCH' && pageOptions.conflict) { const error = new Error('Conflict'); error.status = 409; throw error; }
        return { id: 'created', ...employee, roles: ['admin'], department: 'it', identityProvider: 'employee-code' };
      }
    }
  };
  const pageOptions = options;
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
  return { element, calls, confirmations, select, async runMailTimer() { await [...pendingTimers.values()].at(-1)?.(); } };
}

test('assigned Users show verified profile photos and identity while unsafe images use initials', async () => {
  const photo = 'data:image/png;base64,YWJj';
  const user = { id: 'employee-id', ...employee, username: employee.employeeCode, roles: ['reviewer'], department: 'qaTet', isActive: true,
    mailProfile: { ...verifiedMail, displayName: 'Mail Person', jobTitle: 'Engineer', department: 'Engineering', photo }, identityProvider: 'employee-code' };
  const page = await usersPage([user]);
  const identity = page.element('adminUsersRows').firstElementChild.children[1].firstElementChild;
  assert.equal(identity.className, 'employee-user-identity');
  const avatar = identity.firstElementChild;
  assert.equal(avatar.firstElementChild.src, photo);
  assert.equal(avatar.firstElementChild.alt, '');
  assert.equal(identity.lastElementChild.children.map(child => child.textContent).join(' '), 'Employee person@example.test Engineer - Engineering');
  avatar.firstElementChild.events.error();
  assert.equal(avatar.textContent, 'E');
  for (const unsafe of ['https://external.example.test/photo.png', 'data:image/svg+xml;base64,YWJj', 'data:image/png;base64,YWJ', `data:image/png;base64,${'A'.repeat(102400)}`, '']) {
    const fallbackPage = await usersPage([{ ...user, mailProfile: { ...user.mailProfile, photo: unsafe } }]);
    const fallback = fallbackPage.element('adminUsersRows').firstElementChild.children[1].firstElementChild.firstElementChild;
    assert.equal(fallback.children.length, 0, unsafe.slice(0, 80));
    assert.equal(fallback.textContent, 'E');
  }
});

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
  assert.equal(call.options.body, JSON.stringify({ employeeCode: '001234', roles: ['admin'], department: 'it', signingStep: null }));
});

const verifiedMail = { id: 'mail-id', email: 'person@example.test', displayName: 'Employee' };
test('four PCN roles derive department authority and require a verified recipient for signing', () => {
  const api = users();
  for (const [department, expectedRole] of Object.entries({gscTet: 'gsc', prodEngTet: 'productionengineering', qaTet: 'qa', gscTapbu: 'tapbu', qaTapbu: 'tapbu'})) {
    for (const role of ['approved', 'checked', 'prepared']) {
      const body = JSON.parse(JSON.stringify(api.provisioningBody(employee, role, department, verifiedMail)));
      assert.deepEqual(body, {employeeCode: '001234', roles: [expectedRole], department, signingStep: role, mailSelection: {id: verifiedMail.id, email: verifiedMail.email}});
      assert.throws(() => api.assignmentBody(role, department), /select.*mail/i);
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(api.assignmentBody('admin', 'it'))), {roles: ['admin'], department: 'it', signingStep: null});
  for (const role of ['', 'reviewer', 'supplier', 'gsc', ['approved', 'checked']]) assert.throws(() => api.assignmentBody(role, 'qaTet', verifiedMail), /role/i);
  assert.throws(() => api.assignmentBody('approved', 'it', verifiedMail), /department/i);
  assert.throws(() => api.assignmentBody('approved', 'qaTet', {email: 'typed@example.test'}), /select/i);
});

test('unrelated edits preserve exact legacy or multiple roles and existing signing assignment', () => {
  const api = users();
  for (const [roles, signingStep, choice] of [[['admin', 'reviewer'], 'checked', 'admin'], [['reviewer','qa'], 'approved', 'approved'], [['supplier'], null, ''], [['gsc'], null, '']]) {
    const user = {roles, department: 'qaTet', signingStep, mailProfile: verifiedMail, version: '0011223344556677'};
    const body = JSON.parse(JSON.stringify(api.editBody(user, choice, 'qaTet', null, false, false)));
    assert.deepEqual(body, {roles, department: 'qaTet', signingStep, isActive: false, version: user.version});
  }
  const user = {roles: ['admin', 'reviewer'], department: 'qaTet', signingStep: 'checked', mailProfile: verifiedMail, version: '0011223344556677'};
  const changed = api.editBody(user, 'prepared', 'gscTet', {id: 'other', email: 'other@example.test'}, true, true);
  assert.equal(JSON.stringify(changed.roles), JSON.stringify(['gsc']));
  assert.equal(changed.signingStep, 'prepared');
  assert.equal(changed.mailSelection.email, 'other@example.test');
  assert.equal(api.editBody(user, 'admin', 'it', null, true, true, false).mailSelection, null);
  assert.throws(() => api.editBody({...user,version:null}, 'admin', 'it', null, true, false), /reload/i);
});

test('English-name lookup never guesses a mail identity and typing invalidates a confirmed result', async () => {
  const page = await usersPage([], { employee: { ...employee, displayName: 'Local name', englishName: 'Employee' } });
  page.element('employeeRole').value = 'checked';
  page.element('employeeDepartment').value = 'qaTet';
  await page.select();
  await new Promise(setImmediate);
  assert.equal(page.calls.find((call) => call.url.startsWith('/api/admin/directory-users?')).url, '/api/admin/directory-users?query=Employee');
  assert.equal(page.element('employeeMailResults').children.length, 2);
  assert.equal(page.element('employeeCreateButton').disabled, true, 'Even duplicate-name candidates require confirmation');
  page.element('employeeMailResults').firstElementChild.events.click();
  assert.equal(page.element('employeeCreateButton').disabled, false);
  assert.match(page.element('employeeRoutePreview').textContent, /qaTet.*checked.*person@example.test/);
  page.element('employeeMailSearch').value = 'typed@example.test';
  page.element('employeeMailSearch').events.input();
  assert.equal(page.element('employeeCreateButton').disabled, true);
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  assert.equal(page.calls.filter((call) => call.options?.method === 'POST').length, 0);
  await page.runMailTimer();
  page.element('employeeMailResults').children[1].events.click();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const write = page.calls.find((call) => call.options?.method === 'POST');
  assert.deepEqual(JSON.parse(write.options.body).mailSelection, { id: 'another-id', email: 'another@example.test' });
});

test('mail results without a usable directory identity cannot be confirmed and explain the disabled create action', async () => {
  const page = await usersPage([], { mailProfiles: [
    { ...verifiedMail, id: '' }, { ...verifiedMail, id: '   ' }, { ...verifiedMail, id: 123 },
    { ...verifiedMail, id: 'a'.repeat(201) }, { ...verifiedMail, email: 'invalid-address' }
  ] });
  page.element('employeeRole').value = 'approved';
  page.element('employeeDepartment').value = 'gscTet';
  await page.select();
  await new Promise(setImmediate);
  assert.equal(page.element('employeeMailResults').children.length, 0);
  assert.equal(page.element('employeeMailResults').hidden, true);
  assert.equal(page.element('employeeMailSelected').textContent, '');
  assert.equal(page.element('employeeCreateButton').disabled, true);
  assert.match(page.element('employeeMailStatus').textContent, /valid directory identity/i);
  assert.match(page.element('employeeRoutePreview').textContent, /Select a mail recipient for this PCN role/);
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  assert.equal(page.calls.filter((call) => call.options?.method === 'POST').length, 0);
});

test('a confirmed deterministic directory identity enables and submits the GSC signing assignment', async () => {
  const mail = { ...verifiedMail, id: `directory-email:${'a'.repeat(64)}` };
  const page = await usersPage([], { mailProfiles: [{ ...mail, id: '' }, mail] });
  page.element('employeeRole').value = 'approved';
  page.element('employeeDepartment').value = 'gscTet';
  await page.select();
  await new Promise(setImmediate);
  assert.equal(page.element('employeeMailResults').children.length, 1);
  assert.equal(page.element('employeeCreateButton').disabled, true);
  page.element('employeeMailResults').firstElementChild.events.click();
  assert.equal(page.element('employeeCreateButton').disabled, false);
  assert.match(page.element('employeeMailSelected').textContent, /Confirmed:/);
  assert.match(page.element('employeeRoutePreview').textContent, /gscTet.*approved.*person@example.test/);
  page.element('employeeDepartment').value = 'it';
  page.element('employeeDepartment').events.change();
  assert.equal(page.element('employeeCreateButton').disabled, true);
  assert.match(page.element('employeeRoutePreview').textContent, /Select a signing department/);
  page.element('employeeDepartment').value = 'gscTet';
  page.element('employeeDepartment').events.change();
  assert.equal(page.element('employeeCreateButton').disabled, false);
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const write = page.calls.find((call) => call.options?.method === 'POST');
  assert.deepEqual(JSON.parse(write.options.body), {
    employeeCode: '001234', roles: ['gsc'], department: 'gscTet', signingStep: 'approved',
    mailSelection: { id: mail.id, email: mail.email }
  });
});

test('an explicitly missing English name requires manual mail search rather than a name guess', async () => {
  const page = await usersPage([], { employee: { ...employee, englishName: '' } });
  await page.select();
  assert.equal(page.calls.filter((call) => call.url.startsWith('/api/admin/directory-users?')).length, 0);
  assert.match(page.element('employeeMailStatus').textContent, /No English name/);
});

test('editing active status carries concurrency and retains a conflicted draft until cancel', async () => {
  const existing = { id: 'employee-id', ...employee, username: employee.employeeCode, roles: ['admin', 'reviewer'], department: 'qaTet', signingStep: 'checked', mailProfile: verifiedMail, identityProvider: 'employee-code', version: '0011223344556677' };
  const page = await usersPage([existing], { conflict: true });
  page.element('adminUsersRows').firstElementChild.lastElementChild.firstElementChild.events.click();
  assert.equal(page.element('employeeSearch').disabled, true);
  page.element('employeeActive').checked = false;
  page.element('employeeActive').events.change();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const write = page.calls.find((call) => call.options?.method === 'PATCH');
  assert.deepEqual(JSON.parse(write.options.body), { roles: ['admin', 'reviewer'], department: 'qaTet', signingStep: 'checked', isActive: false, version: existing.version });
  assert.match(page.element('usersMessage').textContent, /Your edit is kept/);
  assert.equal(page.element('employeeRole').value, 'admin');
  page.element('employeeCancelButton').events.click();
  assert.equal(page.element('employeeFormTitle').textContent, 'Create employee user');
  assert.equal(page.calls.filter((call) => call.options?.method === 'PATCH').length, 1);
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

test('explicit Administrator removal requires confirmation and cancellation retains the draft', async () => {
  const existing = {id:'employee-id', ...employee, roles:['admin','reviewer'], department:'qaTet', signingStep:'checked', mailProfile:verifiedMail, isActive:true, identityProvider:'employee-code', version:'0011223344556677'};
  for (const accept of [false,true]) {
    const page = await usersPage([existing], {confirm:accept});
    page.element('adminUsersRows').firstElementChild.lastElementChild.firstElementChild.events.click();
    assert.match(page.element('employeeRoleHelp').textContent, /preserved.*checked/i);
    page.element('employeeRole').value='prepared'; page.element('employeeRole').events.change();
    assert.match(page.element('employeeRoutePreview').textContent, /qa.*prepared/i);
    assert.match(page.element('employeeRoleHelp').textContent, /will replace.*when saved/);
    assert.doesNotMatch(page.element('employeeRoleHelp').textContent, /are preserved/);
    await page.element('employeeUserForm').events.submit({preventDefault(){}});
    assert.equal(page.confirmations.length,1);
    assert.match(page.confirmations[0], /remove Administrator/i);
    const writes = page.calls.filter(call => call.options?.method === 'PATCH');
    assert.equal(writes.length,accept ? 1 : 0);
    if (accept) assert.deepEqual(JSON.parse(writes[0].options.body).roles,['qa']);
    else assert.equal(page.element('employeeRole').value,'prepared');
  }
});

test('blank legacy PCN role remains editable without granting signing and explicit changes require a choice', async () => {
  const existing={id:'employee-id',...employee,roles:['supplier'],department:'qaTet',signingStep:null,isActive:true,identityProvider:'employee-code',version:'0011223344556677'};
  const page=await usersPage([existing]);
  page.element('adminUsersRows').firstElementChild.lastElementChild.firstElementChild.events.click();
  assert.equal(page.element('employeeRole').value,'');
  assert.equal(page.element('employeeRole').required,false);
  assert.equal(page.element('employeeCreateButton').disabled,false);
  assert.match(page.element('employeeRoleHelp').textContent,/Requester.*preserved/i);
  page.element('employeeDepartment').value='gscTet'; page.element('employeeDepartment').events.change();
  assert.equal(page.element('employeeCreateButton').disabled,true);
  assert.match(page.element('employeeRoutePreview').textContent,/Select a PCN role/);
});

test('department changes deliberately derive signing access while Administrator changes clear signing', async () => {
  const existing={id:'employee-id',...employee,roles:['reviewer','qa'],department:'qaTet',signingStep:'checked',mailProfile:verifiedMail,isActive:true,identityProvider:'employee-code',version:'0011223344556677'};
  const page=await usersPage([existing]);
  page.element('adminUsersRows').firstElementChild.lastElementChild.firstElementChild.events.click();
  page.element('employeeDepartment').value='prodEngTet'; page.element('employeeDepartment').events.change();
  assert.match(page.element('employeeRoutePreview').textContent,/Access: Production engineering/);
  await page.element('employeeUserForm').events.submit({preventDefault(){}});
  const write=page.calls.find(call=>call.options?.method==='PATCH');
  assert.deepEqual(JSON.parse(write.options.body),{roles:['productionengineering'],department:'prodEngTet',signingStep:'checked',isActive:true,version:existing.version});
  assert.equal(page.confirmations.length,0);
  const admin=await usersPage([existing]);
  admin.element('adminUsersRows').firstElementChild.lastElementChild.firstElementChild.events.click();
  admin.element('employeeRole').value='admin'; admin.element('employeeRole').events.change();
  admin.element('employeeDepartment').value='it'; admin.element('employeeDepartment').events.change();
  assert.match(admin.element('employeeRoutePreview').textContent,/Administrator.*not added to a signing mail list/);
  await admin.element('employeeUserForm').events.submit({preventDefault(){}});
  assert.deepEqual(JSON.parse(admin.calls.find(call=>call.options?.method==='PATCH').options.body),{roles:['admin'],department:'it',signingStep:null,isActive:true,version:existing.version});
});
