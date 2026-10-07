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
  assert.equal(JSON.stringify(api.employeeLoginBody(' 001234 ', true)), JSON.stringify({ employeeCode: '001234', remember: true }));
  assert.equal(JSON.stringify(api.employeeLoginBody('AB_1.-', false)), JSON.stringify({ employeeCode: 'AB_1.-', remember: false }));
  for (const code of ['', '12345678901', 'space code', 'x@example', 'domain\\code']) {
    assert.throws(() => api.employeeLoginBody(code, false), /employee code/i);
  }
});

test('employee form has a single employee code field and retains explicit password maintenance', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
  const employeeForm = html.match(/<form id="employeeLoginForm"[\s\S]*?<\/form>/)?.[0];
  assert.ok(employeeForm);
  assert.match(employeeForm, /<label for="employeeCode">Employee code<\/label>/);
  assert.match(employeeForm, /id="employeeCode"[^>]*maxlength="10"/);
  assert.doesNotMatch(employeeForm, /type="password"/);
  assert.doesNotMatch(html, /windowsLoginForm|Continue with Windows|SamAccountName/);
  assert.match(html, /id="loginForm" hidden/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'auth.css'), 'utf8'), /\.auth-card \[hidden\]/);
});

async function loginPage(config = { mode: 'employee-code' }, search = '', authenticated = false) {
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
    location: { origin: 'https://pcn.example', pathname: '/login', search, hash: '', assign(url) { redirects.push(url); } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'session-client.js'), 'utf8'), { window, URL, Headers });
  window.PCN_SESSION = {
      ...window.PCN_SESSION, load: async () => ({ authenticated, user: { mustChangePassword: false } }),
      async fetch(url, options) {
        calls.push({ url, options });
        if (url === '/api/auth/config') {
          if (config instanceof Error) throw config;
          return config;
        }
        return { authenticated: true, user: { mustChangePassword: false } };
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
  page.element('employeeCode').value = '001234';
  page.element('employeeRemember').checked = true;
  page.element('username').value = 'legacy';
  page.element('password').value = 'unused';
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  const submission = page.calls.find((call) => call.url === '/api/auth/login');
  assert.equal(submission.options.body, JSON.stringify({ employeeCode: '001234', remember: true }));
  assert.deepEqual(page.redirects, ['/create']);
  assert.equal(page.element('employeeLoginFormSubmit').disabled, false);
});

test('employee sign-in returns to the same PCN query link using the session redirect validator', async () => {
  const page = await loginPage({ mode: 'employee-code' }, '?returnTo=%2Fform.html%3Fid%3DPCN-2026-0001');
  page.element('employeeCode').value = '001234';
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.deepEqual(page.redirects, ['/form.html?id=PCN-2026-0001']);
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 1);
});

test('existing authenticated login returns to the PCN while unsafe return destinations fall back locally', async () => {
  const page = await loginPage({ mode: 'employee-code' }, '?returnTo=%2Fform.html%3Fid%3DPCN-2026-0001', true);
  assert.deepEqual(page.redirects, ['/form.html?id=PCN-2026-0001']);
  assert.equal(page.calls.some((call) => call.url === '/api/auth/login'), false);
  const unsafe = await loginPage({ mode: 'employee-code' }, '?returnTo=https%3A%2F%2Fevil.example%2F', true);
  assert.deepEqual(unsafe.redirects, ['/create']);
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
