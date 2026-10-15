const test = require('node:test');
const assert = require('node:assert/strict');
const { usersPage } = require('./helpers/users-page');

function account(id, roles, department, signingStep = null) {
  return { id, username: id, displayName: id, roles, department, signingStep,
    isActive: true, identityProvider: 'employee-code', version: '0011223344556677' };
}

function badge(row, column, label, kind) {
  const cell = row.children[column];
  const value = cell.firstElementChild;
  assert.ok(value, `${label} has a badge background`);
  assert.equal(value.tagName, 'SPAN');
  assert.equal(value.textContent, label);
  assert.equal(value.className, `user-access-badge user-access-badge--${kind}`);
  assert.equal(value.children.length, 0, 'labels are plain text');
  return value;
}

test('Users table distinguishes Developer and other assigned role and department badges independently', async () => {
  const page = await usersPage([
    account('dev', ['developer'], 'developer'),
    account('admin', ['admin'], 'qaTet'),
    account('reviewer', ['gsc'], 'gscTet', 'checked'),
    account('department-only', ['admin'], 'DeVeLoPeR'),
    account('role-only', ['developer'], 'it')
  ]);
  page.element('employeeRole').options = [
    { value: 'developer', textContent: 'Developer' },
    { value: 'admin', textContent: 'Administrator' },
    { value: 'checked', textContent: 'Checked' }
  ];
  page.element('employeeDepartment').options = [
    { value: 'developer', textContent: 'Developer' },
    { value: 'qaTet', textContent: 'QA/TET' },
    { value: 'gscTet', textContent: 'GSC/TET' },
    { value: 'it', textContent: 'IT' }
  ];
  page.element('usersStatusFilter').events.change();
  const rows = page.element('adminUsersRows').children;
  badge(rows[0], 2, 'Developer', 'developer');
  badge(rows[0], 3, 'Developer', 'developer');
  badge(rows[1], 2, 'Administrator', 'admin');
  badge(rows[1], 3, 'QA/TET', 'assigned');
  badge(rows[2], 2, 'Checked', 'assigned');
  badge(rows[2], 3, 'GSC/TET', 'assigned');
  badge(rows[3], 2, 'Administrator', 'admin');
  badge(rows[3], 3, 'DeVeLoPeR', 'developer');
  badge(rows[4], 2, 'Developer', 'developer');
  badge(rows[4], 3, 'IT', 'assigned');
  assert.equal(page.calls.filter(call => call.options?.method).length, 0, 'display badges do not change access');
});

test('Pending and missing department badges keep unassigned state and labels cannot create markup', async () => {
  const maliciousDepartment = '<img src=x onerror=alert(1)>';
  const page = await usersPage([
    account('pending', [], null),
    account('assigned-without-department', ['admin'], null),
    account('plain-text-label', ['admin'], maliciousDepartment)
  ]);
  badge(page.element('pendingUsersRows').firstElementChild, 2, 'Not assigned', 'pending');
  badge(page.element('pendingUsersRows').firstElementChild, 3, 'Unassigned', 'pending');
  const rows = page.element('adminUsersRows').children;
  badge(rows[0], 2, 'admin', 'admin');
  badge(rows[0], 3, 'Unassigned', 'pending');
  const malicious = badge(rows[1], 3, maliciousDepartment, 'assigned');
  assert.equal(malicious.innerHTML, '', 'textContent handles untrusted labels without HTML interpolation');
});

test('Badge colors match exact case-insensitive labels without treating ordinary departments as roles', async () => {
  const page = await usersPage([
    account('mixed-labels', ['admin'], 'administrator'),
    account('developer-team', ['admin'], 'developer team')
  ]);
  page.element('employeeRole').options = [{ value: 'admin', textContent: 'ADMINISTRATOR' }];
  page.element('usersStatusFilter').events.change();
  const rows = page.element('adminUsersRows').children;
  badge(rows[0], 2, 'ADMINISTRATOR', 'admin');
  badge(rows[0], 3, 'administrator', 'assigned');
  badge(rows[1], 3, 'developer team', 'assigned');
});
