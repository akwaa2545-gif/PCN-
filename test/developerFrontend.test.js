const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { usersPage, verifiedMail } = require('./helpers/users-page');

function usersApi() {
  const window = {};
  vm.runInNewContext(fs.readFileSync('admin-users.js', 'utf8').replace(/\}\)\(\);\s*$/, 'window.test = { assignmentBody, editBody, pcnRole };})();'), {
    window, document: { addEventListener() {} }
  });
  return window.test;
}

test('Developer assignment keeps distinct role and matching department without signing mail routing', () => {
  const api = usersApi();
  assert.deepEqual(JSON.parse(JSON.stringify(api.assignmentBody('developer', 'developer'))), {
    roles: ['developer'], department: 'developer', signingStep: null
  });
  assert.throws(() => api.assignmentBody('developer', 'it'), /Developer/i);
  assert.throws(() => api.assignmentBody('admin', 'developer'), /Developer/i);
  assert.equal(api.pcnRole({ roles: ['developer'], signingStep: null }), 'developer');
  const user = { roles: ['developer'], department: 'developer', version: '0011223344556677', mailProfile: verifiedMail };
  assert.deepEqual(JSON.parse(JSON.stringify(api.editBody(user, 'developer', 'developer', null, true, false))).roles, ['developer']);
  assert.throws(() => api.editBody({ ...user, mailProfile: null }, 'developer', 'developer', null, true, false), /verified work email/i);
});


const developerUser = { id: 'developer-user', employeeCode: '0012345', username: '0012345', displayName: 'Developer User', roles: ['developer'], department: 'developer', signingStep: null, mailProfile: verifiedMail, version: '0011223344556677', isActive: true, identityProvider: 'employee-code' };
function selectDeveloper(page) { page.element('employeeRole').value = 'developer'; page.element('employeeRole').events.change(); }
function enterDeveloperPassword(page, value = 'assignment-fixture') { page.element('employeeDeveloperPassword').value = value; page.element('employeeDeveloperPassword').events.input(); }
function editDeveloper(page) { page.firstUserRow().lastElementChild.firstElementChild.firstElementChild.events.click(); }

test('Developer assignment password appears in Access settings and blocks Create until entered', async () => {
  const page = await usersPage();
  page.openManual();
  page.element('employeeManualCode').value = '0012345'; page.element('employeeManualName').value = 'Developer User';
  selectDeveloper(page);
  assert.equal(page.element('employeeDepartment').value, 'developer');
  assert.equal(page.element('employeeDepartment').disabled, true);
  assert.equal(page.element('employeeCreateButton').disabled, true, 'Developer assignment requires its password');
  assert.equal(page.element('employeeDeveloperPasswordField').hidden, false);
  assert.equal(page.element('employeeDeveloperPassword').required, true);
  enterDeveloperPassword(page);
  assert.equal(page.element('employeeCreateButton').disabled, false);
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const write = page.calls.find(call => call.options?.method === 'POST');
  assert.equal(write.url, '/api/admin/local-users');
  assert.deepEqual(JSON.parse(write.options.body), { employeeCode: '0012345', displayName: 'Developer User', roles: ['developer'], department: 'developer', signingStep: null, developerPassword: 'assignment-fixture' });
  assert.equal(page.element('employeeDeveloperPassword').value, '');
  assert.equal(page.element('employeeDeveloperPasswordField').hidden, true);
  const html = fs.readFileSync('admin.html', 'utf8');
  assert.match(html, /id="employeeDeveloperPassword"[^>]*type="password"/);
  for (const id of ['employeeRole', 'employeeDepartment', 'usersRoleFilter', 'usersDepartmentFilter']) {
    assert.match(html.match(new RegExp('<select id="' + id + '"[^>]*>[\\s\\S]*?<\\/select>'))[0], /<option value="developer">Developer<\/option>/);
  }
});

test('Existing Developer requires the assignment password on Edit and preserves verified email requirements', async () => {
  const page = await usersPage([developerUser], { user: developerUser }); editDeveloper(page);
  assert.equal(page.element('employeeRole').value, 'developer');
  assert.equal(page.element('employeeDeveloperPasswordField').hidden, false);
  assert.equal(page.element('employeeCreateButton').disabled, true);
  enterDeveloperPassword(page);
  assert.equal(page.element('employeeCreateButton').disabled, false);
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const body = JSON.parse(page.calls.find(call => call.options?.method === 'PATCH').options.body);
  assert.deepEqual(body.roles, ['developer']); assert.equal(body.department, 'developer');
  assert.equal(body.developerPassword, 'assignment-fixture'); assert.equal(body.version, developerUser.version);
  assert.equal(page.element('employeeDeveloperPassword').value, '');
  const noMail = await usersPage([{ ...developerUser, mailProfile: null }], { user: developerUser }); editDeveloper(noMail);
  enterDeveloperPassword(noMail);
  assert.equal(noMail.element('employeeCreateButton').disabled, true, 'the password does not replace verified work email');
});

test('Wrong assignment password clears only the password and preserves the Edit draft for retry', async () => {
  const page = await usersPage([developerUser], { user: developerUser, fetch(url, options) { if (options?.method === 'PATCH') throw Object.assign(new Error('Developer password invalid'), { status: 400 }); } });
  editDeveloper(page); enterDeveloperPassword(page, 'incorrect-fixture');
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  assert.equal(page.element('employeeDeveloperPassword').value, '');
  assert.equal(page.element('employeeCreateButton').disabled, true);
  assert.equal(page.element('employeeUserDialog').open, true);
  assert.equal(page.element('employeeRole').value, 'developer');
  assert.equal(page.element('employeeDeveloperPasswordField').hidden, false);
  assert.match(page.element('employeeDialogMessage').textContent, /password invalid/);
  enterDeveloperPassword(page);
  assert.equal(page.element('employeeCreateButton').disabled, false);
});

