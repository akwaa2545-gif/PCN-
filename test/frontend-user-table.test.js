const test = require('node:test');
const assert = require('node:assert/strict');
const { usersPage, verifiedMail } = require('./helpers/users-page');

const account = (id, roles, fields = {}) => ({ id, employeeCode: '1234567', displayName: id, roles,
  identityProvider: 'employee-code', department: 'qaTet', signingStep: roles.length ? 'checked' : null,
  isActive: true, version: '0011223344556677', mailProfile: verifiedMail, ...fields });
const action = (page, table, id, type) => page.element(table).querySelectorAll('[data-user-id]')
  .find(button => button.getAttribute('data-user-id') === id && button.getAttribute('data-user-action') === type);
function filter(page, id, value) { page.element(id).value = value; page.element(id).events[id === 'usersSearchFilter' ? 'input' : 'change'](); }

test('Users split pending and assigned by roles including inactive pending with appropriate actions and empty states', async () => {
  const page = await usersPage([account('pending', [], { isActive: false }), account('assigned', ['qa']), account('legacy', ['reviewer'], { signingStep: null })]);
  assert.equal(page.element('pendingUsersRows').children.length, 1);
  assert.equal(page.element('adminUsersRows').children.length, 2);
  assert.match(page.element('pendingUsersCount').textContent, /1/);
  assert.match(page.element('assignedUsersCount').textContent, /2/);
  assert.equal(page.element('usersFilterSummary').textContent, 'Showing 1 of 1 pending users and 2 of 2 assigned users.');
  assert.equal(action(page, 'pendingUsersRows', 'pending', 'edit').textContent, 'Add role');
  assert.match(action(page, 'pendingUsersRows', 'pending', 'edit').getAttribute('aria-label'), /Add role for pending.*1234567/);
  assert.equal(action(page, 'pendingUsersRows', 'pending', 'remove'), undefined);
  assert.equal(action(page, 'adminUsersRows', 'assigned', 'remove').textContent, 'Remove role');
  assert.match(action(page, 'adminUsersRows', 'assigned', 'remove').getAttribute('aria-label'), /Remove role for assigned.*1234567.*all PCN roles/);
  assert.equal(page.element('pendingUsersEmpty').hidden, true);
  const empty = await usersPage();
  assert.equal(empty.element('pendingUsersEmpty').hidden, false);
  assert.equal(empty.element('assignedUsersEmpty').hidden, false);
});

test('name code and email search trims case, combines all filters, clears and shows filtered empty states', async () => {
  const page = await usersPage([account('Pending Person', [], { employeeCode: '0001111', mailProfile: null, email: 'waiting@example.test' }),
    account('Assigned Person', ['qa'], { employeeCode: '0002222' }), account('Legacy Person', ['reviewer'], { signingStep: null, isActive: false, department: 'it' }),
    account('Admin Person', ['admin'], { signingStep: null, department: 'it' })]);
  filter(page, 'usersSearchFilter', '  PENDING PERSON  ');
  assert.equal(page.element('pendingUsersRows').children.length, 1);
  assert.equal(page.element('adminUsersRows').children.length, 0);
  assert.match(page.element('assignedUsersEmpty').textContent, /match/i);
  filter(page, 'usersSearchFilter', '0002222');
  assert.equal(page.element('adminUsersRows').children.length, 1);
  filter(page, 'usersSearchFilter', 'WAITING@');
  assert.equal(page.element('pendingUsersRows').children.length, 1);
  filter(page, 'usersSearchFilter', ''); filter(page, 'usersRoleFilter', 'checked');
  assert.equal(page.element('adminUsersRows').children.length, 1);
  filter(page, 'usersDepartmentFilter', 'it');
  assert.equal(page.element('adminUsersRows').children.length, 0);
  filter(page, 'usersRoleFilter', 'legacy'); filter(page, 'usersStatusFilter', 'inactive');
  assert.equal(page.element('adminUsersRows').children.length, 1);
  page.element('usersClearFiltersButton').events.click();
  assert.equal(page.element('pendingUsersRows').children.length, 1);
  assert.equal(page.element('adminUsersRows').children.length, 3);
  assert.equal(page.calls.filter(call => call.url === '/api/admin/users').length, 1, 'filters only use loaded accounts');
});

