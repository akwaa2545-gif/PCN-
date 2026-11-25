const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function login() {
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'login.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'window.LOGIN_TEST = { authenticationMode, employeeLoginBody };})();');
  vm.runInNewContext(source, { window, document: { addEventListener() {} } }, { filename: path.resolve(__dirname, '../login.js') });
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

test('employee form uses seven Employee ID boxes and a normal password control with maintenance access', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
  const form = html.match(/<form id="employeeLoginForm"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form);
  assert.match(form, /<label[^>]*for="employeeCode"[^>]*>Employee ID<\/label>/);
  assert.match(form, /<label[^>]*for="employeePassword"[^>]*>Password<\/label>/);
  assert.match(form, /id="employeeCode"[^>]*maxlength="7"/);
  assert.match(form, /id="employeePassword"[^>]*type="password"[^>]*autocomplete="current-password"/);
  assert.match(form, /id="employeeRemember"[^>]*type="checkbox"/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'auth.css'), 'utf8');
  assert.equal((form.match(/class="employee-pin-slot"/g) || []).length, 7);
  assert.doesNotMatch(css, /\.employee-password-mode \.employee-pin-slots[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /\.employee-password-mode #employeePassword\s*\{[\s\S]*?position:\s*static;[\s\S]*?opacity:\s*1;/);
  assert.doesNotMatch(html, /windowsLoginForm|Continue with Windows|SamAccountName/);
  assert.match(html, /id="loginForm"[^>]*hidden/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'auth.css'), 'utf8'), /\.auth-card \[hidden\]/);
});

test('partial Employee IDs preserve leading zeroes and completing seven digits checks the account only', async () => {
  const page = await loginPage({ mode: 'employee-password' });
  for (const value of ['0', '00123', '001234']) {
    page.element('employeeCode').value = value;
    page.element('employeeCode').events.input();
    page.element('employeeCode').events.change();
    assert.equal(page.element('employeeCode').value, value);
    assert.equal(page.calls.filter(call => call.url === '/api/auth/login').length, 0);
  }
  page.element('employeeCode').value = '0012345'; page.element('employeeCode').events.input(); page.element('employeeCode').events.change();
  await nextLoginTurn();
  assert.deepEqual(page.calls.filter(call => call.url === '/api/auth/login').map(call => JSON.parse(call.options.body)), [
    { employeeCode: '0012345', identifyOnly: true }
  ]);
  assert.equal(passwordRequests(page).length, 0);
  assert.deepEqual(page.redirects, []);
});

test('plain password editing retains partial values and never authenticates on input or change', async () => {
  const page = await loginPage({ mode: 'employee-password' });
  page.element('employeeCode').value = '0012345'; page.element('employeeCode').events.input();
  const password = page.element('employeePassword');
  for (const value of ['A', 'Ab12', 'Ab12Cd34']) {
    password.value = value; password.events.input(); password.events.change();
    assert.equal(password.value, value);
  }
  await nextLoginTurn();
  assert.deepEqual(page.calls.filter(call => call.url === '/api/auth/login').map(call => JSON.parse(call.options.body)), [
    { employeeCode: '0012345', identifyOnly: true }
  ]);
  assert.equal(passwordRequests(page).length, 0);
});

