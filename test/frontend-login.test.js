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

test('employee form shows seven PIN-style digit slots and retains explicit password maintenance', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
  const employeeForm = html.match(/<form id="employeeLoginForm"[\s\S]*?<\/form>/)?.[0];
  assert.ok(employeeForm);
  assert.match(employeeForm, /<h1 class="employee-entry-title">Enter your Employee ID<\/h1>/);
  assert.match(employeeForm, /<label[^>]*for="employeeCode">Employee ID<\/label>/);
  assert.match(employeeForm, /id="employeeCode"[^>]*maxlength="7"/);
  assert.match(employeeForm, /id="employeeCode"[^>]*aria-describedby="employeeAuthMessage"/);
  assert.match(employeeForm, /pattern="\[0-9\]\{7\}"/);
  assert.ok(employeeForm.indexOf('id="employeeCode"') < employeeForm.indexOf('id="employeeAuthMessage"'));
  assert.ok(employeeForm.indexOf('id="employeeAuthMessage"') < employeeForm.indexOf('type="submit"'));
  assert.equal((employeeForm.match(/class="employee-pin-slot"/g) || []).length, 7);
  assert.match(employeeForm, /class="employee-lock-icon"/);
  assert.doesNotMatch(employeeForm, /type="password"/);
  assert.doesNotMatch(employeeForm, /Remember me/);
  assert.doesNotMatch(html, /windowsLoginForm|Continue with Windows|SamAccountName/);
  assert.match(html, /id="loginForm" hidden/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'auth.css'), 'utf8'), /\.auth-card \[hidden\]/);
});

test('PIN-style slots display pasted digits and clear when the Employee ID is edited', async () => {
  const page = await loginPage();
  page.element('employeeCode').value = '01a2345678';
  page.element('employeeCode').events.input();
  assert.equal(page.element('employeeCode').value, '0123456');
  assert.equal(Array.from({ length: 7 }, (_, index) => page.element(`employeeDigit${index + 1}`).textContent).join(''), '0123456');
  page.element('employeeCode').value = '01';
  page.element('employeeCode').events.input();
  assert.equal(page.element('employeeDigit3').textContent, '');
  assert.equal(page.element('employeeDigit7').textContent, '');
});

test('focused Employee ID highlights the next empty slot and clears it on blur', async () => {
  const page = await loginPage();
  const input = page.element('employeeCode');
  assert.equal(page.element('employeeDigit1').classList.contains('is-active'), false);
  input.events.focus();
  assert.equal(page.element('employeeDigit1').classList.contains('is-active'), true);
  input.value = '12';
  input.events.input();
  assert.equal(page.element('employeeDigit1').classList.contains('is-active'), false);
  assert.equal(page.element('employeeDigit3').classList.contains('is-active'), true);
  input.value = '1234567';
  input.events.input();
  assert.equal(page.element('employeeDigit7').classList.contains('is-active'), false);
  input.events.blur();
  assert.equal(page.element('employeeDigit3').classList.contains('is-active'), false);
});

async function loginPage(config = { mode: 'employee-code' }, {
  search = '', authenticated = false, loginError = null,
  user = { mustChangePassword: false, roles: ['supplier'] }
} = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, hidden: true, disabled: false, textContent: '', events: {},
      classList: {
        values: new Set(),
        toggle(name, active) { if (active) this.values.add(name); else this.values.delete(name); },
        contains(name) { return this.values.has(name); }
      },
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
      ...window.PCN_SESSION, load: async () => ({ authenticated, user }),
      async fetch(url, options) {
        calls.push({ url, options });
        if (url === '/api/auth/config') {
          if (config instanceof Error) throw config;
          return config;
        }
        if (url === '/api/auth/login' && loginError) throw loginError;
        return { authenticated: true, user };
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
  assert.equal(page.element('authIntro').hidden, true);
  assert.equal(page.element('loginForm').hidden, true);
  assert.equal(page.element('passwordChangeForm').hidden, true);
  assert.equal(page.element('authRetryButton').hidden, true);
  assert.equal(page.element('employeeCode').focused, undefined);
  page.element('employeeCode').value = '0012345';
  page.element('username').value = 'legacy';
  page.element('password').value = 'unused';
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  const submission = page.calls.find((call) => call.url === '/api/auth/login');
  assert.equal(submission.options.body, JSON.stringify({ employeeCode: '0012345' }));
  assert.deepEqual(page.redirects, ['/create']);
  assert.equal(page.element('employeeLoginFormSubmit').disabled, false);
});

test('employee sign-in returns to the same PCN query link using the session redirect validator', async () => {
  const page = await loginPage({ mode: 'employee-code' }, { search: '?returnTo=%2Fform.html%3Fid%3DPCN-2026-0001' });
  page.element('employeeCode').value = '0012345';
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.deepEqual(page.redirects, ['/form.html?id=PCN-2026-0001']);
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 1);
});

test('existing authenticated login returns to the PCN while unsafe return destinations fall back locally', async () => {
  const page = await loginPage({ mode: 'employee-code' }, { search: '?returnTo=%2Fform.html%3Fid%3DPCN-2026-0001', authenticated: true });
  assert.deepEqual(page.redirects, ['/form.html?id=PCN-2026-0001']);
  assert.equal(page.calls.some((call) => call.url === '/api/auth/login'), false);
  const unsafe = await loginPage({ mode: 'employee-code' }, { search: '?returnTo=https%3A%2F%2Fevil.example%2F', authenticated: true });
  assert.deepEqual(unsafe.redirects, ['/create']);
});

test('employee with no PCN role opens the pending-access page after sign-in', async () => {
  const page = await loginPage({ mode: 'employee-code' }, { user: { employeeCode: '0012345', roles: [] } });
  page.element('employeeCode').value = '0012345';
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.deepEqual(page.redirects, ['/records']);
});

test('employee verification failure appears below the ID boxes until the ID changes', async () => {
  const error = 'Employee access could not be verified';
  const page = await loginPage({ mode: 'employee-code' }, { loginError: new Error(error) });
  page.element('employeeCode').value = '1234567';
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(page.element('employeeAuthMessage').textContent, error);
  assert.equal(page.element('authMessage').textContent, '');
  page.element('employeeCode').events.blur();
  assert.equal(page.element('employeeAuthMessage').textContent, error);
  page.element('employeeCode').value = '123456';
  page.element('employeeCode').events.input();
  assert.equal(page.element('employeeAuthMessage').textContent, '');
});

test('password mode keeps the welcome heading with its sign-in form', async () => {
  const page = await loginPage({ mode: 'password' });
  assert.equal(page.element('authIntro').hidden, false);
  assert.equal(page.element('loginForm').hidden, false);
  assert.equal(page.element('employeeLoginForm').hidden, true);
  assert.equal(page.element('username').focused, true);
});

test('failed setup remains retryable and recovery hides retry while preventing a wrong-mode login', async () => {
  const page = await loginPage(new Error('Directory unavailable'));
  assert.equal(page.element('employeeLoginForm').hidden, true);
  assert.equal(page.element('loginForm').hidden, true);
  assert.equal(page.element('authRetryButton').hidden, false);
  assert.equal(page.element('authIntro').hidden, false);
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  assert.equal(page.calls.length, 1);
  page.setConfig({ mode: 'employee-code' });
  await page.element('authRetryButton').events.click();
  assert.equal(page.element('authRetryButton').hidden, true);
  assert.equal(page.element('employeeLoginForm').hidden, false);
  page.element('loginForm').events.submit({ preventDefault() {} });
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 0);
});