test('Developer password clears when changing role, canceling, switching accounts or changing manual identity', async () => {
  const other = { ...developerUser, id: 'other-user', employeeCode: '0012346', username: '0012346', displayName: 'Other User' };
  const page = await usersPage([developerUser, other], { user: developerUser }); editDeveloper(page); enterDeveloperPassword(page);
  page.element('employeeRole').value = 'admin'; page.element('employeeRole').events.change();
  assert.equal(page.element('employeeDeveloperPassword').value, '');
  assert.equal(page.element('employeeDeveloperPasswordField').hidden, true);
  assert.equal(page.element('employeeDeveloperPassword').required, false);
  assert.equal(page.element('employeeDepartment').value, '');
  page.element('employeeDepartment').value = 'it'; page.element('employeeDepartment').events.change();
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const write = page.calls.find(call => call.options?.method === 'PATCH');
  assert.equal(Object.hasOwn(JSON.parse(write.options.body), 'developerPassword'), false);
  assert.match(page.confirmations[0], /Remove Developer access/);
  editDeveloper(page); enterDeveloperPassword(page);
  page.element('employeeCancelButton').events.click();
  assert.equal(page.element('employeeDeveloperPassword').value, '');
  page.element('adminUsersRows').children[1].lastElementChild.firstElementChild.firstElementChild.events.click();
  assert.equal(page.element('employeeDeveloperPassword').value, '');
  assert.equal(page.element('employeeCreateButton').disabled, true);
  page.element('employeeCancelButton').events.click();
  page.openManual(); page.element('employeeManualCode').value = '0012345'; page.element('employeeManualName').value = 'Developer User';
  selectDeveloper(page); enterDeveloperPassword(page);
  page.element('employeeManualCode').value = '0012347'; page.element('employeeManualCode').events.input();
  assert.equal(page.element('employeeDeveloperPassword').value, '');
  assert.equal(page.element('employeeCreateButton').disabled, true);
});
async function loginPage(mode = 'employee-code', response) {
  const nodes = new Map();
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: true, disabled: false, required: false, textContent: '', events: {}, attributes: {},
      classList: { toggle() {} }, addEventListener(name, fn) { this.events[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; },
      querySelectorAll() { return [element(`${id}Submit`)]; }, focus() { this.focused = true; }, reset() {} });
    return nodes.get(id);
  }
  const calls = [], redirects = [], events = [];
  const lifecycle = {};
  let initialize;
  const window = { addEventListener(name, fn) { lifecycle[name] = fn; }, location: { search: '', origin: 'http://pcn.example', assign(url) { redirects.push(url); } },
    PCN_SESSION: { safeReturnTo() { return '/admin'; }, load: async () => ({ authenticated: false }), logout: async () => { events.push('logout'); },
      async fetch(url, options) { if (url === '/api/auth/config') return { mode }; calls.push(JSON.parse(options.body)); return response(calls.at(-1), calls.length); } } };
  vm.runInNewContext(fs.readFileSync('login.js', 'utf8'), { window, URL, URLSearchParams,
    document: { getElementById: element, addEventListener(event, fn) { initialize = fn; } } });
  await initialize();
  return { element, calls, redirects, events: lifecycle, sessionEvents: events, async submit(id) { element(id).events.submit({ preventDefault() {} }); await new Promise(setImmediate); } };
}

test('Developer signs in through the ordinary employee-code or maintenance form without an assignment password', async () => {
  for (const mode of ['employee-code', 'password']) {
    const page = await loginPage(mode, () => ({ authenticated: true, user: { roles: ['developer'] } }));
    if (mode === 'employee-code') page.element('employeeCode').value = '0012345';
    else { page.element('username').value = 'maintenance'; page.element('password').value = 'account-fixture'; }
    await page.submit(mode === 'employee-code' ? 'employeeLoginForm' : 'loginForm');
    assert.deepEqual(page.redirects, ['/admin']);
    assert.equal(Object.hasOwn(page.calls[0], 'developerPassword'), false);
  }
  const html = fs.readFileSync('login.html', 'utf8');
  assert.doesNotMatch(html, /DeveloperPassword|DeveloperChallenge|Developer password/);
  assert.doesNotMatch(fs.readFileSync('login.js', 'utf8'), /developerPassword|DEVELOPER_PASSWORD_REQUIRED/);
});
test('Developer opens Administrator frontend pages and can sign every valid form step', async () => {
  const window = { location: { origin: 'http://pcn.example', pathname: '/admin', search: '', hash: '' } };
  vm.runInNewContext(fs.readFileSync('session-client.js', 'utf8'), { window, Headers, URL,
    fetch: async () => ({ ok: true, json: async () => ({ success: true, data: { authenticated: true, user: { roles: ['developer'] } } }) }) });
  assert.equal((await window.PCN_SESSION.require('admin')).authenticated, true);
  const source = fs.readFileSync('app.js', 'utf8');
  const functionSource = source.slice(source.indexOf('  function canSignStep('), source.indexOf('  function getApprovalRouteControls('));
  const state = { user: { roles: ['developer'], department: 'developer', isActive: true } };
  const context = vm.createContext({ state });
  vm.runInContext(functionSource, context);
  for (const group of ['signoff.gscTet', 'signoff.prodEngTet', 'signoff.qaTet', 'tapbu.gsc', 'tapbu.qa', 'qateFinal.signoff']) {
    for (const action of ['approved', 'checked', 'prepared']) assert.equal(context.canSignStep(group, action), true);
  }
  state.user = { ...state.user, isActive: false };
  assert.equal(context.canSignStep('signoff.gscTet', 'approved'), false);
});
