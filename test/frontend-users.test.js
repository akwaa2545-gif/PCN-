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

const { usersPage, employee, verifiedMail } = require('./helpers/users-page');
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

test('assigned Users show verified profile photos and identity while unsafe images use initials', async () => {
  const photo = 'data:image/png;base64,YWJj';
  const user = { id: 'employee-id', ...employee, username: employee.employeeCode, roles: ['reviewer'], department: 'qaTet', isActive: true,
    mailProfile: { ...verifiedMail, displayName: 'Mail Person', jobTitle: 'Engineer', department: 'Engineering', photo }, identityProvider: 'employee-code' };
  const page = await usersPage([user]);
  const identity = page.firstUserRow().children[1].firstElementChild;
  assert.equal(identity.className, 'employee-user-identity');
  const avatar = identity.firstElementChild;
  assert.equal(avatar.firstElementChild.src, photo);
  assert.equal(avatar.firstElementChild.alt, '');
  assert.equal(identity.lastElementChild.children.map(child => child.textContent).join(' '), 'Employee person@example.test Engineer - Engineering');
  avatar.firstElementChild.events.error();
  assert.equal(avatar.textContent, 'E');
  for (const unsafe of ['https://external.example.test/photo.png', 'data:image/svg+xml;base64,YWJj', 'data:image/png;base64,YWJ', `data:image/png;base64,${'A'.repeat(102400)}`, '']) {
    const fallbackPage = await usersPage([{ ...user, mailProfile: { ...user.mailProfile, photo: unsafe } }]);
    const fallback = fallbackPage.firstUserRow().children[1].firstElementChild.firstElementChild;
    assert.equal(fallback.children.length, 0, unsafe.slice(0, 80));
    assert.equal(fallback.textContent, 'E');
  }
});

