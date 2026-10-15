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
  assert.match(employeeForm, /id="employeeCode"[^>]*aria-describedby="employeeEntryHelp employeeAuthMessage"/);
  assert.match(employeeForm, /pattern="\[0-9\]\{7\}"/);
  assert.ok(employeeForm.indexOf('id="employeeCode"') < employeeForm.indexOf('id="employeeAuthMessage"'));
  assert.ok(employeeForm.indexOf('id="employeeAuthMessage"') < employeeForm.indexOf('type="submit"'));
  assert.equal((employeeForm.match(/class="employee-pin-slot"/g) || []).length, 7);
  assert.match(employeeForm, /class="employee-lock-icon"/);
  assert.match(employeeForm, /id="employeeDeveloperChallenge"[^>]*hidden/);
  assert.match(employeeForm, /id="employeeDeveloperPassword"[^>]*type="password"/);
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
  user = { mustChangePassword: false, roles: ['supplier'] }, loginResponse = null, initialCode = ''
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
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      querySelectorAll() { return [element(`${id}Submit`)]; }, focus() { this.focused = true; }, reset() {}
    });
    return elements.get(id);
  }
  const calls = [];
  element('employeeCode').value = initialCode;
  element('employeeLoginFormSubmit').textContent = 'Sign in';
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
        if (url === '/api/auth/login' && loginResponse) return loginResponse();
        return { authenticated: true, user };
      }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'login.js'), 'utf8'), {
    window, URLSearchParams, URL,
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
  assert.deepEqual(page.redirects, ['/admin']);
  assert.equal(page.element('employeeLoginFormSubmit').disabled, true);
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
  assert.deepEqual(unsafe.redirects, ['/admin']);
});

test('employee with no PCN role opens read-only Records after sign-in', async () => {
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

test('completing seven employee digits automatically signs in once and preserves leading zeroes', async () => {
  const page = await loginPage();
  const input = page.element('employeeCode');
  for (const value of ['0', '00', '001', '0012', '00123', '001234']) {
    input.value = value;
    input.events.input();
  }
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 0);
  input.value = '0012345';
  input.events.input();
  input.events.change();
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.deepEqual(page.calls.filter((call) => call.url === '/api/auth/login').map((call) => call.options.body), [JSON.stringify({ employeeCode: '0012345' })]);
  assert.deepEqual(page.redirects, ['/admin']);
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 1);
});

test('pending automatic sign-in announces busy state and blocks duplicate submission', async () => {
  let rejectLogin;
  const response = new Promise((resolve, reject) => { rejectLogin = reject; });
  const page = await loginPage({ mode: 'employee-code' }, { loginResponse: () => response });
  const input = page.element('employeeCode');
  const form = page.element('employeeLoginForm');
  const button = page.element('employeeLoginFormSubmit');
  input.value = '1234567';
  input.events.input();
  assert.equal(input.disabled, true);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Signing in\u2026');
  assert.equal(form.getAttribute('aria-busy'), 'true');
  assert.equal(page.element('employeeAuthMessage').textContent, '');
  input.events.change();
  form.events.submit({ preventDefault() {} });
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 1);
  rejectLogin(new Error('Try again later'));
  await new Promise(setImmediate);
  assert.equal(input.disabled, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Sign in');
  assert.equal(form.getAttribute('aria-busy'), 'false');
  assert.equal(page.element('employeeAuthMessage').textContent, 'Try again later');
  assert.deepEqual(page.redirects, []);
});

test('failed automatic sign-in retries only after deliberate editing or manual submission', async () => {
  const page = await loginPage({ mode: 'employee-code' }, { loginError: new Error('Employee access could not be verified') });
  const input = page.element('employeeCode');
  input.value = '1234567';
  input.events.input();
  await new Promise(setImmediate);
  for (const event of ['focus', 'blur', 'change', 'input']) input.events[event]();
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 1);
  assert.equal(page.element('employeeAuthMessage').textContent, 'Employee access could not be verified');
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 2);
  input.value = '123456';
  input.events.input();
  input.value = '1234567';
  input.events.input();
  await new Promise(setImmediate);
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 3);
});