async function loginPage(config = { mode: 'employee-code' }, {
  search = '', authenticated = false, loginError = null,
  user = { mustChangePassword: false, roles: ['supplier'] }, loginResponse = null, initialCode = '', initialPassword = '', setupError = null, setupResponse = null,
  identifyResponse = null, identifyError = null
} = {}) {
  const elements = new Map();
  let activeElement = null;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, hidden: true, disabled: false, textContent: '', events: {}, requestSubmitCalls: 0,
      classList: {
        values: new Set(),
        toggle(name, active) { if (active) this.values.add(name); else this.values.delete(name); },
        contains(name) { return this.values.has(name); }
      },
      addEventListener(name, handler) { this.events[name] = handler; },
      requestSubmit() { this.requestSubmitCalls++; this.events.submit?.({ preventDefault() {} }); },
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      querySelectorAll(selector) { return id==='employeeLoginForm' && selector==='button'
        ? [element(`${id}Submit`),element('employeePasswordToggle')]
        : id==='passwordSetupForm' && selector==='button'
          ? [element(`${id}Submit`),element('setupPasswordToggle'),element('setupConfirmPasswordToggle'),element('setupSignOutButton')]
          : [element(`${id}Submit`)]; }, focus() {
        if (activeElement) activeElement.focused = false;
        activeElement = this; this.focused = true;
      }, reset() {}
    });
    return elements.get(id);
  }
  const calls = [];
  element('employeeCode').value = initialCode;
  element('employeePassword').value = initialPassword;
  element('employeeLoginFormSubmit').textContent = 'Sign in';
  const redirects = [];
  const navigationCredentials = [];
  let init;
  const events = {};
  const window = {
    addEventListener(name,handler){events[name]=handler;},
    location: { origin: 'https://pcn.example', pathname: '/login', search, hash: '', assign(url) {
      navigationCredentials.push({ employeeCode: element('employeeCode').value, password: element('employeePassword').value,
        usernameDisabled: element('employeeCode').disabled, passwordDisabled: element('employeePassword').disabled });
      redirects.push(url);
    } }
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
        if (url === '/api/auth/login' && JSON.parse(options.body).identifyOnly === true) {
          if (identifyError) throw identifyError;
          return identifyResponse ? identifyResponse() : {authenticated:false,passwordRequired:true};
        }
        if (url === '/api/auth/login' && loginError) throw loginError;
        if (url === '/api/auth/login' && loginResponse) return loginResponse();
        if (url === '/api/auth/setup-password') {
          if (setupError) throw setupError;
          return setupResponse ? setupResponse() : { authenticated: false, passwordSet: true };
        }
        return { authenticated: true, user };
      }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'login.js'), 'utf8'), {
    window, URLSearchParams, URL,
    document: { get activeElement() { return activeElement; }, getElementById: element, addEventListener(name, handler) { if (name === 'DOMContentLoaded') init = handler; } }
  }, { filename: path.resolve(__dirname, '../login.js') });
  await init();
  return { element, calls, redirects, navigationCredentials, events, get activeElement() { return activeElement; }, setConfig(value) { config = value; }, setLoginResponse(value) { loginResponse = value; } };
}

const nextLoginTurn = () => new Promise(setImmediate);
const submitLoginForm = async (page, id) => { page.element(id).events.submit({ preventDefault() {} }); await nextLoginTurn(); };
const identifyEmployee = async (page, code = '0012345') => {
  page.element('employeeCode').value = code; page.element('employeeCode').events.input(); await nextLoginTurn();
};
const passwordRequests = page => page.calls.filter(call => call.url === '/api/auth/login' && !JSON.parse(call.options.body).identifyOnly);

test('password manager form metadata pairs stable Employee ID and password fields with POST submission', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
  const form = html.match(/<form id="employeeLoginForm"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form);
  assert.match(form.match(/<form[^>]*>/)?.[0] || '', /method="post"/);
  assert.match(form.match(/<form[^>]*>/)?.[0] || '', /action="\/api\/auth\/login"/);
  assert.match(form, /id="employeeCode"[^>]*name="employeeCode"[^>]*autocomplete="username"/);
  assert.match(form, /id="employeePassword"[^>]*name="password"[^>]*autocomplete="current-password"/);
  assert.match(form, /<button[^>]*type="submit"/);
});

test('password manager cold autofill checks Employee ID only and retains credentials until explicit Sign in', async () => {
  const page = await loginPage({ mode: 'employee-password' }, { initialCode: '0012345', initialPassword: 'Ab12Cd34' });
  assert.equal(page.element('employeePassword').value, 'Ab12Cd34', 'Cold initialization must not discard native autofill');
  assert.equal(page.element('employeePasswordField').hidden, false, 'Password is visible beside the Employee ID from the start');
  assert.equal(page.element('employeePassword').disabled, false);
  assert.equal(page.element('employeeRemember').disabled, false);
  await nextLoginTurn();
  assert.deepEqual(page.calls.filter(call => call.url === '/api/auth/login').map(call => JSON.parse(call.options.body)), [
    { employeeCode: '0012345', identifyOnly: true }
  ]);
  assert.equal(passwordRequests(page).length, 0);
  await submitLoginForm(page, 'employeeLoginForm');
  assert.deepEqual(page.calls.filter(call => call.url === '/api/auth/login').map(call => JSON.parse(call.options.body)), [
    { employeeCode: '0012345', identifyOnly: true },
    { employeeCode: '0012345', password: 'Ab12Cd34' }
  ]);
  assert.deepEqual(page.redirects, ['/admin']);
});