test('employee creation requires selecting a lookup result and editing search clears that selection', async () => {
  const page = await usersPage();
  page.openCreate();
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

test('selecting an unassigned employee opens role assignment instead of creating a duplicate', async () => {
  const existing = { id: 'viewer-id', ...employee, username: employee.employeeCode, roles: [], department: null,
    signingStep: null, mailProfile: verifiedMail, identityProvider: 'employee-code', version: '0011223344556677' };
  const page = await usersPage([existing]);
  page.openCreate();
  await page.select();
  assert.equal(page.element('employeeFormTitle').textContent, 'Edit access');
  assert.match(page.element('employeeSearchStatus').textContent, /already has an account/);
  page.element('employeeRole').value = 'admin';
  page.element('employeeRole').events.change();
  page.element('employeeDepartment').value = 'it';
  page.element('employeeDepartment').events.change();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  assert.equal(page.calls.filter((call) => call.options?.method === 'POST').length, 0);
  const write = page.calls.find((call) => call.options?.method === 'PATCH');
  assert.equal(write.url, '/api/admin/users/viewer-id');
  assert.deepEqual(JSON.parse(write.options.body), { roles: ['admin'], department: 'it', signingStep: null,
    isActive: true, version: existing.version });
});


test('PCN roles derive department authority and require a verified recipient for signing', () => {
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
  assert.throws(() => api.editBody(user, 'admin', 'it', null, true, true, false), /verified work email/i);
  assert.throws(() => api.editBody({...user,version:null}, 'admin', 'it', null, true, false), /reload/i);
});

test('Edit access requires a verified recipient even for Administrator or legacy accounts without signing', async () => {
  for (const [roles, mailProfile] of [[['admin'], null], [['reviewer'], { email: verifiedMail.email }]]) {
    const existing = { id: 'employee-id', ...employee, roles, department: 'it', signingStep: null,
      email: 'typed@example.test', mailProfile, isActive: true, identityProvider: 'employee-code', version: '0011223344556677' };
    const page = await usersPage([existing]);
    page.firstUserRow().lastElementChild.firstElementChild.firstElementChild.events.click();
    assert.equal(page.element('employeeCreateButton').disabled, true);
    assert.equal(page.element('employeeMailSelected').textContent, '');
    await page.element('employeeUserForm').events.submit({ preventDefault() {} });
    assert.equal(page.calls.some(call => call.options?.method === 'PATCH'), false);
    page.element('employeeMailSearch').value = verifiedMail.email;
    page.element('employeeMailSearch').events.input();
    assert.equal(page.element('employeeCreateButton').disabled, true);
    await page.runMailTimer();
    assert.equal(page.element('employeeCreateButton').disabled, true);
    page.element('employeeMailResults').firstElementChild.events.click();
    assert.equal(page.element('employeeCreateButton').disabled, false);
    await page.element('employeeUserForm').events.submit({ preventDefault() {} });
    assert.deepEqual(JSON.parse(page.calls.find(call => call.options?.method === 'PATCH').options.body).mailSelection,
      { id: verifiedMail.id, email: verifiedMail.email });
  }
});

test('Edit access retains a verified saved profile but typing the same address requires selecting it again', async () => {
  const existing = { id: 'employee-id', ...employee, roles: ['admin'], department: 'it', signingStep: null,
    mailProfile: verifiedMail, isActive: true, identityProvider: 'employee-code', version: '0011223344556677' };
  const page = await usersPage([existing]);
  page.firstUserRow().lastElementChild.firstElementChild.firstElementChild.events.click();
  assert.equal(page.element('employeeCreateButton').disabled, false);
  assert.match(page.element('employeeMailSelected').textContent, /Confirmed/);
  page.element('employeeMailSearch').value = verifiedMail.email; page.element('employeeMailSearch').events.input();
  assert.equal(page.element('employeeCreateButton').disabled, true);
  await page.runMailTimer();
  assert.equal(page.element('employeeCreateButton').disabled, true);
  page.element('employeeMailResults').firstElementChild.events.click();
  assert.equal(page.element('employeeCreateButton').disabled, false);
});

test('English-name lookup never guesses a mail identity and typing invalidates a confirmed result', async () => {
  const page = await usersPage([], { employee: { ...employee, displayName: 'Local name', englishName: 'Employee' } });
  page.openCreate();
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
  page.openCreate();
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
  page.openCreate();
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
  page.openCreate();
  await page.select();
  assert.equal(page.calls.filter((call) => call.url.startsWith('/api/admin/directory-users?')).length, 0);
  assert.match(page.element('employeeMailStatus').textContent, /No English name/);
});

test('editing active status carries concurrency and retains a conflicted draft until cancel', async () => {
  const existing = { id: 'employee-id', ...employee, username: employee.employeeCode, roles: ['admin', 'reviewer'], department: 'qaTet', signingStep: 'checked', mailProfile: verifiedMail, identityProvider: 'employee-code', version: '0011223344556677' };
  const page = await usersPage([existing], { conflict: true });
  page.firstUserRow().lastElementChild.firstElementChild.firstElementChild.events.click();
  assert.equal(page.element('employeeSearch').disabled, true);
  page.element('employeeActive').checked = false;
  page.element('employeeActive').events.change();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const write = page.calls.find((call) => call.options?.method === 'PATCH');
  assert.deepEqual(JSON.parse(write.options.body), { roles: ['admin', 'reviewer'], department: 'qaTet', signingStep: 'checked', isActive: false, version: existing.version });
  assert.match(page.element('employeeDialogMessage').textContent, /Your edit is kept/);
  assert.equal(page.element('employeeUserDialog').open, true);
  assert.equal(page.element('employeeRole').value, 'admin');
  page.element('employeeCancelButton').events.click();
  assert.equal(page.element('employeeFormTitle').textContent, 'Add role');
  assert.equal(page.calls.filter((call) => call.options?.method === 'PATCH').length, 1);
});

test('an existing retired administrator can be linked using only the selected employee code', async () => {
  const page = await usersPage([{ id: 'old-admin', username: 'former-admin', displayName: 'Existing Admin', identityProvider: 'retired-windows', roles: ['admin'], department: 'it', isActive: true }]);
  const row = page.firstUserRow();
  const button = row.lastElementChild.firstElementChild.firstElementChild;
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
    page.firstUserRow().lastElementChild.firstElementChild.firstElementChild.events.click();
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
  const existing={id:'employee-id',...employee,roles:['supplier'],department:'qaTet',signingStep:null,mailProfile:verifiedMail,isActive:true,identityProvider:'employee-code',version:'0011223344556677'};
  const page=await usersPage([existing]);
  page.firstUserRow().lastElementChild.firstElementChild.firstElementChild.events.click();
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
  page.firstUserRow().lastElementChild.firstElementChild.firstElementChild.events.click();
  page.element('employeeDepartment').value='prodEngTet'; page.element('employeeDepartment').events.change();
  assert.match(page.element('employeeRoutePreview').textContent,/Access: Production engineering/);
  await page.element('employeeUserForm').events.submit({preventDefault(){}});
  const write=page.calls.find(call=>call.options?.method==='PATCH');
  assert.deepEqual(JSON.parse(write.options.body),{roles:['productionengineering'],department:'prodEngTet',signingStep:'checked',isActive:true,version:existing.version});
  assert.equal(page.confirmations.length,0);
  const admin=await usersPage([existing]);
  admin.firstUserRow().lastElementChild.firstElementChild.firstElementChild.events.click();
  admin.element('employeeRole').value='admin'; admin.element('employeeRole').events.change();
  admin.element('employeeDepartment').value='it'; admin.element('employeeDepartment').events.change();
  assert.match(admin.element('employeeRoutePreview').textContent,/Administrator.*not added to a signing mail list/);
  await admin.element('employeeUserForm').events.submit({preventDefault(){}});
  assert.deepEqual(JSON.parse(admin.calls.find(call=>call.options?.method==='PATCH').options.body),{roles:['admin'],department:'it',signingStep:null,isActive:true,version:existing.version});
});

test('Create user opens a fresh modal, focuses employee search and Cancel restores its opener', async () => {
  const page = await usersPage();
  const dialog = page.element('employeeUserDialog');
  const opener = page.element('usersAddRoleButton');
  assert.equal(dialog.open, false, 'user list starts with no modal');
  assert.equal(opener.disabled, false);
  page.openCreate();
  assert.equal(dialog.open, true);
  assert.equal(page.document.activeElement, page.element('employeeSearch'));
  page.element('employeeRole').value = 'admin';
  page.element('employeeDepartment').value = 'it';
  await page.select();
  page.element('employeeCancelButton').events.click();
  assert.equal(dialog.open, false);
  assert.equal(page.document.activeElement, opener);
  assert.equal(page.calls.filter(call => call.options?.method === 'POST').length, 0);
  page.openCreate();
  assert.equal(page.element('employeeCode').value, '');
  assert.equal(page.element('employeeRole').value, '');
  assert.equal(page.element('employeeDepartment').value, '');
  assert.equal(page.element('employeeMailSelected').textContent, '');
  assert.equal(page.element('employeeCreateButton').disabled, true);
  page.element('employeeDialogCloseButton').events.click();
  assert.equal(dialog.open, false);
  assert.equal(page.document.activeElement, opener);
});

test('unconfigured directory and unauthorized sessions cannot open the Create user modal', async () => {
  for (const options of [{ configured: false }, { unauthorized: true }]) {
    const page = await usersPage([], options);
    assert.equal(page.element('usersAddRoleButton').disabled, true);
    page.openCreate();
    assert.equal(page.element('employeeUserDialog').open, false);
    assert.equal(page.calls.filter(call => call.options?.method === 'POST').length, 0);
  }
});

test('successful creation closes its modal and shows the new user in the refreshed table', async () => {
  const page = await usersPage();
  page.openCreate();
  page.element('employeeRole').value = 'admin';
  page.element('employeeDepartment').value = 'it';
  await page.select();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  assert.equal(page.element('employeeUserDialog').open, false);
  assert.equal(page.document.activeElement, page.element('usersAddRoleButton'));
  assert.equal(page.element('adminUsersRows').children.length, 1);
  assert.match(page.element('usersMessage').textContent, /created/i);
});

test('Edit and Link row actions open the shared modal with their correct mode and restore row focus', async () => {
  const user = { id: 'employee-id', ...employee, username: employee.employeeCode, roles: ['admin'], department: 'it',
    isActive: true, identityProvider: 'employee-code', version: '0011223344556677' };
  const page = await usersPage([user]);
  const edit = page.firstUserRow().lastElementChild.firstElementChild.firstElementChild;
  edit.focus(); edit.events.click();
  assert.equal(page.element('employeeUserDialog').open, true);
  assert.equal(page.element('employeeFormTitle').textContent, 'Edit access');
  assert.equal(page.element('employeeRole').value, 'admin');
  assert.equal(page.element('employeeDepartment').value, 'it');
  assert.equal(page.document.activeElement, page.element('employeeRole'));
  page.element('employeeDialogCloseButton').events.click();
  assert.equal(page.document.activeElement, edit);

  const linked = await usersPage([{ ...user, id: 'retired-id', identityProvider: 'retired-windows' }]);
  const link = linked.firstUserRow().lastElementChild.firstElementChild.firstElementChild;
  link.focus(); link.events.click();
  assert.equal(linked.element('employeeUserDialog').open, true);
  assert.equal(linked.element('employeeAssignments').hidden, true);
  assert.equal(linked.element('employeeCreateButton').textContent, 'Link employee');
  linked.element('employeeCancelButton').events.click();
  assert.equal(linked.element('employeeUserDialog').open, false);
  assert.equal(linked.document.activeElement, link);
});

test('save errors stay visible inside the open dialog and retain the selected employee and access draft', async () => {
  const page = await usersPage([], {
    fetch(url, options) { if (options?.method === 'POST') throw new Error('Mail verification is unavailable.'); }
  });
  page.openCreate();
  page.element('employeeRole').value = 'admin';
  page.element('employeeDepartment').value = 'it';
  await page.select();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  assert.equal(page.element('employeeUserDialog').open, true);
  assert.equal(page.element('employeeDialogMessage').hidden, false);
  assert.match(page.element('employeeDialogMessage').textContent, /Mail verification is unavailable/);
  assert.equal(page.document.activeElement, page.element('employeeDialogMessage'));
  assert.equal(page.element('employeeDialogMessage').scrolledIntoView, true);
  assert.equal(page.element('employeeCode').value, employee.employeeCode);
  assert.equal(page.element('employeeRole').value, 'admin');
  assert.equal(page.element('employeeCreateButton').disabled, false);
  page.element('employeeCancelButton').events.click();
  page.openCreate();
  assert.equal(page.element('employeeDialogMessage').textContent, '');
});

test('saving prevents Escape, backdrop, Cancel and close actions until the request completes', async () => {
  let finish;
  const saved = new Promise(resolve => { finish = resolve; });
  const page = await usersPage([], {
    fetch(url, options) { if (options?.method === 'POST') return saved; }
  });
  page.openCreate();
  page.element('employeeRole').value = 'admin';
  page.element('employeeDepartment').value = 'it';
  await page.select();
  const pending = page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const dialog = page.element('employeeUserDialog');
  assert.equal(page.element('employeeCancelButton').disabled, true);
  assert.equal(page.element('employeeDialogCloseButton').disabled, true);
  assert.equal(page.element('usersAddRoleButton').disabled, true);
  let prevented = false;
  dialog.events.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const escape = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  dialog.events.keydown(escape);
  assert.equal(escape.defaultPrevented, true, 'busy Escape prevents the browser search-field clear action');
  assert.equal(dialog.open, true);
  page.element('employeeCancelButton').events.click();
  page.element('employeeDialogCloseButton').events.click();
  dialog.events.click({ target: dialog, clientX: 0, clientY: 0 });
  assert.equal(dialog.open, true);
  finish({ id: 'created', ...employee, roles: ['admin'], department: 'it', identityProvider: 'employee-code' });
  await pending;
  assert.equal(dialog.open, false);
});

test('closing a modal aborts its directory requests and stale results cannot repopulate a reopened form', async () => {
  let finish;
  let requestSignal;
  const lookup = new Promise(resolve => { finish = resolve; });
  const page = await usersPage([], {
    fetch(url, options) {
      if (url.startsWith('/api/admin/directory-users?')) { requestSignal = options.signal; return lookup; }
    }
  });
  page.openCreate();
  await page.select();
  assert.equal(requestSignal.aborted, false);
  page.element('employeeCancelButton').events.click();
  assert.equal(requestSignal.aborted, true);
  page.openCreate();
  finish({ users: [verifiedMail] });
  await new Promise(setImmediate);
  assert.equal(page.element('employeeMailResults').children.length, 0);
  assert.equal(page.element('employeeCode').value, '');
  assert.equal(page.element('employeeCreateButton').disabled, true);
});

test('Escape and backdrop dismiss idle dialogs while hash navigation closes and clears a draft', async () => {
  const page = await usersPage();
  const dialog = page.element('employeeUserDialog');
  page.openCreate();
  let prevented = false;
  dialog.events.cancel({ preventDefault() { prevented = true; } });
  if (!prevented) dialog.close();
  assert.equal(dialog.open, false);
  assert.equal(page.document.activeElement, page.element('usersAddRoleButton'));
  page.openCreate();
  dialog.events.click({ target: dialog, clientX: 200, clientY: 200 });
  assert.equal(dialog.open, true, 'clicking the dialog content does not dismiss');
  dialog.events.click({ target: dialog, clientX: 0, clientY: 0 });
  assert.equal(dialog.open, false);
  page.openCreate();
  await page.select();
  await page.changeHash('#portal');
  assert.equal(dialog.open, false);
  assert.equal(page.element('employeeCode').value, '');
});

test('hash navigation during a save preserves the request then closes without moving focus onto a hidden users page', async () => {
  let finish;
  const saved = new Promise(resolve => { finish = resolve; });
  const page = await usersPage([], { fetch(url, options) { if (options?.method === 'POST') return saved; } });
  page.openCreate();
  page.element('employeeRole').value = 'admin';
  page.element('employeeDepartment').value = 'it';
  await page.select();
  const pending = page.element('employeeUserForm').events.submit({ preventDefault() {} });
  await page.changeHash('#portal');
  const portalControl = page.element('portalControl'); portalControl.focus();
  assert.equal(page.element('employeeUserDialog').open, true);
  finish({ id: 'created', ...employee, roles: ['admin'], department: 'it', identityProvider: 'employee-code' });
  await pending;
  assert.equal(page.element('employeeUserDialog').open, false);
  assert.equal(page.document.activeElement, portalControl);
});

test('saving an edit restores focus to its corresponding refreshed row rather than the detached opener', async () => {
  const user = { id: 'employee-id', ...employee, username: employee.employeeCode, roles: ['admin'], department: 'it',
    mailProfile: verifiedMail, isActive: true, identityProvider: 'employee-code', version: '0011223344556677' };
  const page = await usersPage([user], {
    fetch(url, options) { if (options?.method === 'PATCH') return { ...user, isActive: false }; }
  });
  const originalEdit = page.firstUserRow().lastElementChild.firstElementChild.firstElementChild;
  originalEdit.focus(); originalEdit.events.click();
  page.element('employeeActive').checked = false;
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const newEdit = page.firstUserRow().lastElementChild.firstElementChild.firstElementChild;
  assert.notEqual(newEdit, originalEdit);
  assert.equal(originalEdit.isConnected, false);
  assert.equal(newEdit.isConnected, true);
  assert.equal(page.element('employeeUserDialog').open, false);
  assert.equal(page.document.activeElement, newEdit);
});

test('canceling a conflicted edit restores the same user action after its row was replaced', async () => {
  const user = { id: 'employee-id', ...employee, username: employee.employeeCode, roles: ['admin'], department: 'it',
    mailProfile: verifiedMail, isActive: true, identityProvider: 'employee-code', version: '0011223344556677' };
  const page = await usersPage([user], { conflict: true });
  const originalEdit = page.firstUserRow().lastElementChild.firstElementChild.firstElementChild;
  originalEdit.focus(); originalEdit.events.click();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  assert.equal(originalEdit.isConnected, false);
  assert.equal(page.element('employeeUserDialog').open, true);
  page.element('employeeCancelButton').events.click();
  const newEdit = page.firstUserRow().lastElementChild.firstElementChild.firstElementChild;
  assert.equal(page.document.activeElement, newEdit);
  assert.equal(page.element('employeeUserDialog').open, false);
});

test('successful employee linking restores the new Edit action when the original Link action is removed', async () => {
  const user = { id: 'retired-id', username: 'former-admin', displayName: 'Existing Admin', roles: ['admin'], department: 'it',
    isActive: true, identityProvider: 'retired-windows' };
  const page = await usersPage([user], {
    fetch(url, options) {
      if (options?.method === 'POST') return { ...user, ...employee, identityProvider: 'employee-code' };
    }
  });
  const originalLink = page.firstUserRow().lastElementChild.firstElementChild.firstElementChild;
  originalLink.focus(); originalLink.events.click();
  await page.select();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const newEdit = page.firstUserRow().lastElementChild.firstElementChild.firstElementChild;
  assert.equal(originalLink.isConnected, false);
  assert.equal(newEdit.textContent, 'Edit');
  assert.equal(page.document.activeElement, newEdit);
});

test('Escape closes the modal from both empty and populated search fields without requiring native cancel', async () => {
  for (const input of ['', 'Employee name']) {
    const page = await usersPage();
    page.openCreate();
    page.element('employeeSearch').value = input;
    const escape = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    page.element('employeeUserDialog').events.keydown(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(page.element('employeeUserDialog').open, false);
    assert.equal(page.document.activeElement, page.element('usersAddRoleButton'));
    assert.equal(page.element('employeeSearch').value, '');
  }
});

test('an Escape already handled by a child control does not dismiss the modal on bubbling', async () => {
  const page = await usersPage();
  page.openCreate();
  const search = page.element('employeeSearch');
  const escape = { key: 'Escape', defaultPrevented: true, preventDefault() { throw new Error('Already handled'); } };
  page.element('employeeUserDialog').events.keydown(escape);
  assert.equal(page.element('employeeUserDialog').open, true);
  assert.equal(page.document.activeElement, search);
});

function deferredLookup() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function assertMailLoading(page, loading) {
  assert.equal(page.element('employeeMailLoading').hidden, !loading, 'mail loading profile visibility');
  assert.equal(page.element('employeeMailResults').getAttribute('aria-busy'), String(loading), 'mail results busy announcement');
}

test('automatic mail lookup shows a loading profile until verified profile results arrive', async () => {
  const lookup = deferredLookup();
  const page = await usersPage([], { fetch(url) { if (url.startsWith('/api/admin/directory-users?')) return lookup.promise; } });
  page.openCreate(); await page.select();
  assertMailLoading(page, true);
  assert.match(page.element('employeeMailLoadingText').textContent, /searching/i);
  assert.equal(page.element('employeeMailResults').children.length, 0);
  const photo = 'data:image/png;base64,YWJj';
  lookup.resolve({ users: [{ ...verifiedMail, displayName: 'Mail Person', photo, jobTitle: 'Engineer', department: 'Engineering' }] });
  await new Promise(setImmediate);
  assertMailLoading(page, false);
  const result = page.element('employeeMailResults').firstElementChild;
  assert.match(result.className, /employee-mail-result/);
  const identity = result.firstElementChild;
  assert.equal(identity.firstElementChild.firstElementChild.src, photo);
  assert.equal(identity.firstElementChild.firstElementChild.alt, '');
  assert.equal(identity.lastElementChild.children.map(child => child.textContent).join(' '), 'Mail Person person@example.test Engineer - Engineering');
  result.events.click();
  assert.match(page.element('employeeMailSelected').textContent, /Confirmed: Mail Person/);
  assertMailLoading(page, false);
});

test('mail lookup clears its loading profile after empty, invalid and failed responses', async () => {
  for (const outcome of [{ users: [] }, { invalid: true }, new Error('Directory unavailable')]) {
    const lookup = deferredLookup();
    const page = await usersPage([], { fetch(url) { if (url.startsWith('/api/admin/directory-users?')) return lookup.promise; } });
    page.openCreate(); await page.select();
    assertMailLoading(page, true);
    if (outcome instanceof Error) lookup.reject(outcome); else lookup.resolve(outcome);
    await new Promise(setImmediate);
    assertMailLoading(page, false);
    const results = page.element('employeeMailResults');
    assert.equal(results.hidden, true); assert.equal(results.children.length, 0);
    assert.match(page.element('employeeMailStatus').textContent, /No matching|invalid response|Directory unavailable/);
  }
});

test('typed mail search shows a loading profile immediately and clears it for short queries or dialog cancellation', async () => {
  const page = await usersPage([], { employee: { ...employee, englishName: '' } });
  page.openCreate(); await page.select();
  assertMailLoading(page, false);
  const search = page.element('employeeMailSearch');
  search.value = 'person'; search.events.input(); assertMailLoading(page, true);
  assert.equal(page.calls.filter(call => call.url.startsWith('/api/admin/directory-users?')).length, 0, 'spinner covers debounce before network begins');
  search.value = 'p'; search.events.input(); assertMailLoading(page, false);
  search.value = ''; search.events.input(); assertMailLoading(page, false);
  search.value = 'person'; search.events.input(); assertMailLoading(page, true);
  page.element('employeeCancelButton').events.click(); assertMailLoading(page, false);
  await page.runMailTimer();
  assert.equal(page.calls.filter(call => call.url.startsWith('/api/admin/directory-users?')).length, 0);
});

test('a cancelled old mail response cannot clear a newer search loading profile or overwrite its candidates', async () => {
  const first = deferredLookup(), second = deferredLookup();
  const pending = [first, second];
  const signals = [];
  const page = await usersPage([], {
    fetch(url, options) {
      if (url.startsWith('/api/admin/directory-users?')) { signals.push(options.signal); return pending.shift().promise; }
    }
  });
  page.openCreate(); await page.select();
  assertMailLoading(page, true);
  const search = page.element('employeeMailSearch');
  search.value = 'New Person'; search.events.input(); assert.equal(signals[0].aborted, true);
  const newerSearch = page.runMailTimer();
  assertMailLoading(page, true);
  first.resolve({ users: [{ ...verifiedMail, displayName: 'Old Person' }] });
  await new Promise(setImmediate);
  assertMailLoading(page, true);
  assert.equal(page.element('employeeMailResults').children.length, 0);
  second.resolve({ users: [{ ...verifiedMail, displayName: 'New Person' }] });
  await newerSearch;
  assertMailLoading(page, false);
  assert.equal(page.element('employeeMailResults').firstElementChild.firstElementChild.lastElementChild.firstElementChild.textContent, 'New Person');
});

test('mail profile candidates use initials for unsafe photos and for a failed image load', async () => {
  for (const photo of ['https://external.example.test/photo.png', 'data:image/svg+xml;base64,YWJj', 'data:image/png;base64,YWJ', '', 'data:image/png;base64,YWJj']) {
    const page = await usersPage([], { mailProfiles: [{ ...verifiedMail, displayName: 'Mail Person', photo }] });
    page.openCreate(); await page.select();
    await new Promise(setImmediate);
    const avatar = page.element('employeeMailResults').firstElementChild.firstElementChild.firstElementChild;
    if (photo === 'data:image/png;base64,YWJj') avatar.firstElementChild.events.error();
    assert.equal(avatar.children.length, 0, 'unsafe or failed image is never retained'); assert.equal(avatar.textContent, 'M');
    assertMailLoading(page, false);
  }
});

test('changing employee or saving access cancels the mail loading profile and outstanding request', async () => {
  for (const action of ['change employee', 'save']) {
    const lookup = deferredLookup(); let requestSignal;
    const page = await usersPage([], {
      fetch(url, options) {
        if (url.startsWith('/api/admin/directory-users?')) { requestSignal = options.signal; return lookup.promise; }
      }
    });
    page.openCreate();
    page.element('employeeRole').value = 'admin';
    page.element('employeeDepartment').value = 'it';
    await page.select();
    assertMailLoading(page, true);
    if (action === 'change employee') {
      page.element('employeeSearch').value = 'Other employee';
      page.element('employeeSearch').events.input();
    } else await page.element('employeeUserForm').events.submit({ preventDefault() {} });
    assert.equal(requestSignal.aborted, true); assertMailLoading(page, false);
    lookup.resolve({ users: [verifiedMail] });
    await new Promise(setImmediate);
    assertMailLoading(page, false); assert.equal(page.element('employeeMailResults').children.length, 0);
  }
});

test('Escape dismisses visible mail results first and then closes the modal from a populated mail search', async () => {
  const page = await usersPage();
  page.openCreate();
  await page.select();
  await new Promise(setImmediate);
  const mailSearch = page.element('employeeMailSearch');
  const results = page.element('employeeMailResults');
  assert.equal(results.hidden, false);
  assert.equal(results.children.length, 2);
  assert.equal(mailSearch.value, employee.displayName);
  mailSearch.focus();
  const firstEscape = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  page.element('employeeUserDialog').events.keydown(firstEscape);
  assert.equal(firstEscape.defaultPrevented, true);
  assert.equal(page.element('employeeUserDialog').open, true);
  assert.equal(results.hidden, true);
  assert.equal(results.children.length, 0);
  assert.equal(page.document.activeElement, mailSearch);
  assert.equal(mailSearch.value, employee.displayName, 'dismissing results preserves the search query');
  const secondEscape = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  page.element('employeeUserDialog').events.keydown(secondEscape);
  assert.equal(secondEscape.defaultPrevented, true);
  assert.equal(page.element('employeeUserDialog').open, false);
  assert.equal(page.document.activeElement, page.element('usersAddRoleButton'));
});