test('Remove role confirms exact target then sends only version, retains account and moves focus to pending Add role', async () => {
  const original = account('assigned', ['qa']);
  const updated = { ...original, roles: [], department: null, signingStep: null, version: '1122334455667788' };
  const page = await usersPage([original], { fetch(url, options) { if (options?.method === 'DELETE') return updated; } });
  const button = action(page, 'adminUsersRows', original.id, 'remove'); button.focus(); await button.events.click();
  assert.match(page.confirmations[0], /assigned/);
  assert.match(page.confirmations[0], /retain|keep/i);
  const write = page.calls.find(call => call.options?.method === 'DELETE');
  assert.equal(write.url, '/api/admin/users/assigned/roles');
  assert.deepEqual(JSON.parse(write.options.body), { version: original.version });
  assert.equal(page.element('adminUsersRows').children.length, 0);
  assert.equal(page.element('pendingUsersRows').children.length, 1);
  const addRole = action(page, 'pendingUsersRows', original.id, 'edit');
  assert.equal(page.document.activeElement, addRole);
  addRole.events.click();
  assert.equal(page.element('employeeActive').checked, true);
  assert.match(page.element('employeeMailSelected').textContent, /person@example.test/);
});

test('Remove role cancellation sends nothing and pending action cannot remove roles', async () => {
  const page = await usersPage([account('assigned', ['qa']), account('pending', [])], { confirm: false });
  await action(page, 'adminUsersRows', 'assigned', 'remove').events.click();
  assert.equal(page.calls.some(call => call.options?.method === 'DELETE'), false);
  assert.equal(page.element('adminUsersRows').children.length, 1);
  assert.equal(action(page, 'pendingUsersRows', 'pending', 'remove'), undefined);
});

test('removal busy guards all actions and rejection leaves assigned target and actionable error visible', async () => {
  let reject;
  const page = await usersPage([account('admin', ['admin'])], { fetch(url, options) {
    if (options?.method === 'DELETE') return new Promise((resolve, fail) => { reject = fail; });
  } });
  const pending = action(page, 'adminUsersRows', 'admin', 'remove').events.click();
  assert.equal(page.element('usersCreateButton').disabled, true);
  assert.equal(page.element('usersAddRoleButton').disabled, true);
  assert.equal(page.element('usersSearchFilter').disabled, true);
  assert.equal(action(page, 'adminUsersRows', 'admin', 'edit').disabled, true);
  reject(new Error('The last active administrator must retain access.')); await pending;
  assert.match(page.element('usersMessage').textContent, /last active administrator/);
  assert.equal(page.element('adminUsersRows').children.length, 1);
  assert.equal(page.element('pendingUsersRows').children.length, 0);
  assert.equal(page.element('usersCreateButton').disabled, false);
  assert.equal(page.document.activeElement, action(page, 'adminUsersRows', 'admin', 'remove'));
});

test('assignment from pending restores focus to the same account now rendered in assigned users', async () => {
  const pending = account('pending', [], { department: null });
  const updated = { ...pending, roles: ['admin'], department: 'it', version: '1122334455667788' };
  const page = await usersPage([pending], { fetch(url, options) { if (options?.method === 'PATCH') return updated; } });
  action(page, 'pendingUsersRows', 'pending', 'edit').focus(); action(page, 'pendingUsersRows', 'pending', 'edit').events.click();
  page.element('employeeRole').value = 'admin'; page.element('employeeRole').events.change();
  page.element('employeeDepartment').value = 'it'; page.element('employeeDepartment').events.change();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  assert.equal(page.element('pendingUsersRows').children.length, 0);
  assert.equal(page.document.activeElement, action(page, 'adminUsersRows', 'pending', 'edit'));
});

test('removal with an assigned-role filter restores focus to the visible status when its pending destination is filtered out', async () => {
  const original = account('assigned', ['qa']);
  const page = await usersPage([original], { fetch(url, options) {
    if (options?.method === 'DELETE') return { ...original, roles: [], department: null, signingStep: null, version: '1122334455667788' };
  } });
  filter(page, 'usersRoleFilter', 'checked');
  await action(page, 'adminUsersRows', 'assigned', 'remove').events.click();
  assert.equal(page.element('pendingUsersRows').children.length, 0);
  assert.equal(page.element('adminUsersRows').children.length, 0);
  assert.equal(page.document.activeElement, page.element('usersMessage'));
  assert.match(page.element('pendingUsersCount').textContent, /0 of 1/);
  assert.equal(page.element('usersFilterSummary').textContent, 'Showing 0 of 1 pending users and 0 of 0 assigned users.');
  page.element('usersClearFiltersButton').events.click();
  assert.equal(page.element('pendingUsersRows').children.length, 1);
});