test('automatic Employee ID checking never forwards autofilled passwords and keeps password controls available', async () => {
  for (const focusId of ['employeeCode', 'employeeRemember', 'employeePasswordToggle']) {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const page = await loginPage({ mode: 'employee-password' }, { identifyResponse: () => pending });
  page.element('employeeCode').focus();
  page.element('employeeCode').value = '0012345';
  page.element('employeePassword').value = 'abcdefgh';
  page.element('employeeCode').events.input();
  page.element('employeeCode').events.change();
  assert.deepEqual(page.calls.filter(call => call.url === '/api/auth/login').map(call => JSON.parse(call.options.body)), [
    { employeeCode: '0012345', identifyOnly: true }
  ]);
  assert.equal(page.element('employeeCode').disabled, false);
  assert.equal(page.element('employeeCode').readOnly, true);
  assert.equal(page.element('employeePassword').disabled, false);
  assert.equal(page.element('employeeRemember').disabled, false);
  assert.equal(page.element('employeeLoginFormSubmit').disabled, true);
  await submitLoginForm(page, 'employeeLoginForm');
  const password = page.element('employeePassword');
  password.value = 'abcdefgh';
  password.events.change();
  assert.equal(passwordRequests(page).length, 0, 'No credentials may bypass the pending identity check');
  page.element(focusId).focus();
  release({ authenticated: false, passwordRequired: true });
  await nextLoginTurn();
  assert.equal(passwordRequests(page).length, 0);
  assert.equal(page.element('employeeCode').readOnly, false);
  assert.equal(password.value, 'abcdefgh');
  assert.equal(page.element('employeePasswordField').hidden, false);
  assert.equal(page.activeElement, page.element(focusId === 'employeeCode' ? 'employeePassword' : focusId), 'A delayed account check may advance ID focus but must not steal focus from Remember me or Show password');
  page.element('employeeLoginForm').requestSubmit();
  await nextLoginTurn();
  assert.equal(passwordRequests(page).length, 1);
  assert.deepEqual(JSON.parse(passwordRequests(page)[0].options.body), { employeeCode: '0012345', password: 'abcdefgh' });
  assert.equal(page.element('employeeLoginForm').requestSubmitCalls, 1);
  assert.deepEqual(page.redirects, ['/admin']);
  }
});

test('a first-time account automatically opens restricted password setup after Employee ID completion', async () => {
  const page = await loginPage({ mode: 'employee-password' }, { identifyResponse: () => ({
    authenticated: true, user: { employeeCode: '0012345', roles: ['admin'], passwordSetupRequired: true }
  }) });
  page.element('employeeCode').value = '0012345'; page.element('employeeCode').events.input(); page.element('employeeCode').events.change();
  await nextLoginTurn();
  assert.deepEqual(page.calls.filter(call => call.url === '/api/auth/login').map(call => JSON.parse(call.options.body)), [
    { employeeCode: '0012345', identifyOnly: true }
  ]);
  assert.equal(page.element('passwordSetupForm').hidden, false);
  assert.equal(page.element('employeeLoginForm').hidden, true);
  assert.equal(page.element('setupEmployeeCode').value, '0012345');
  assert.equal(passwordRequests(page).length, 0); assert.deepEqual(page.redirects, []);
});

test('password manager receives explicit native submission and populated enabled credentials before successful navigation', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const page = await loginPage({ mode: 'employee-password' }, { loginResponse: () => pending });
  await identifyEmployee(page);
  const password = page.element('employeePassword');
  password.value = 'Ab12Cd34';
  password.events.input();
  password.events.change();
  assert.equal(passwordRequests(page).length, 0, 'Typing and browser autofill must not automatically send credentials');
  page.element('employeeLoginForm').requestSubmit();
  assert.equal(page.element('employeeLoginForm').requestSubmitCalls, 1);
  assert.equal(passwordRequests(page).length, 1);
  release({ authenticated: true, user: { roles: ['qa'] } });
  await nextLoginTurn();
  assert.deepEqual(page.navigationCredentials, [{ employeeCode: '0012345', password: 'Ab12Cd34', usernameDisabled: false, passwordDisabled: false }]);
  password.events.input(); password.events.change();
  await submitLoginForm(page, 'employeeLoginForm');
  assert.equal(passwordRequests(page).length, 1, 'A completed sign-in cannot restart while navigation is pending');
  page.events.pagehide();
  assert.equal(password.value, '', 'Leaving the page still removes credentials from the old document');
});

