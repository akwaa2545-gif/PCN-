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

test('Create user automatically pairs Developer department and preserves verified email guard on edit', async () => {
  const page = await usersPage();
  page.openManual();
  page.element('employeeManualCode').value = '0012345';
  page.element('employeeManualName').value = 'Developer User';
  page.element('employeeRole').value = 'developer';
  page.element('employeeRole').events.change();
  assert.equal(page.element('employeeDepartment').value, 'developer');
  assert.equal(page.element('employeeDepartment').disabled, true);
  assert.equal(page.element('employeeCreateButton').disabled, false);
  await page.element('employeeUserForm').events.submit({ preventDefault() {} });
  const write = page.calls.find(call => call.options?.method === 'POST');
  assert.equal(write.url, '/api/admin/local-users');
  assert.deepEqual(JSON.parse(write.options.body), { employeeCode: '0012345', displayName: 'Developer User', roles: ['developer'], department: 'developer', signingStep: null });
});

async function loginPage(mode = 'employee-code', response) {
  const nodes = new Map();
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: true, disabled: false, required: false, textContent: '', events: {}, attributes: {},
      classList: { toggle() {} }, addEventListener(name, fn) { this.events[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; },
      querySelectorAll() { return [element(`${id}Submit`)]; }, focus() { this.focused = true; }, reset() {} });
    return nodes.get(id);
  }
  const calls = [], redirects = [];
  let initialize;
  const window = { location: { search: '', origin: 'http://pcn.example', assign(url) { redirects.push(url); } },
    PCN_SESSION: { safeReturnTo() { return '/admin'; }, load: async () => ({ authenticated: false }), logout: async () => {},
      async fetch(url, options) { if (url === '/api/auth/config') return { mode }; calls.push(JSON.parse(options.body)); return response(calls.at(-1), calls.length); } } };
  vm.runInNewContext(fs.readFileSync('login.js', 'utf8'), { window, URL, URLSearchParams,
    document: { getElementById: element, addEventListener(event, fn) { initialize = fn; } } });
  await initialize();
  return { element, calls, redirects, async submit(id) { element(id).events.submit({ preventDefault() {} }); await new Promise(setImmediate); } };
}
function challenge() { return Object.assign(new Error('Developer password required'), { code: 'DEVELOPER_PASSWORD_REQUIRED' }); }

test('Employee Developer challenge sends password only after challenge and clears failed and successful submissions', async () => {
  const page = await loginPage('employee-code', (body, count) => { if (count === 1) throw challenge(); if (count === 2) throw new Error('Sign-in failed'); return { authenticated: true, user: { roles: ['developer'] } }; });
  page.element('employeeCode').value = '0012345';
  await page.submit('employeeLoginForm');
  assert.deepEqual(page.calls[0], { employeeCode: '0012345' });
  assert.equal(page.element('employeeDeveloperChallenge').hidden, false);
  assert.equal(page.element('employeeDeveloperPassword').required, true);
  assert.equal(page.element('employeeDeveloperPassword').focused, true);
  page.element('employeeDeveloperPassword').value = 'fixture-first';
  await page.submit('employeeLoginForm');
  assert.equal(page.calls[1].developerPassword, 'fixture-first');
  assert.equal(page.element('employeeDeveloperPassword').value, '');
  assert.equal(page.element('employeeDeveloperChallenge').hidden, false);
  page.element('employeeDeveloperPassword').value = 'fixture-second';
  await page.submit('employeeLoginForm');
  assert.equal(page.element('employeeDeveloperPassword').value, '');
  assert.deepEqual(page.redirects, ['/admin']);
});

test('Changing employee code and cancelling reset Developer challenge and discard the password', async () => {
  const page = await loginPage('employee-code', () => { throw challenge(); });
  page.element('employeeCode').value = '0012345';
  await page.submit('employeeLoginForm');
  page.element('employeeDeveloperPassword').value = 'fixture-value';
  page.element('employeeCode').value = '001234';
  page.element('employeeCode').events.input();
  assert.equal(page.element('employeeDeveloperChallenge').hidden, true);
  assert.equal(page.element('employeeDeveloperPassword').value, '');
  page.element('employeeCode').value = '0012345';
  await page.submit('employeeLoginForm');
  page.element('employeeDeveloperPassword').value = 'fixture-value';
  page.element('employeeDeveloperCancel').events.click();
  assert.equal(page.element('employeeDeveloperChallenge').hidden, true);
  assert.equal(page.element('employeeDeveloperPassword').value, '');
  assert.equal(page.element('employeeCode').value, '');
});

test('Password maintenance login includes the same server-requested Developer challenge without exposing the secret', async () => {
  const page = await loginPage('password', (body, count) => { if (count === 1) throw challenge(); return { authenticated: true, user: { roles: ['developer'] } }; });
  page.element('username').value = 'maintenance'; page.element('password').value = 'account-fixture';
  await page.submit('loginForm');
  assert.equal(page.element('passwordDeveloperChallenge').hidden, false);
  page.element('passwordDeveloperPassword').value = 'challenge-fixture'; page.element('password').value = 'account-fixture';
  await page.submit('loginForm');
  assert.equal(page.calls[1].developerPassword, 'challenge-fixture');
  assert.equal(page.element('passwordDeveloperPassword').value, '');
  assert.deepEqual(page.redirects, ['/admin']);
  const html = fs.readFileSync('login.html', 'utf8');
  assert.match(html, /id="employeeDeveloperPassword"[^>]*type="password"/);
  assert.match(html, /id="passwordDeveloperPassword"[^>]*type="password"/);
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
