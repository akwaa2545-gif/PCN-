const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function login() {
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'login.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'window.LOGIN_TEST = { authenticationMode, employeeLoginBody };})();');
  vm.runInNewContext(source, { window, document: { addEventListener() {} } });
  return window.LOGIN_TEST;
}

test('login uses the server authentication mode and rejects an unknown configuration', () => {
  const api = login();
  assert.equal(api.authenticationMode({ mode: 'employee-code', employeeProvisioningConfigured: true }), 'employee-code');
  assert.equal(api.authenticationMode({ mode: 'password', employeeProvisioningConfigured: false }), 'password');
  for (const value of [undefined, {}, { mode: 'other' }, { mode: 'windows' }]) assert.throws(() => api.authenticationMode(value), /configuration/i);
});

test('employee sign-in preserves leading zeroes and sends no password or directory identity', () => {
  const api = login();
  assert.equal(JSON.stringify(api.employeeLoginBody(' 0012345 ')), JSON.stringify({ employeeCode: '0012345' }));
  for (const code of ['', '123456', '12345678', 'AB_1.-', 'space code', 'x@example']) {
    assert.throws(() => api.employeeLoginBody(code), /Employee ID/i);
  }
});

test('employee form has a single employee code field and retains explicit password maintenance', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
  const employeeForm = html.match(/<form id="employeeLoginForm"[\s\S]*?<\/form>/)?.[0];
  assert.ok(employeeForm);
  assert.match(employeeForm, /<label for="employeeCode">Employee ID<\/label>/);
  assert.match(employeeForm, /id="employeeCode"[^>]*maxlength="7"/);
  assert.match(employeeForm, /pattern="\[0-9\]\{7\}"/);
  assert.doesNotMatch(employeeForm, /type="password"/);
  assert.doesNotMatch(employeeForm, /Remember me/);
  assert.doesNotMatch(html, /windowsLoginForm|Continue with Windows|SamAccountName/);
  assert.match(html, /id="loginForm" hidden/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'auth.css'), 'utf8'), /\.auth-card \[hidden\]/);
});

async function loginPage(config = { mode: 'employee-code' }) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, hidden: true, disabled: false, textContent: '', events: {},
      addEventListener(name, handler) { this.events[name] = handler; },
      querySelectorAll() { return [element(`${id}Submit`)]; }, focus() { this.focused = true; }, reset() {}
    });
    return elements.get(id);
  }
  const calls = [];
  const redirects = [];
  let init;
  const window = {
    location: { search: '', assign(url) { redirects.push(url); } },
    PCN_SESSION: {
      safeReturnTo() { return '/'; }, load: async () => ({ authenticated: false }),
      async fetch(url, options) {
        calls.push({ url, options });
        if (url === '/api/auth/config') {
          if (config instanceof Error) throw config;
          return config;
        }
        return { authenticated: true, user: { mustChangePassword: false } };
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'login.js'), 'utf8'), {
    window, URLSearchParams,
    document: { getElementById: element, addEventListener(name, handler) { if (name === 'DOMContentLoaded') init = handler; } }
  });
  await init();
  return { element, calls, redirects, setConfig(value) { config = value; } };
}

test('configured employee login reveals only the employee form and submits its code without credentials', async () => {
  const page = await loginPage();
  assert.equal(page.element('employeeLoginForm').hidden, false);
  assert.equal(page.element('loginForm').hidden, true);
  assert.equal(page.element('passwordChangeForm').hidden, true);
  assert.equal(page.element('authRetryButton').hidden, true);
  assert.equal(page.element('employeeCode').focused, true);
  page.element('employeeCode').value = '0012345';
  page.element('username').value = 'legacy';
  page.element('password').value = 'unused';
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  const submission = page.calls.find((call) => call.url === '/api/auth/login');
  assert.equal(submission.options.body, JSON.stringify({ employeeCode: '0012345' }));
  assert.deepEqual(page.redirects, ['/']);
  assert.equal(page.element('employeeLoginFormSubmit').disabled, false);
});

test('failed setup remains retryable and recovery hides retry while preventing a wrong-mode login', async () => {
  const page = await loginPage(new Error('Directory unavailable'));
  assert.equal(page.element('employeeLoginForm').hidden, true);
  assert.equal(page.element('loginForm').hidden, true);
  assert.equal(page.element('authRetryButton').hidden, false);
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  assert.equal(page.calls.length, 1);
  page.setConfig({ mode: 'employee-code' });
  await page.element('authRetryButton').events.click();
  assert.equal(page.element('authRetryButton').hidden, true);
  assert.equal(page.element('employeeLoginForm').hidden, false);
  page.element('loginForm').events.submit({ preventDefault() {} });
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 0);
});