test('password manager setup form associates the new password with the checked Employee ID without expanding the API body', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
  const form = html.match(/<form id="passwordSetupForm"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form);
  assert.match(form.match(/<form[^>]*>/)?.[0] || '', /method="post"/);
  assert.match(form.match(/<form[^>]*>/)?.[0] || '', /action="\/api\/auth\/setup-password"/);
  assert.match(form, /<input[^>]*id="setupEmployeeCode"[^>]*autocomplete="username"[^>]*readonly[^>]*hidden/);
  const page = await loginPage({ mode: 'employee-password' }, { authenticated: true,
    user: { roles: [], employeeCode: '0012345', passwordSetupRequired: true } });
  assert.equal(page.element('setupEmployeeCode').value, '0012345');
  page.element('setupPassword').value = 'Ab12Cd34'; page.element('setupConfirmPassword').value = 'Ab12Cd34';
  await submitLoginForm(page, 'passwordSetupForm');
  assert.deepEqual(JSON.parse(page.calls.find(call => call.url === '/api/auth/setup-password').options.body), {
    newPassword: 'Ab12Cd34', confirmPassword: 'Ab12Cd34'
  });
  assert.equal(page.element('setupPassword').value, '');
  assert.equal(page.element('setupConfirmPassword').value, '');
});

test('employee password visibility toggles without changing its value and remasks on pagehide',async()=>{
  const page=await loginPage({mode:'employee-password'});
  await identifyEmployee(page);
  const password=page.element('employeePassword'),toggle=page.element('employeePasswordToggle');
  password.value='Ab12Cd34';
  assert.equal(password.type,'password');
  toggle.events.click();assert.equal(password.type,'text');assert.equal(password.value,'Ab12Cd34');
  assert.equal(toggle.attributes['aria-label'],'Hide password');assert.equal(toggle.attributes['aria-pressed'],'true');
  toggle.events.click();assert.equal(password.type,'password');assert.equal(toggle.attributes['aria-label'],'Show password');
  toggle.events.click();page.events.pagehide();assert.equal(password.value,'');assert.equal(password.type,'password');
});

test('ordinary password remains masked during editing and clears on pagehide', async () => {
  const page = await loginPage({ mode: 'employee-password' });
  await identifyEmployee(page);
  const input = page.element('employeePassword');
  input.value = 'Ab12Cd34'; input.events.input(); input.events.change();
  assert.equal(input.type, 'password');
  assert.equal(input.value, 'Ab12Cd34');
  assert.equal(passwordRequests(page).length, 0);
  page.element('employeePasswordToggle').events.click();
  assert.equal(input.type, 'text'); assert.equal(input.value, 'Ab12Cd34');
  page.events.pagehide();
  assert.equal(input.value, ''); assert.equal(input.type, 'password');
});

test('setup password controls reveal independently and clear both fields after mismatch and pagehide', async () => {
  const page = await loginPage({ mode: 'employee-password' }, { authenticated: true, user: { passwordSetupRequired: true } });
  const first = page.element('setupPassword'), confirmation = page.element('setupConfirmPassword');
  first.value = 'Ab12Cd34'; confirmation.value = '12345678';
  page.element('setupPasswordToggle').events.click();
  assert.equal(first.type, 'text'); assert.equal(confirmation.type, 'password');
  page.element('setupConfirmPasswordToggle').events.click();
  assert.equal(confirmation.type, 'text');
  assert.equal(page.calls.some(call => call.url === '/api/auth/setup-password'), false);
  await submitLoginForm(page, 'passwordSetupForm');
  assert.match(page.element('authMessage').textContent, /do not match/);
  for (const id of ['setupPassword', 'setupConfirmPassword']) {
    assert.equal(page.element(id).value, ''); assert.equal(page.element(id).type, 'password');
    assert.equal(page.element(id + 'Toggle').attributes['aria-pressed'], 'false');
    page.element(id).value = 'abcdefgh'; page.element(id + 'Toggle').events.click();
  }
  page.events.pagehide();
  for (const id of ['setupPassword', 'setupConfirmPassword']) {
    assert.equal(page.element(id).value, ''); assert.equal(page.element(id).type, 'password');
  }
});

