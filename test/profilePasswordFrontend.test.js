const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const photo = 'data:image/png;base64,AAAA';
const employee = { id: 'employee-one', employeeCode: '0012345', displayName: 'Employee Example',
  identityProvider: 'employee-code', roles: [], canChangePassword: true, mailProfile: { photo } };
class Element {
  constructor(tag, document) {
    this.tagName = tag; this.ownerDocument = document; this.children = []; this.attributes = {};
    this.events = {}; this.hidden = false; this.open = false; this.value = ''; this.className = ''; this.textContent = '';
    this.classList = { add: (...names) => { this.className += ' ' + names.join(' '); } };
  }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = [...children]; this.textContent = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { (this.events[name] ||= []).push(listener); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; return this.emit('close'); }
  reset() { walk(this).filter(node => node.tagName === 'input').forEach(node => { node.value = ''; }); }
  async emit(name, event = {}) { for (const listener of this.events[name] || []) await listener({ preventDefault() {}, ...event }); }
}
function walk(node) { return [node, ...node.children.flatMap(walk)]; }
function client(responder) {
  const calls = [], redirects = [], timers = new Map(); let timerId = 0;
  const document = { activeElement: null, visibilityState: 'visible', addEventListener() {},
    createElement: tag => new Element(tag, document), getElementById: id => id === 'accountMenu' ? container : null };
  const container = new Element('div', document);
  const window = { document, navigator: { onLine: true }, location: { origin: 'https://pcn.example', pathname: '/admin', search: '?tab=records', hash: '', assign: url => redirects.push(url) },
    addEventListener() {}, setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../session-client.js'), 'utf8'), { window, document, URL, Headers,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const result = await responder(url, options);
      return { ok: !result.error, status: result.status || 200,
        json: async () => result.error ? { success: false, error: result.error, code: result.code } : { success: true, data: result.data } };
    } });
  return { api: window.PCN_SESSION, calls, redirects, timers, container, document,
    id: id => walk(container).find(node => node.id === id),
    find: className => walk(container).find(node => node.className.split(/\s+/).includes(className)) };
}
async function mounted(overrides = {}, response = { data: { authenticated: false, passwordChanged: true } }) {
  const user = { ...employee, ...overrides };
  const c = client(async url => url === '/api/session'
    ? { data: { authenticated: true, user, csrfToken: 'current-csrf' } }
    : typeof response === 'function' ? response(url) : response);
  await c.api.load(); c.api.mountProfile(user);
  return c;
}
async function open(c) { await c.find('account-change-password').emit('click'); }
function fill(c, currentPassword, newPassword, confirmPassword = newPassword) {
  c.id('accountCurrentPassword').value = currentPassword;
  c.id('accountNewPassword').value = newPassword;
  c.id('accountConfirmPassword').value = confirmPassword;
}

test('password capability adds an accessible profile dialog for roleless employees only when enabled', async () => {
  const c = await mounted();
  assert.equal(c.find('account-change-password').textContent, 'Change password');
  assert.equal(c.find('account-access-warning').attributes.role, 'alert');
  await open(c);
  assert.equal(c.id('accountPasswordDialog').open, true);
  assert.equal(c.id('accountPasswordDialog').attributes['aria-labelledby'], 'accountPasswordTitle');
  assert.equal(c.document.activeElement, c.id('accountCurrentPassword'));
  assert.equal(c.id('accountNewPassword').minLength, 8);
  assert.equal(c.id('accountNewPassword').maxLength, 8);
  assert.equal(c.id('accountNewPassword').pattern, '[A-Za-z0-9]{8}');
  const legacy = await mounted({ canChangePassword: false });
  assert.equal(legacy.find('account-change-password'), undefined);
  assert.equal(legacy.id('accountPasswordDialog'), undefined);
});

