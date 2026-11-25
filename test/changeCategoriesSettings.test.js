const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../system-settings');
const admin = { isActive: true, roles: ['admin'] };
const settings = () => ({ versionId: 4, forms: {
  rawMaterial: [{ text: 'Raw material option', risk: 'RL2', enabled: true }],
  packaging: [{ text: 'Packaging option', risk: 'RL1', enabled: true }]
} });
function fixture(fetch) {
  const nodes = new Map(), calls = [], events = {};
  function make(tag = 'div') {
    const node = { tagName: tag.toUpperCase(), value: '', checked: false, disabled: false, hidden: true, textContent: '', children: [], events: {}, attributes: {},
      append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); }, replaceChildren(...items) { this.children = [...items]; },
      setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, fn) { this.events[name] = fn; }, focus() { this.focused = true; } };
    Object.defineProperty(node, 'id', { set(value) { nodes.set(value, node); }, get() { return [...nodes].find(([, item]) => item === node)?.[0]; } });
    return node;
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); };
  const root = { document: { getElementById: get, createElement: make }, addEventListener(name, fn) { events[name] = fn; }, setInterval() {},
    confirm() { return root.confirmResult !== false; }, PCN_SESSION: { async require() { return { user: admin }; }, mountProfile() {},
      async fetch(url, options) { calls.push({ url, options }); return fetch?.(url, options) ?? (url === '/api/session' ? { authenticated: true, user: admin } : settings()); } } };
  return { root, get, calls, events };
}
function input(page, id, value, event = 'input') { page.get(id).value = value; page.get(id).events[event](); }

test('master category editor validates bounded snapshots and keeps disabled options visible', () => {
  const original = settings(); original.forms.packaging.push({ text: 'Archived option', risk: 'RL3', enabled: false });
  assert.deepEqual(ui.parseCategorySettings(original), original);
  assert.throws(() => ui.parseCategorySettings({ ...original, versionId: '4' }));
  for (const row of [{ text: '', risk: 'RL1', enabled: true }, { text: 'Invalid', risk: 'RL4', enabled: true }, { text: 'Invalid', risk: 'RL1', enabled: 'true' }]) {
    assert.throws(() => ui.parseCategorySettings({ ...settings(), forms: { ...settings().forms, packaging: [row] } }));
  }
});

test('Content of Changes loads only when selected, supports edits and additions and saves exact current version with reason', async () => {
  const page = fixture((url, options) => options?.method === 'PUT' ? { ...JSON.parse(options.body), versionId: 5 } : undefined);
  const controller = await ui.mount(page.root);
  assert.equal(page.calls.length, 0);
  await controller.openCategories();
  assert.equal(page.get('changeCategoriesEditor').hidden, false);
  assert.equal(page.get('changeCategoriesTitle').focused, true);
  assert.equal(page.get('settingsHome').hidden, true);
  input(page, 'changeCategory-rawMaterial-0-text', 'Edited material wording');
  input(page, 'changeCategory-rawMaterial-0-risk', 'RL0', 'change');
  page.get('changeCategoriesAdd-packaging-RL1').events.click();
  input(page, 'changeCategory-packaging-1-text', 'Added packaging option');
  page.get('changeCategory-packaging-0-enabled').checked = false;
  page.get('changeCategory-packaging-0-enabled').events.change();
  input(page, 'changeCategoriesReason', 'Update category guidance');
  await controller.save();
  const sent = JSON.parse(page.calls.find(call => call.options?.method === 'PUT').options.body);
  assert.equal(sent.versionId, 4); assert.equal(sent.reason, 'Update category guidance');
  assert.equal(sent.forms.rawMaterial[0].text, 'Edited material wording'); assert.equal(sent.forms.rawMaterial[0].risk, 'RL0');
  assert.equal(sent.forms.packaging[0].enabled, false); assert.equal(sent.forms.packaging.length, 2);
  assert.equal(page.get('changeCategoriesVersion').textContent, 'Master data version 5');
  assert.match(page.get('settingsStatus').textContent, /new PCNs/i);
});

test('master categories require a reason, retain conflict edits and share discard and access-loss guards', async () => {
  let revoked = false;
  const page = fixture((url, options) => {
    if (url === '/api/session') return { authenticated: !revoked, user: admin };
    if (options?.method === 'PUT') throw Object.assign(new Error('Conflict'), { status: 409 });
  });
  const controller = await ui.mount(page.root); await controller.openCategories();
  input(page, 'changeCategory-packaging-0-text', 'Keep this draft');
  await controller.save();
  assert.equal(page.calls.some(call => call.options?.method === 'PUT'), false);
  input(page, 'changeCategoriesReason', 'Reason'); await controller.save();
  assert.equal(page.get('changeCategory-packaging-0-text').value, 'Keep this draft');
  assert.match(page.get('settingsStatus').textContent, /changed.*preserved/i);
  let prevented = false; page.events.beforeunload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  page.root.confirmResult = false; controller.showHome(); assert.equal(page.get('changeCategoriesEditor').hidden, false);
  revoked = true; await controller.checkAccess();
  assert.equal(page.get('changeCategoriesEditor').hidden, true); assert.equal(page.get('changeCategoriesRows').children.length, 0);
  assert.equal(page.get('changeCategoriesReason').value, '');
});