test('malformed pasted identifiers cannot automatically sign in after being sanitized', async () => {
  for (const value of ['12x34567', '12345678', '\uff11\uff12\uff13\uff14\uff15\uff16\uff17', '123 4567']) {
    const page = await loginPage();
    page.element('employeeCode').value = value;
    page.element('employeeCode').events.input();
    page.element('employeeCode').events.change();
    await new Promise(setImmediate);
    assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 0, value);
  }
});

test('setup and a pre-existing code never trigger automatic sign-in without new user entry', async () => {
  const page = await loginPage({ mode: 'employee-code' }, { initialCode: '1234567' });
  const input = page.element('employeeCode');
  for (const event of ['focus', 'blur', 'change']) input.events[event]();
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 0);
  input.value = '123456';
  input.events.input();
  input.value = '1234567';
  input.events.input();
  await new Promise(setImmediate);
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 1);
});

test('automatic employee sign-in is unavailable in password mode or a hidden employee form', async () => {
  for (const config of [{ mode: 'password' }, new Error('Setup unavailable')]) {
    const page = await loginPage(config);
    page.element('employeeCode').value = '1234567';
    page.element('employeeCode').events.input();
    page.element('employeeLoginForm').events.submit({ preventDefault() {} });
    assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 0);
  }
  const page = await loginPage();
  page.element('employeeLoginForm').hidden = true;
  page.element('employeeCode').value = '1234567';
  page.element('employeeCode').events.input();
  page.element('employeeLoginForm').events.submit({ preventDefault() {} });
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 0);
});

test('automatic sign-in preserves document return links and sends roleless users to records', async () => {
  for (const roles of [['supplier'], []]) {
    const page = await loginPage({ mode: 'employee-code' }, {
      search: '?returnTo=%2Fform.html%3Fid%3DPCN-2026-0001', user: { employeeCode: '0012345', roles }
    });
    page.element('employeeCode').value = '0012345';
    page.element('employeeCode').events.input();
    await new Promise(setImmediate);
    assert.deepEqual(page.redirects, [roles.length ? '/form.html?id=PCN-2026-0001' : '/records']);
  }
});