test('setup request masks and disables both password controls until its response', async () => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const page = await loginPage({ mode: 'employee-password' }, { authenticated: true, user: { passwordSetupRequired: true }, setupResponse: () => pending });
  for (const id of ['setupPassword', 'setupConfirmPassword']) {
    page.element(id).value = 'Ab12Cd34'; page.element(id + 'Toggle').events.click();
  }
  await submitLoginForm(page, 'passwordSetupForm');
  for (const id of ['setupPassword', 'setupConfirmPassword']) {
    assert.equal(page.element(id).disabled, true); assert.equal(page.element(id).type, 'password');
    assert.equal(page.element(id + 'Toggle').disabled, true);
    assert.equal(page.element(id + 'ToggleText').textContent, 'Show');
  }
  finish({ authenticated: false, passwordSet: true }); await nextLoginTurn();
  assert.equal(page.element('employeeLoginForm').hidden, false);
  for (const id of ['setupPassword', 'setupConfirmPassword']) {
    assert.equal(page.element(id).value, ''); assert.equal(page.element(id).disabled, false);
  }
});

test('Remember me sends true only when selected and stays disabled in code-only mode',async()=>{
  for(const remember of [false,true]) {
    const page=await loginPage({mode:'employee-password'});
    await identifyEmployee(page);
    assert.equal(page.element('employeeRemember').checked,false);
    assert.equal(page.element('employeeRemember').disabled,false);
    page.element('employeeCode').value='0012345';page.element('employeePassword').value='12345678';
    page.element('employeeRemember').checked=remember;
    await submitLoginForm(page,'employeeLoginForm');
    const body=JSON.parse(passwordRequests(page)[0].options.body);
    assert.equal(body.remember,remember?true:undefined);
    assert.equal(page.element('employeePassword').value,'12345678');
    page.events.pagehide(); assert.equal(page.element('employeePassword').value,'');
  }
  const legacy=await loginPage({mode:'employee-code'});
  assert.equal(legacy.element('employeeRemember').disabled,true);
  assert.equal(legacy.element('employeePasswordToggle').disabled,true);
});

test('pending sign-in masks and disables password controls without rewriting the Show label',async()=>{
  let release;
  const page=await loginPage({mode:'employee-password'},{loginResponse:()=>new Promise(resolve=>{release=resolve;})});
  await identifyEmployee(page);
  page.element('employeeCode').value='0012345';page.element('employeePassword').value='abcdefgh';
  page.element('employeePasswordToggle').events.click();
  await submitLoginForm(page,'employeeLoginForm');
  assert.equal(page.element('employeePassword').type,'password');
  assert.equal(page.element('employeePasswordToggle').disabled,true);
  assert.equal(page.element('employeeRemember').disabled,true);
  assert.equal(page.element('employeePasswordToggleText').textContent,'Show');
  release({authenticated:false});await nextLoginTurn();
  assert.equal(page.element('employeePasswordToggleText').textContent,'Show');
  assert.equal(page.element('employeePasswordToggle').disabled,false);
  assert.equal(page.element('employeePassword').value,'');
});

test('employee password mode starts with both fields, checks the ID and waits for explicit Sign in', async () => {
  const page = await loginPage({ mode: 'employee-password' });
  assert.equal(page.element('employeeLoginForm').hidden, false);
  assert.equal(page.element('employeePasswordField').hidden, false);
  assert.equal(page.element('employeePassword').disabled, false);
  assert.equal(page.element('employeeRemember').disabled, false);
  assert.equal(page.element('employeeLoginFormSubmit').textContent, 'Sign in');
  page.element('employeeCode').value = '0012345'; page.element('employeeCode').events.input(); page.element('employeeCode').events.change();
  page.element('employeePassword').value = '12345678'; page.element('employeePassword').events.input(); page.element('employeePassword').events.change();
  await nextLoginTurn();
  assert.deepEqual(page.calls.filter(call => call.url === '/api/auth/login').map(call => JSON.parse(call.options.body)), [
    { employeeCode: '0012345', identifyOnly: true }
  ]);
  assert.equal(passwordRequests(page).length, 0);
  await submitLoginForm(page, 'employeeLoginForm');
  assert.deepEqual(page.calls.filter(call => call.url === '/api/auth/login').map(call => JSON.parse(call.options.body)), [
    { employeeCode: '0012345', identifyOnly: true },
    { employeeCode: '0012345', password: '12345678' }
  ]);
  assert.equal(page.element('employeePassword').value, '12345678');
  assert.deepEqual(page.redirects, ['/admin']);
  page.events.pagehide(); assert.equal(page.element('employeePassword').value, '');
});