test('profile password validation accepts eight letters numbers or a mix without trimming', async () => {
  for (const password of ['12345678', 'abcdefgh', 'Ab12Cd34']) {
    const c = await mounted(); await open(c); fill(c, 'oldvalue', password);
    await c.id('accountPasswordForm').emit('submit');
    const write = c.calls.find(call => call.url === '/api/auth/change-password');
    assert.deepEqual(JSON.parse(write.options.body), { currentPassword: 'oldvalue', newPassword: password, confirmPassword: password });
    assert.equal(write.options.headers.get('x-csrf-token'), 'current-csrf');
    assert.equal(write.options.credentials, 'same-origin');
    assert.match(c.redirects[0], /^\/login\?passwordChanged=1&returnTo=/);
    assert.equal(c.id('accountPasswordDialog').open, false);
    assert.equal(c.id('accountCurrentPassword').value, '');
    assert.equal(c.id('accountNewPassword').value, '');
    assert.equal(c.id('accountConfirmPassword').value, '');
    assert.equal(c.timers.size, 0);
  }
});

test('invalid length symbols mismatch and unchanged password never send a password request', async () => {
  for (const [current, next, confirmation] of [
    ['oldvalue', '1234567', '1234567'], ['oldvalue', '123456789', '123456789'],
    ['oldvalue', '1234!678', '1234!678'], ['oldvalue', ' abcdefg', ' abcdefg'],
    ['oldvalue', 'abcdefgh', 'ABCDEFGH'], ['12345678', '12345678', '12345678'], ['', '12345678', '12345678']
  ]) {
    const c = await mounted(); await open(c); fill(c, current, next, confirmation);
    await c.id('accountPasswordForm').emit('submit');
    assert.equal(c.calls.filter(call => call.url === '/api/auth/change-password').length, 0);
    assert(c.id('accountPasswordMessage').textContent);
    assert.equal(c.id('accountPasswordDialog').open, true);
  }
});

test('wrong current password stays actionable and Escape clears secrets and returns focus', async () => {
  const c = await mounted({}, { error: 'Invalid current password', status: 400 });
  await open(c); fill(c, 'wrongold', '12345678');
  await c.id('accountPasswordForm').emit('submit');
  assert.equal(c.id('accountPasswordMessage').textContent, 'Invalid current password');
  assert.equal(c.id('accountCurrentPassword').value, '');
  assert.equal(c.id('accountPasswordSubmit').disabled, false);
  await c.id('accountPasswordDialog').emit('cancel');
  assert.equal(c.id('accountPasswordDialog').open, false);
  assert.equal(c.id('accountNewPassword').value, '');
  assert.equal(c.id('accountConfirmPassword').value, '');
  assert.equal(c.document.activeElement, c.find('account-trigger'));
  assert.equal(c.redirects.length, 0);
});

test('session expiry during a password change clears the dialog and returns to sign-in', async () => {
  const c = await mounted({}, { error: 'Sign in required', status: 401 });
  await open(c); fill(c, 'oldvalue', '12345678');
  await c.id('accountPasswordForm').emit('submit');
  assert.equal(c.id('accountPasswordDialog').open, false);
  assert.equal(c.id('accountCurrentPassword').value, '');
  assert.equal(c.id('accountNewPassword').value, '');
  assert.match(c.redirects[0], /^\/login\?returnTo=/);
});

test('a malformed success does not silently claim that a password change completed', async () => {
  const c = await mounted({}, { data: {} });
  await open(c); fill(c, 'oldvalue', '12345678');
  await c.id('accountPasswordForm').emit('submit');
  assert.match(c.id('accountPasswordMessage').textContent, /not be confirmed/);
  assert.equal(c.redirects.length, 0);
});

test('pending changes submit once and a failure after closing cannot repopulate the dialog', async () => {
  let finish;
  const c = await mounted({}, () => new Promise(resolve => { finish = resolve; }));
  await open(c); fill(c, 'oldvalue', '12345678');
  const request = c.id('accountPasswordForm').emit('submit');
  await new Promise(setImmediate);
  await c.id('accountPasswordForm').emit('submit');
  assert.equal(c.calls.filter(call => call.url === '/api/auth/change-password').length, 1);
  await c.id('accountPasswordDialog').close();
  assert.equal(c.id('accountCurrentPassword').value, '');
  finish({ error: 'Old request failed', status: 400 }); await request;
  assert.equal(c.id('accountPasswordMessage').textContent, '');
  assert.equal(c.id('accountNewPassword').value, '');
  assert.equal(c.find('account-change-password').disabled, false);
});

