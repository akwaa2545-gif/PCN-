const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==';
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.hidden = false; this.textContent = ''; this.className = ''; this.classList = { add: (...names) => { this.className += ' ' + names.join(' '); } }; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this.textContent = ''; }
  appendChild(node) { this.append(node); return node; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  focus() { this.focused = true; }
  async emit(name, event = {}) { for (const handler of this.events[name] || []) await handler(event); }
}
function all(node, predicate) { return [node, ...node.children.flatMap(child => all(child, predicate))].filter(predicate); }
function profileClient(responder = async () => ({ status: 'unavailable', photo: '' })) {
  const container = new Element('div');
  const calls = [];
  const document = { createElement: tag => new Element(tag), getElementById: id => id === 'accountMenu' ? container : null, addEventListener() {} };
  const window = { location: { origin: 'https://pcn.example', pathname: '/admin', search: '', hash: '', assign() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'session-client.js'), 'utf8'), {
    document, window, URL, Headers, fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ success: true, data: await responder(url) }) };
    }
  });
  const find = name => all(container, node => node.className.split(/\s+/).includes(name))[0];
  return { api: window.PCN_SESSION, container, calls, find };
}
const user = { id: 'user-one', displayName: 'Employee Example', employeeCode: '0012345', identityProvider: 'employee-code', roles: ['admin'], department: 'it' };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('verified mail photo appears in both profile avatars without another lookup', () => {
  const c = profileClient();
  c.api.mountProfile({ ...user, email: 'employee@example.com', mailProfile: { photo, jobTitle: 'Engineer' } });
  const images = all(c.container, node => node.tagName === 'img');
  assert.equal(images.length, 2);
  assert(images.every(node => node.src === photo && node.alt === ''));
  assert.equal(c.find('account-panel-position').textContent, 'Engineer');
  assert.equal(c.calls.length, 0);
});

test('missing photo resolves only the authenticated self profile and does not replace access details', async () => {
  const c = profileClient(async () => ({ status: 'available', photo, email: 'employee@example.com', jobTitle: 'Engineer', roles: ['supplier'], department: 'other' }));
  c.api.mountProfile(user);
  await settle();
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].url, '/api/profile');
  assert.equal(c.calls[0].options.credentials, 'same-origin');
  assert.equal(all(c.container, node => node.tagName === 'img').length, 2);
  assert.equal(c.find('account-panel-email').textContent, 'employee@example.com');
  const values = all(c.container, node => node.tagName === 'dd').map(node => node.textContent);
  assert.deepEqual(values, ['0012345', 'Administrator', 'All signing steps', 'IT']);
});

test('unsupported, remote and oversized photos remain initials and cause no image requests', async () => {
  for (const unsafe of ['https://external.example/photo.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,' + 'A'.repeat(102400), 'data:image/png;base64,broken']) {
    const c = profileClient(async () => ({ status: 'available', photo: unsafe }));
    c.api.mountProfile({ ...user, mailProfile: { photo: unsafe } });
    await settle();
    assert.equal(all(c.container, node => node.tagName === 'img').length, 0);
    assert.equal(c.find('account-avatar').textContent, 'EE');
  }
});

test('a broken inline photo returns each avatar to initials', async () => {
  const c = profileClient();
  c.api.mountProfile({ ...user, mailProfile: { photo } });
  for (const image of all(c.container, node => node.tagName === 'img')) await image.emit('error');
  assert.equal(all(c.container, node => node.tagName === 'img').length, 0);
  assert.equal(c.find('account-avatar').textContent, 'EE');
});

test('late lookup cannot overwrite another mounted profile', async () => {
  let finish;
  const c = profileClient(() => new Promise(resolve => { finish = resolve; }));
  c.api.mountProfile(user);
  await settle();
  c.api.mountProfile({ ...user, id: 'user-two', displayName: 'Second Person', mailProfile: { photo } });
  finish({ status: 'available', photo, email: 'first@example.com', jobTitle: 'Wrong person' });
  await settle();
  assert.equal(c.find('account-panel-username').textContent, 'Second Person');
  assert.equal(c.find('account-panel-email').textContent, 'No email on file');
  assert.equal(c.find('account-panel-position').textContent, '');
});

test('directory failures keep the menu usable and explain the photo fallback', async () => {
  const c = profileClient(async () => { throw new Error('Directory unavailable'); });
  c.api.mountProfile(user);
  await settle();
  await c.find('account-trigger').emit('click');
  assert.equal(c.find('account-panel').hidden, false);
  assert.equal(c.find('account-avatar').textContent, 'EE');
  assert.equal(c.find('account-photo-status').textContent, 'Profile photo unavailable');
  assert.equal(c.find('account-sign-out').disabled, undefined);
});

test('profile identity is rendered as text and a roleless account keeps its access notice', async () => {
  const c = profileClient();
  c.api.mountProfile({ ...user, displayName: '<img onerror=alert(1)>', roles: [] });
  await settle();
  assert.equal(c.find('account-panel-username').textContent, '<img onerror=alert(1)>');
  assert.equal(c.find('account-access-warning').attributes.role, 'alert');
  assert.equal(c.find('account-sign-out').textContent, 'Sign out');
});

test('a PCN-only roleless account retains the profile access notice and safe display name', async () => {
  const c = profileClient();
  c.api.mountProfile({ ...user, identityProvider: 'pcn-local', employeeCode: '0098765',
    displayName: '<script>example</script>', roles: [] });
  await settle();
  assert.equal(c.find('account-panel-username').textContent, '<script>example</script>');
  assert.equal(c.find('account-access-warning').attributes.role, 'alert');
  assert.equal(c.find('account-sign-out').textContent, 'Sign out');
});