test('explicit password submission starts one pending sign-in and preserves Remember me', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const page = await loginPage({ mode: 'employee-password' }, { loginResponse: () => pending });
  await identifyEmployee(page); page.element('employeeRemember').checked = true;
  const input = page.element('employeePassword');
  input.value = 'Ab12Cd34'; input.events.input(); input.events.change();
  assert.equal(passwordRequests(page).length, 0);
  await submitLoginForm(page, 'employeeLoginForm');
  await submitLoginForm(page, 'employeeLoginForm');
  assert.equal(passwordRequests(page).length, 1);
  assert.deepEqual(JSON.parse(passwordRequests(page)[0].options.body), { employeeCode: '0012345', password: 'Ab12Cd34', remember: true });
  assert.equal(input.disabled, true);
  release({ authenticated: true, user: { roles: ['qa'] } }); await nextLoginTurn();
  assert.deepEqual(page.redirects, ['/admin']); assert.equal(input.value, 'Ab12Cd34');
  page.events.pagehide(); assert.equal(input.value, '');
});

test('failed password sign-in clears credentials and waits for deliberate explicit retry', async () => {
  const page = await loginPage({ mode: 'employee-password' }, { loginError: new Error('Invalid employee code or password') });
  await identifyEmployee(page); const input = page.element('employeePassword');
  input.value = '12345678'; input.events.change(); await nextLoginTurn();
  assert.equal(passwordRequests(page).length, 0);
  await submitLoginForm(page, 'employeeLoginForm');
  assert.equal(passwordRequests(page).length, 1); assert.equal(input.value, '');
  for (const event of ['input', 'change']) input.events[event](); await nextLoginTurn();
  assert.equal(passwordRequests(page).length, 1); assert.match(page.element('employeeAuthMessage').textContent, /Invalid/);
  input.value = 'abcdefgh'; input.events.input(); await nextLoginTurn();
  assert.equal(passwordRequests(page).length, 1);
  await submitLoginForm(page, 'employeeLoginForm');
  assert.equal(passwordRequests(page).length, 2);
});