test('setup sessions do not heartbeat mount a profile or query business profile data', async () => {
  const user = { ...employee, passwordSetupRequired: true, mustChangePassword: true, canChangePassword: false };
  const c = client(async () => ({ data: { authenticated: true, user, csrfToken: 'setup-csrf' } }));
  await c.api.load(); c.api.mountProfile(user); await c.api.require(null);
  assert.equal(c.timers.size, 0);
  assert.equal(c.container.children.length, 0);
  assert.equal(c.calls.some(call => call.url === '/api/profile'), false);
  assert.match(c.redirects[0], /\/login\?returnTo=.*changePassword=1/);
});

test('setup-required protected response redirects to enrollment without exposing the target page', async () => {
  const c = client(async url => url === '/api/session' ? { data: { authenticated: true, user: employee, csrfToken: 'csrf' } }
    : { error: 'Set your password first', status: 403, code: 'PASSWORD_SETUP_REQUIRED' });
  await c.api.load();
  await assert.rejects(c.api.fetch('/api/pcns'), error => error.code === 'PASSWORD_SETUP_REQUIRED');
  assert.match(c.redirects[0], /\/login\?returnTo=.*changePassword=1/);
});

test('a late password-change reply cannot clear a newer sign-in or redirect its profile', async () => {
  let finish;
  const second = { ...employee, id: 'employee-two', employeeCode: '0098765' };
  const c = client(async url => {
    if (url === '/api/session') return { data: { authenticated: true, user: employee, csrfToken: 'old-csrf' } };
    if (url === '/api/auth/login') return { data: { authenticated: true, user: second, csrfToken: 'new-csrf' } };
    if (url === '/api/auth/change-password') return new Promise(resolve => { finish = resolve; });
    return { data: {} };
  });
  await c.api.load(); c.api.mountProfile(employee); await open(c); fill(c, 'oldvalue', '12345678');
  const pending = c.id('accountPasswordForm').emit('submit'); await new Promise(setImmediate);
  await c.api.fetch('/api/auth/login', { method: 'POST', body: '{}' }); c.api.mountProfile(second);
  finish({ data: { authenticated: false, passwordChanged: true } }); await pending;
  await c.api.fetch('/api/admin/users', { method: 'POST', body: '{}' });
  assert.equal(c.calls.at(-1).options.headers.get('x-csrf-token'), 'new-csrf');
  assert.equal(c.timers.size, 1); assert.equal(c.redirects.length, 0);
});

test('a newer accepted sign-in blocks a stale dialog redirect even before profile remount', async () => {
  let finish;
  const c = client(async url => {
    if (url === '/api/session') return { data: { authenticated: true, user: employee, csrfToken: 'old-csrf' } };
    if (url === '/api/auth/login') return { data: { authenticated: true, user: { ...employee, id: 'employee-two' }, csrfToken: 'new-csrf' } };
    if (url === '/api/auth/change-password') return new Promise(resolve => { finish = resolve; });
    return { data: {} };
  });
  await c.api.load(); c.api.mountProfile(employee); await open(c); fill(c, 'oldvalue', '12345678');
  const pending = c.id('accountPasswordForm').emit('submit'); await new Promise(setImmediate);
  await c.api.fetch('/api/auth/login', { method: 'POST', body: '{}' });
  finish({ data: { authenticated: false, passwordChanged: true } }); await pending;
  await c.api.fetch('/api/admin/users', { method: 'POST', body: '{}' });
  assert.equal(c.calls.at(-1).options.headers.get('x-csrf-token'), 'new-csrf');
  assert.equal(c.redirects.length, 0);
});