test('unconfigured cached-user assignment filtered out after save restores status focus instead of disabled Create user', async () => {
  const pending = account('local-pending', [], { identityProvider: 'pcn-local', department: null });
  const page = await usersPage([pending], { configured: false, fetch(url, options) {
    if (options?.method === 'PATCH') return { ...pending, roles: ['admin'], department: 'it', version: '1122334455667788' };
  } });
  filter(page, 'usersRoleFilter', 'unassigned');
  const button = action(page, 'pendingUsersRows', pending.id, 'edit'); button.focus(); button.events.click();
  page.element('employeeRole').value = 'admin'; page.element('employeeRole').events.change();
  page.element('employeeDepartment').value = 'it'; page.element('employeeDepartment').events.change();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  assert.equal(page.element('usersCreateButton').disabled, true);
  assert.equal(page.element('employeeUserDialog').open, false);
  assert.equal(page.element('pendingUsersRows').children.length, 0);
  assert.equal(page.element('adminUsersRows').children.length, 0);
  assert.equal(page.document.activeElement, page.element('usersMessage'));
});

test('pending access with confirmed mail still requires an explicit role and department before Save', async () => {
  const pending = account('pending', [], { department: null });
  const page = await usersPage([pending]);
  action(page, 'pendingUsersRows', pending.id, 'edit').events.click();
  assert.match(page.element('employeeMailSelected').textContent, /Confirmed/);
  assert.equal(page.element('employeeRole').required, true);
  assert.equal(page.element('employeeCreateButton').disabled, true);
  page.element('employeeRole').value = 'admin'; page.element('employeeRole').events.change();
  assert.equal(page.element('employeeCreateButton').disabled, true);
  page.element('employeeDepartment').value = 'it'; page.element('employeeDepartment').events.change();
  assert.equal(page.element('employeeCreateButton').disabled, false);
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(page.calls.find(call => call.options?.method === 'PATCH').options.body).roles, ['admin']);
});


test('Users show observed presence separately from account access in both tables', async () => {
  const page = await usersPage([account('pending-online', [], { presence: { status: 'online' } }),
    account('assigned-offline', ['qa'], { presence: { status: 'offline' } }),
    account('inactive-online', ['qa'], { isActive: false, presence: { status: 'online' } }),
    account('legacy', ['qa']), account('malformed', [], { presence: { status: 'maybe' } })]);
  const rows = [...page.element('pendingUsersRows').children, ...page.element('adminUsersRows').children];
  const cells = id => rows.find(row => row.children[0].textContent === '1234567' && row.children[1].querySelectorAll('*').some(node => node.textContent === id)).children;
  assert.equal(cells('pending-online')[5].firstElementChild.textContent, 'Online');
  assert.match(cells('pending-online')[5].firstElementChild.className, /user-presence-online/);
  assert.equal(cells('assigned-offline')[5].firstElementChild.textContent, 'Offline');
  assert.equal(cells('inactive-online')[5].firstElementChild.textContent, 'Online');
  assert.equal(cells('inactive-online')[6].textContent, 'Inactive');
  assert.equal(cells('legacy')[5].firstElementChild.textContent, 'Unavailable');
  assert.equal(cells('malformed')[5].firstElementChild.textContent, 'Unavailable');
  filter(page, 'usersStatusFilter', 'inactive');
  assert.equal(page.element('adminUsersRows').children.length, 1, 'account status remains the existing filter');
});

test('presence-only changes refresh the Users badge and preserve filters and focused action', async () => {
  let current = [account('assigned', ['qa'], { presence: { status: 'offline' } })];
  const page = await usersPage(current, { fetch(url) { if (url === '/api/admin/users') return current; } });
  filter(page, 'usersSearchFilter', 'assigned'); filter(page, 'usersStatusFilter', 'active');
  const original = page.element('adminUsersRows').firstElementChild;
  const edit = action(page, 'adminUsersRows', 'assigned', 'edit'); edit.focus();
  await page.autoRefresh.refresh();
  assert.equal(page.element('adminUsersRows').firstElementChild, original, 'unchanged presence does not repaint');
  current = [{ ...current[0], presence: { status: 'online' } }];
  await page.autoRefresh.refresh();
  assert.equal(page.element('adminUsersRows').firstElementChild.children[5].firstElementChild.textContent, 'Online');
  assert.equal(page.document.activeElement, action(page, 'adminUsersRows', 'assigned', 'edit'));
  assert.equal(page.element('usersSearchFilter').value, 'assigned');
  assert.equal(page.element('usersStatusFilter').value, 'active');
});