test('explicit password submission rejects invalid values and paste before maxlength can truncate it', async () => {
  const page = await loginPage({ mode: 'employee-password' }); await identifyEmployee(page);
  const input = page.element('employeePassword');
  for (const value of ['1234567', '123456789', 'abcd123!']) {
    input.value = value; input.events.input(); await submitLoginForm(page, 'employeeLoginForm');
    assert.equal(passwordRequests(page).length, 0, value);
  }
  for (const text of ['123456789', 'abcd123!', ' abcd1234']) {
    let prevented = false; input.value = '';
    input.events.paste({ clipboardData: { getData: () => text }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  let prevented = false;
  input.events.paste({ clipboardData: { getData: () => 'Ab12Cd34' }, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  input.value = 'Ab12Cd34'; input.events.input(); await nextLoginTurn();
  assert.equal(passwordRequests(page).length, 0);
  await submitLoginForm(page, 'employeeLoginForm'); assert.equal(passwordRequests(page).length, 1);
});

test('editing Employee ID resets prior credentials before automatically checking the next complete ID', async () => {
  const page = await loginPage({ mode: 'employee-password' }); await identifyEmployee(page);
  page.element('employeePassword').value = 'Ab12Cd34'; page.element('employeePasswordToggle').events.click();
  page.element('employeeRemember').checked = true;
  page.element('employeeCode').value = '001234'; page.element('employeeCode').events.input();
  assert.equal(page.element('employeePasswordField').hidden, false);
  assert.equal(page.element('employeePassword').value, ''); assert.equal(page.element('employeePassword').type, 'password');
  assert.equal(page.element('employeeRemember').checked, false); assert.equal(page.element('employeeRemember').disabled, false);
  await identifyEmployee(page, '0012346');
  assert.equal(page.element('employeePasswordField').hidden, false);
  assert.deepEqual(page.calls.filter(call => call.url === '/api/auth/login').map(call => JSON.parse(call.options.body)), [
    { employeeCode: '0012345', identifyOnly: true }, { employeeCode: '0012346', identifyOnly: true }
  ]);
  assert.equal(passwordRequests(page).length, 0);
});

test('automatic identification blocks duplicates and ignores stale Employee ID responses', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const page = await loginPage({ mode: 'employee-password' }, { identifyResponse: () => pending });
  const input = page.element('employeeCode'); input.value = '0012345'; input.events.input(); input.events.change();
  assert.equal(page.calls.filter(call => call.url === '/api/auth/login').length, 1);
  await submitLoginForm(page, 'employeeLoginForm'); await submitLoginForm(page, 'employeeLoginForm');
  assert.equal(input.disabled, false); assert.equal(input.readOnly, true);
  assert.equal(page.calls.filter(call => call.url === '/api/auth/login').length, 1);
  input.value = '0012346'; release({ authenticated: false, passwordRequired: true }); await nextLoginTurn();
  assert.equal(page.element('employeePasswordField').hidden, false);
  assert.match(page.element('employeeAuthMessage').textContent, /changed/);
  assert.deepEqual(page.redirects, []); assert.equal(page.element('passwordSetupForm').hidden, true);
  await submitLoginForm(page, 'employeeLoginForm');
  assert.equal(page.calls.filter(call => call.url === '/api/auth/login').length, 2);
});

test('automatic identification rejects malformed full-access replies and does not retry from unchanged input', async () => {
  for (const response of [{ authenticated: false }, { authenticated: true, user: { roles: ['admin'] } }, { authenticated: false, passwordRequired: 'true' }]) {
    const page = await loginPage({ mode: 'employee-password' }, { identifyResponse: () => response });
    await identifyEmployee(page);
    assert.deepEqual(page.redirects, []); assert.equal(page.element('passwordSetupForm').hidden, true);
    assert.match(page.element('employeeAuthMessage').textContent, /did not complete/);
  }
  const page = await loginPage({ mode: 'employee-password' }, { identifyError: new Error('Too many sign-in attempts. Try again shortly') });
  await identifyEmployee(page);
  page.element('employeeCode').events.input(); page.element('employeeCode').events.change(); await nextLoginTurn();
  assert.equal(page.calls.filter(call => call.url === '/api/auth/login').length, 1);
  assert.match(page.element('employeeAuthMessage').textContent, /Too many/);
  await submitLoginForm(page, 'employeeLoginForm'); assert.equal(page.calls.filter(call => call.url === '/api/auth/login').length, 2);
});

test('restored Employee ID auto-checks once and pagehide invalidates its pending response', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const page = await loginPage({ mode: 'employee-password' }, { initialCode: '0012345', identifyResponse: () => pending });
  page.element('employeeCode').events.change(); assert.equal(page.calls.filter(call => call.url === '/api/auth/login').length, 1);
  await submitLoginForm(page, 'employeeLoginForm'); page.events.pagehide();
  release({ authenticated: true, user: { passwordSetupRequired: true } }); await nextLoginTurn();
  assert.equal(page.element('passwordSetupForm').hidden, true); assert.deepEqual(page.redirects, []);
});

test('blank-password Sign in still checks event-free autofill and focuses the ordinary password field', async () => {
  const page = await loginPage({ mode: 'employee-password' });
  page.element('employeeCode').value = '0012345';
  await submitLoginForm(page, 'employeeLoginForm');
  assert.deepEqual(JSON.parse(page.calls.find(call => call.url === '/api/auth/login').options.body), { employeeCode: '0012345', identifyOnly: true });
  assert.equal(page.element('employeePasswordField').hidden, false); assert.equal(page.element('employeePassword').focused, true);
  page.element('employeeCode').events.change(); await nextLoginTurn();
  assert.equal(page.calls.filter(call => call.url === '/api/auth/login').length, 1);
  assert.equal(page.element('employeePasswordField').hidden, false); assert.deepEqual(page.redirects, []);
});

test('first employee password sign-in opens setup and requires a fresh password sign-in afterward', async () => {
  const page = await loginPage({ mode: 'employee-password' }, {
    search: '?returnTo=%2Fform.html%3Fid%3DT-20112601',
    identifyResponse: async () => ({ authenticated: true, user: { roles: ['qa'], passwordSetupRequired: true, mustChangePassword: true } })
  });
  page.element('employeeCode').value = '0012345';
  page.element('employeeCode').events.input();await nextLoginTurn();
  assert.deepEqual(JSON.parse(page.calls.find(call => call.url === '/api/auth/login').options.body), { employeeCode: '0012345', identifyOnly:true });
  assert.equal(page.element('passwordSetupForm').hidden, false);
  assert.equal(page.element('employeeLoginForm').hidden, true);
  assert.equal(page.element('passwordChangeForm').hidden, true);
  assert.equal(page.element('setupPassword').focused, true);
  assert.deepEqual(page.redirects, []);
  page.element('setupPassword').value = 'abcdefgh'; page.element('setupConfirmPassword').value = 'abcdefgh';
  await submitLoginForm(page, 'passwordSetupForm');
  assert.deepEqual(JSON.parse(page.calls.find(call => call.url === '/api/auth/setup-password').options.body), { newPassword: 'abcdefgh', confirmPassword: 'abcdefgh' });
  assert.equal(page.element('passwordSetupForm').hidden, true);
  assert.equal(page.element('employeeLoginForm').hidden, false);
  assert.equal(page.element('setupPassword').value, '');
  assert.equal(page.element('setupConfirmPassword').value, '');
  assert.match(page.element('employeeAuthMessage').textContent, /Password set.*Sign in/i);
  assert.deepEqual(page.redirects, []);
  page.setLoginResponse(async () => ({ authenticated: true, user: { roles: ['qa'], canChangePassword: true } }));
  page.element('employeePassword').value = 'abcdefgh';
  await submitLoginForm(page, 'employeeLoginForm');
  assert.deepEqual(page.redirects, ['/form.html?id=T-20112601']);
});

test('a restored setup-only session cannot redirect into the portal', async () => {
  const page = await loginPage({ mode: 'employee-password' }, {
    authenticated: true, user: { roles: ['admin'], passwordSetupRequired: true, mustChangePassword: true }
  });
  assert.equal(page.element('passwordSetupForm').hidden, false);
  assert.deepEqual(page.redirects, []);
});

test('employee setup accepts numeric, letter-only or mixed eight-character passwords', async () => {
  for (const value of ['12345678', 'abcdefgh', 'Ab12Cd34']) {
    const page = await loginPage({ mode: 'employee-password' }, { authenticated: true, user: { roles: [], passwordSetupRequired: true } });
    page.element('setupPassword').value = value; page.element('setupConfirmPassword').value = value;
    await submitLoginForm(page, 'passwordSetupForm');
    assert.equal(page.calls.filter(call => call.url === '/api/auth/setup-password').length, 1, value);
    assert.equal(page.element('employeeLoginForm').hidden, false);
  }
});

test('employee setup rejects invalid lengths, non-alphanumeric values and mismatched confirmation without a request', async () => {
  for (const [value, confirmation, message] of [
    ['1234567', '1234567', /8/], ['123456789', '123456789', /8/],
    ['abcd!234', 'abcd!234', /letters|numbers/], ['12345678', 'abcdefgh', /match/]
  ]) {
    const page = await loginPage({ mode: 'employee-password' }, { authenticated: true, user: { roles: [], passwordSetupRequired: true } });
    page.element('setupPassword').value = value; page.element('setupConfirmPassword').value = confirmation;
    await submitLoginForm(page, 'passwordSetupForm');
    assert.equal(page.calls.some(call => call.url === '/api/auth/setup-password'), false);
    assert.equal(page.element('passwordSetupForm').hidden, false);
    assert.match(page.element('authMessage').textContent, message);
    assert.equal(page.element('setupPassword').value, '');
  }
});

test('employee login and setup failures clear password fields and allow retry', async () => {
  const login = await loginPage({ mode: 'employee-password' }, { loginError: new Error('Invalid employee code or password') });
  await identifyEmployee(login);
  login.element('employeeCode').value = '0012345'; login.element('employeePassword').value = '12345678';
  await submitLoginForm(login, 'employeeLoginForm');
  assert.equal(login.element('employeePassword').value, '');
  assert.equal(login.element('employeePassword').disabled, false);
  assert.equal(login.element('employeeLoginFormSubmit').disabled, false);
  assert.match(login.element('employeeAuthMessage').textContent, /Invalid/);
  const setup = await loginPage({ mode: 'employee-password' }, { authenticated: true, user: { passwordSetupRequired: true }, setupError: new Error('Setup expired. Sign in again') });
  setup.element('setupPassword').value = '12345678'; setup.element('setupConfirmPassword').value = '12345678';
  await submitLoginForm(setup, 'passwordSetupForm');
  assert.equal(setup.element('passwordSetupForm').hidden, false);
  assert.equal(setup.element('setupPassword').value, '');
  assert.equal(setup.element('passwordSetupFormSubmit').disabled, false);
  assert.match(setup.element('authMessage').textContent, /expired/);
});

test('employee password profile-change success is shown at login and roleless users retain Records routing', async () => {
  const page = await loginPage({ mode: 'employee-password' }, { search: '?passwordChanged=1', user: { roles: [] } });
  assert.match(page.element('employeeAuthMessage').textContent, /Password changed/);
  await identifyEmployee(page);
  page.element('employeeCode').value = '0012345'; page.element('employeePassword').value = 'abcdefgh';
  await submitLoginForm(page, 'employeeLoginForm');
  assert.deepEqual(page.redirects, ['/records']);
});

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
