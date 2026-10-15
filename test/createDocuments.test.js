const test = require('node:test');
const assert = require('node:assert/strict');
const documents = require('../create-documents');

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {};
    this.dataset = {}; this.listeners = {}; this.textContent = ''; this.hidden = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  async emit(name, event = {}) { return this.listeners[name]?.({ target: this, ...event }); }
  focus() { this.focused = true; }
}
const tree = node => [node, ...node.children.flatMap(tree)];
const text = node => tree(node).map(item => item.textContent).join(' ');
const tick = () => new Promise(resolve => setImmediate(resolve));
const initial = () => ({ id: 'PCN-2026-0001', version: '0000000000000001', status: 'draft',
  supplierName: 'Original', internalReview: { docs: { greenProcurement: true } } });
function fixture(overrides = {}) {
  let record = initial(); let savedRecord = record;
  const container = new Element('div');
  container.ownerDocument = { createElement: tag => new Element(tag) };
  const calls = []; const changes = []; const saved = []; const notices = [];
  const state = { editable: true, canSetRequirements: true, scannerConfigured: false };
  const api = async (url, options) => {
    calls.push({ url, options });
    if (overrides.api) return overrides.api(url, options);
    if (url.endsWith('/documents') && !options) return [];
    if (options) return { id: 'file-1', version: '0000000000000002' };
    return { ...savedRecord, version: '0000000000000002' };
  };
  const autosave = { async exclusive(work) {
    calls.push({ exclusive: true });
    const result = await work(savedRecord);
    savedRecord = result.record;
    return result;
  } };
  const control = documents.mount({ container, getContext: () => ({ record, savedRecord, ...state }),
    api, autosave, readFile: async () => 'YWJj',
    onChange(value) { changes.push(value); record = value; },
    onSaved(value) { saved.push(value); savedRecord = value; },
    notify(...args) { notices.push(args); } });
  const find = predicate => tree(container).find(predicate);
  const card = key => find(node => node.dataset.requirement === key);
  const input = key => tree(card(key)).find(node => node.type === 'file');
  const upload = async (key = 'greenProcurement', file = { name: 'report.txt', size: 3, type: 'text/plain' }) => {
    const picker = input(key); picker.files = [file]; await picker.emit('change');
  };
  return { container, control, calls, changes, saved, notices, state, card, input, upload,
    context(value) { record = value; savedRecord = value; }, find };
}

test('required document cards distinguish missing, clean, pending and rejected files', async () => {
  const c = fixture({ api: async () => [
    { id: 'one', fileName: '<img onerror=alert(1)>.txt', requirementName: 'greenProcurement', scanStatus: 'pendingScan' },
    { id: 'two', fileName: 'blocked.txt', scanStatus: 'infected' }
  ] });
  assert.match(text(c.card('greenProcurement')), /Missing/);
  await c.control.refresh();
  assert.match(text(c.card('greenProcurement')), /Awaiting scan/);
  assert.match(text(c.card('greenProcurement')), /scanning unavailable/i);
  assert.match(text(c.card('greenProcurement')), /<img onerror=alert\(1\)>\.txt/);
  assert.equal(tree(c.container).some(node => node.tagName === 'IMG'), false);
  assert.match(text(c.container), /Rejected/);
  c.context({ ...initial(), documentAttachments: [
    { id: 'clean', fileName: 'clean.txt', requirementName: 'greenProcurement', scanStatus: 'clean' }
  ] });
  c.control.render();
  assert.match(text(c.card('greenProcurement')), /Ready/);
});

test('requirement changes create a new document and preserve unrelated review data', async () => {
  const c = fixture();
  const original = { ...initial(), internalReview: { ...initial().internalReview, materialCodeDescription: 'Material' } };
  c.context(original); c.control.render();
  const checkbox = tree(c.card('greenProcurement')).find(node => node.type === 'checkbox');
  checkbox.checked = false; await checkbox.emit('change');
  assert.equal(c.changes.length, 1);
  assert.equal(c.changes[0].internalReview.docs.greenProcurement, false);
  assert.equal(original.internalReview.docs.greenProcurement, true);
  assert.equal(c.changes[0].internalReview.materialCodeDescription, 'Material');
});

test('read-only requirement policy preserves uploads but disables requirement editing', async () => {
  const c = fixture(); c.state.canSetRequirements = false; c.control.render();
  const checkbox = tree(c.card('greenProcurement')).find(node => node.type === 'checkbox');
  assert.equal(checkbox.disabled, true);
  checkbox.checked = false; await checkbox.emit('change');
  assert.equal(c.changes.length, 0);
  assert.equal(c.input('greenProcurement').disabled, false);
  c.state.editable = false; c.control.render();
  assert.equal(c.input('greenProcurement').disabled, true);
  await c.upload();
  assert.equal(c.calls.length, 0);
});