test('invalid option drafts never publish and malformed reloads preserve editable values', async () => {
  let malformed = false;
  const page = fixture(() => malformed ? { versionId: 5, forms: {} } : undefined);
  const controller = await ui.mount(page.root); await controller.openCategories();
  page.get('changeCategory-packaging-0-enabled').checked = false;
  page.get('changeCategory-packaging-0-enabled').events.change();
  input(page, 'changeCategoriesReason', 'A reason'); await controller.save();
  assert.equal(page.calls.some(call => call.options?.method === 'PUT'), false);
  assert.match(page.get('settingsStatus').textContent, /at least one enabled/i);
  malformed = true; await controller.reload(false);
  assert.equal(page.get('changeCategory-packaging-0-enabled').checked, false);
  assert.equal(page.get('changeCategoriesReason').value, 'A reason');
  assert.match(page.get('settingsStatus').textContent, /invalid.*preserved/i);
});

test('access loss clears a pending category save and late success cannot restore it', async () => {
  let finish;
  const page = fixture((url, options) => {
    if (url === '/api/session') return { authenticated: false };
    if (options?.method === 'PUT') return new Promise(resolve => { finish = resolve; });
  });
  const controller = await ui.mount(page.root); await controller.openCategories();
  input(page, 'changeCategory-rawMaterial-0-text', 'Pending edit'); input(page, 'changeCategoriesReason', 'Audit reason');
  const pending = controller.save();
  assert.equal(page.get('settingsBack').disabled, true);
  controller.showHome(); assert.equal(page.get('changeCategoriesEditor').hidden, false);
  await controller.checkAccess(); finish({ ...settings(), versionId: 5 }); await pending;
  assert.equal(page.get('changeCategoriesEditor').hidden, true);
  assert.equal(page.get('changeCategoriesRows').children.length, 0);
  assert.equal(page.get('changeCategoriesReason').value, '');
  assert.match(page.get('settingsStatus').textContent, /Administrator access required/i);
});

test('risk groups collapse independently and adding under a level keeps the API option order and focuses its new wording', async () => {
  const page = fixture((url, options) => options?.method === 'PUT' ? { ...JSON.parse(options.body), versionId: 5 } : undefined);
  const controller = await ui.mount(page.root); await controller.openCategories();
  assert.equal(page.get('changeCategoriesRisk-rawMaterial-RL3').tagName, 'DETAILS');
  assert.equal(page.get('changeCategoriesRisk-rawMaterial-RL3').open, true);
  assert.equal(page.get('changeCategoriesRisk-rawMaterial-RL2').open, false);
  page.get('changeCategoriesRisk-rawMaterial-RL3').open = false;
  page.get('changeCategoriesRisk-rawMaterial-RL1').open = true;
  page.get('changeCategoriesAdd-rawMaterial-RL0').events.click();
  assert.equal(page.get('changeCategoriesRisk-rawMaterial-RL0').open, true);
  assert.equal(page.get('changeCategoriesRisk-rawMaterial-RL1').open, true);
  assert.equal(page.get('changeCategoriesRisk-rawMaterial-RL3').open, false);
  assert.equal(page.get('changeCategory-rawMaterial-1-risk').value, 'RL0');
  assert.equal(page.get('changeCategory-rawMaterial-1-text').focused, true);
  input(page, 'changeCategory-rawMaterial-1-text', 'New lowest-risk option'); input(page, 'changeCategoriesReason', 'Add a low-risk option');
  await controller.save();
  const sent = JSON.parse(page.calls.find(call => call.options?.method === 'PUT').options.body);
  assert.equal(sent.forms.rawMaterial[0].text, 'Raw material option');
  assert.equal(sent.forms.rawMaterial[1].risk, 'RL0');
});

test('moving a category to another risk level moves the stable option and preserves focused risk control and counts', async () => {
  const page = fixture(); const controller = await ui.mount(page.root); await controller.openCategories();
  input(page, 'changeCategory-rawMaterial-0-risk', 'RL0', 'change');
  assert.equal(page.get('changeCategoriesRisk-rawMaterial-RL0').open, true);
  assert.equal(page.get('changeCategory-rawMaterial-0-risk').focused, true);
  assert.equal(page.get('changeCategoriesRiskCount-rawMaterial-RL2').textContent, '0 options · 0 enabled');
  assert.equal(page.get('changeCategoriesRiskCount-rawMaterial-RL0').textContent, '1 option · 1 enabled');
  page.get('changeCategory-rawMaterial-0-enabled').checked = false;
  page.get('changeCategory-rawMaterial-0-enabled').events.change();
  assert.equal(page.get('changeCategoriesRiskCount-rawMaterial-RL0').textContent, '1 option · 0 enabled');
});

test('saving an invalid option expands its hidden risk group and focuses the wording that needs attention', async () => {
  const page = fixture(); const controller = await ui.mount(page.root); await controller.openCategories();
  input(page, 'changeCategory-packaging-0-text', '');
  page.get('changeCategoriesRisk-packaging-RL1').open = false;
  input(page, 'changeCategoriesReason', 'Fix packaging'); await controller.save();
  assert.equal(page.get('changeCategoriesRisk-packaging-RL1').open, true);
  assert.equal(page.get('changeCategory-packaging-0-text').focused, true);
  assert.equal(page.calls.some(call => call.options?.method === 'PUT'), false);
});