test('invalid clipboard text is rejected before a browser can truncate it into another employee ID', async () => {
  for (const text of ['12345678', '12x34567', '123 4567', '\uff11\uff12\uff13\uff14\uff15\uff16\uff17']) {
    const page = await loginPage();
    const input = page.element('employeeCode');
    let prevented = false;
    input.events.paste({ clipboardData: { getData: () => text }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true, text);
    assert.equal(input.value, '');
    assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 0);
    assert.equal(page.element('employeeAuthMessage').textContent, 'Enter your 7-digit Employee ID.');
  }
  const page = await loginPage();
  let prevented = false;
  page.element('employeeCode').events.paste({ clipboardData: { getData: () => '0012345' }, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  page.element('employeeCode').value = '0012345';
  page.element('employeeCode').events.input();
  await new Promise(setImmediate);
  assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 1);
});

test('an incomplete server login response restores input and exposes a retryable error', async () => {
  const page = await loginPage({ mode: 'employee-code' }, { loginResponse: async () => ({ authenticated: false }) });
  page.element('employeeCode').value = '0012345';
  page.element('employeeCode').events.input();
  await new Promise(setImmediate);
  assert.equal(page.element('employeeAuthMessage').textContent, 'Employee sign-in did not complete. Please try again.');
  assert.equal(page.element('employeeCode').disabled, false);
  assert.equal(page.element('employeeLoginFormSubmit').disabled, false);
  assert.deepEqual(page.redirects, []);
});

test('pasting digits validates the combined value before maxlength can truncate the employee ID', async () => {
  for (const [initialCode, clipboardText] of [['12', '0012345'], ['123456', '78']]) {
    const page = await loginPage({ mode: 'employee-code' }, { initialCode });
    const input = page.element('employeeCode');
    input.selectionStart = initialCode.length;
    input.selectionEnd = initialCode.length;
    let prevented = false;
    input.events.paste({ clipboardData: { getData: () => clipboardText }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(input.value, initialCode);
    assert.equal(page.calls.filter((call) => call.url === '/api/auth/login').length, 0);
  }
  for (const [initialCode, start, end, clipboardText] of [['1234567', 0, 7, '0012345'], ['0012340', 6, 7, '5']]) {
    const page = await loginPage({ mode: 'employee-code' }, { initialCode });
    const input = page.element('employeeCode');
    input.selectionStart = start;
    input.selectionEnd = end;
    let prevented = false;
    input.events.paste({ clipboardData: { getData: () => clipboardText }, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    input.value = initialCode.slice(0, start) + clipboardText + initialCode.slice(end);
    input.events.input();
    await new Promise(setImmediate);
    assert.deepEqual(page.calls.filter((call) => call.url === '/api/auth/login').map((call) => call.options.body), [JSON.stringify({ employeeCode: '0012345' })]);
  }
});

test('administrators open the Portal after ordinary employee or password sign-in', async () => {
  for (const mode of ['employee-code', 'password']) {
    for (const role of ['admin', 'AdMiN']) {
      const page = await loginPage({ mode }, { user: { roles: [role] } });
      if (mode === 'employee-code') {
        page.element('employeeCode').value = '0012345';
        page.element('employeeCode').events.input();
      } else {
        page.element('username').value = 'portal-admin';
        page.element('password').value = 'fixture-password';
        page.element('loginForm').events.submit({ preventDefault() {} });
      }
      await new Promise(setImmediate);
      assert.deepEqual(page.redirects, ['/admin']);
    }
  }
});

test('authenticated administrators use the Portal for absent, empty, or rejected return destinations', async () => {
  for (const returnTo of [null, '', 'https://evil.example/', '//evil.example/', '/login', '/login.html', '/%2f%2fevil.example/', '/%0acreate', '/%broken', '/\\evil.example/']) {
    const search = returnTo === null ? '' : `?returnTo=${encodeURIComponent(returnTo)}`;
    const page = await loginPage({ mode: 'employee-code' }, { search, authenticated: true, user: { roles: ['ADMIN'] } });
    assert.deepEqual(page.redirects, ['/admin'], String(returnTo));
    assert.equal(page.calls.some((call) => call.url === '/api/auth/login'), false);
  }
});

test('administrators preserve valid explicit PCN links and create destinations after login', async () => {
  for (const destination of ['/form.html?id=PCN-2026-0001#workflow', '/create', '/records/../create']) {
    for (const authenticated of [false, true]) {
      const page = await loginPage({ mode: 'employee-code' }, {
        search: `?returnTo=${encodeURIComponent(destination)}`, authenticated, user: { roles: ['admin'] }
      });
      if (!authenticated) {
        page.element('employeeCode').value = '0012345';
        page.element('employeeCode').events.input();
        await new Promise(setImmediate);
      }
      assert.deepEqual(page.redirects, [destination === '/records/../create' ? '/create' : destination]);
    }
  }
});

test('password maintenance requires a fresh sign-in and then opens the Portal for an administrator', async () => {
  const page = await loginPage({ mode: 'password' }, {
    authenticated: true, user: { roles: ['admin'], mustChangePassword: true },
    loginResponse: async () => ({ authenticated: true, user: { roles: ['admin'], mustChangePassword: false } })
  });
  assert.equal(page.element('passwordChangeForm').hidden, false);
  assert.deepEqual(page.redirects, []);
  page.element('currentPassword').value = 'fixture-old-password';
  page.element('newPassword').value = 'fixture-new-password';
  page.element('confirmPassword').value = 'fixture-new-password';
  page.element('passwordChangeForm').events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.deepEqual(page.redirects, []);
  assert.equal(page.element('loginForm').hidden, false);
  page.element('loginForm').events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.deepEqual(page.redirects, ['/admin']);
});

test('every assigned role opens the Portal while roleless users open read-only Records', async () => {
  for (const roles of [['supplier'], ['reviewer'], ['gsc'], ['productionengineering'], ['qa'], ['tapbu'], ['qa', 'gsc'], []]) {
    const page = await loginPage({ mode: 'employee-code' }, { authenticated: true, user: { roles } });
    assert.deepEqual(page.redirects, [roles.length ? '/admin' : '/records']);
  }
});