test('upload uses the mutation queue canonical version and adopts record plus files', async () => {
  const next = { ...initial(), version: '0000000000000002' };
  const files = [{ id: 'one', fileName: 'report.txt', requirementName: 'greenProcurement', scanStatus: 'clean' }];
  const c = fixture({ api: async (url, options) => options ? { id: 'one', version: next.version }
    : url.endsWith('/documents') ? files : next });
  await c.upload();
  assert.equal(c.calls[0].exclusive, true);
  const call = c.calls.find(item => item.options?.method === 'POST');
  assert.equal(call.url, '/api/pcns/PCN-2026-0001/documents');
  assert.deepEqual(JSON.parse(call.options.body), { fileName: 'report.txt', contentType: 'text/plain', base64: 'YWJj',
    version: '0000000000000001', requirementName: 'greenProcurement' });
  assert.equal(c.saved[0].version, next.version);
  assert.deepEqual(c.saved[0].documentAttachments, files);
  assert.match(text(c.card('greenProcurement')), /Ready/);
});

test('busy upload state is visible and prevents duplicate mutations', async () => {
  let finish;
  const c = fixture({ api: async (url, options) => options ? new Promise(resolve => { finish = resolve; })
    : url.endsWith('/documents') ? [] : { ...initial(), version: '0000000000000002' } });
  const pending = c.upload(); await tick();
  assert.match(text(c.card('greenProcurement')), /Uploading/);
  await c.upload();
  assert.equal(c.calls.filter(item => item.options?.method === 'POST').length, 1);
  finish({ version: '0000000000000002' }); await pending;
});

test('configured scanner describes an in-flight upload without promising an absent scanner', async () => {
  let finish;
  const c = fixture({ api: async (url, options) => options ? new Promise(resolve => { finish = resolve; }) : [] });
  c.state.scannerConfigured = true;
  const pending = c.upload(); await tick();
  assert.match(text(c.card('greenProcurement')), /Scanning/);
  finish({ version: '0000000000000002' }); await pending;
});

test('remove is versioned through the same mutation queue', async () => {
  const c = fixture({ api: async (url, options) => options ? { version: '0000000000000002' }
    : url.endsWith('/documents') ? [] : { ...initial(), version: '0000000000000002' } });
  c.context({ ...initial(), documentAttachments: [
    { id: '00000000-0000-0000-0000-000000000001', fileName: 'report.txt', requirementName: 'greenProcurement', scanStatus: 'clean' }
  ] });
  c.control.render();
  const button = tree(c.card('greenProcurement')).find(node => node.tagName === 'BUTTON' && /Remove/.test(node.textContent));
  await button.emit('click');
  const call = c.calls.find(item => item.options?.method === 'DELETE');
  assert.equal(c.calls[0].exclusive, true);
  assert.equal(JSON.parse(call.options.body).version, '0000000000000001');
  assert.match(call.url, /documents\/00000000-0000-0000-0000-000000000001$/);
  assert.match(text(c.card('greenProcurement')), /Missing/);
});

test('file validation and server failures keep the card actionable and report errors', async () => {
  const c = fixture({ api: async () => { throw new Error('Version changed; reload the draft'); } });
  await c.upload('greenProcurement', { name: 'unsafe.html', type: 'text/html', size: 2 });
  assert.equal(c.calls.length, 0);
  assert.match(c.notices[0][2], /PDF|supported/i);
  await c.upload();
  assert.match(c.notices[1][2], /Version changed/);
  assert.match(text(c.card('greenProcurement')), /Version changed/);
  assert.equal(c.input('greenProcurement').disabled, false);
});

test('late refresh results never expose a prior draft and destroy suppresses callbacks', async () => {
  let finish;
  const c = fixture({ api: async () => new Promise(resolve => { finish = resolve; }) });
  const pending = c.control.refresh();
  c.context({ ...initial(), id: 'PCN-2026-0002' }); c.control.render();
  finish([{ id: 'old', fileName: 'Sensitive old file.txt', scanStatus: 'clean' }]);
  await pending;
  assert.doesNotMatch(text(c.container), /Sensitive old file/);
  const second = c.control.refresh(); c.control.destroy();
  finish([]); await second;
  assert.equal(c.saved.length, 0);
});

test('requirement focus targets a labeled card and deleted files never count Ready', () => {
  const c = fixture();
  c.context({ ...initial(), documentAttachments: [
    { id: 'deleted', fileName: 'old.txt', requirementName: 'greenProcurement', scanStatus: 'clean', deletedAt: '2026-10-15' }
  ] }); c.control.render();
  assert.match(text(c.card('greenProcurement')), /Missing/);
  c.control.focusRequirement('internalReview.docs.greenProcurement');
  assert.equal(c.card('greenProcurement').focused, true);
  assert.equal(c.card('greenProcurement').attributes.tabindex, '-1');
});
