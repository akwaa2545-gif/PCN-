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
  focus() { this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
}
const tree = node => [node, ...node.children.flatMap(tree)];
const text = node => tree(node).map(item => item.textContent).join(' ');
const tick = () => new Promise(resolve => setImmediate(resolve));
const initial = () => ({ id: 'PCN-2026-0001', version: '0000000000000001', status: 'draft',
  supplierName: 'Original', internalReview: { docs: { greenProcurement: true } } });
function fixture(overrides = {}) {
  let record = initial(); let savedRecord = record;
  const container = new Element('div');
  const document = { activeElement: null, createElement(tag) { const node = new Element(tag); node.ownerDocument = document; return node; } };
  container.ownerDocument = document;
  const calls = []; const changes = []; const saved = []; const notices = []; const attachmentUpdates = [];
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
    api, autosave, ...(overrides.defaultReadFile ? {} : { readFile: async () => 'YWJj' }),
    onChange(value) { changes.push(value); record = value; if (overrides.rerenderOnChange) control.render(); },
    onSaved(value) { saved.push(value); savedRecord = value; },
    onAttachments(files, identity) { attachmentUpdates.push({ files, identity }); },
    notify(...args) { notices.push(args); } });
  const find = predicate => tree(container).find(predicate);
  const card = key => find(node => node.dataset.requirement === key);
  const input = key => tree(card(key)).find(node => node.type === 'file');
  const upload = async (key = 'greenProcurement', file = { name: 'report.txt', size: 3, type: 'text/plain' }) => {
    const picker = input(key); picker.files = [file]; await picker.emit('change');
  };
  return { container, control, calls, changes, saved, notices, attachmentUpdates, state, card, input, upload,
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

test('refresh replaces previously adopted attachment metadata without replacing local form data', async () => {
  const file = { id: 'one', fileName: 'ready.txt', requirementName: 'greenProcurement', scanStatus: 'clean' };
  const c = fixture({ api: async () => [file] });
  c.context({ ...initial(), documentAttachments: [] }); c.control.render();
  await c.control.refresh();
  assert.match(text(c.card('greenProcurement')), /ready.txt/);
  assert.equal(c.saved.length, 0);
  assert.equal(c.changes.length, 0);
  assert.deepEqual(c.attachmentUpdates, [{ files: [file], identity: { id: 'PCN-2026-0001', version: '0000000000000001' } }]);
});

test('a committed upload with failed metadata refresh still adopts its new version and explains recovery', async () => {
  const c = fixture({ api: async (url, options) => {
    if (options) return { id: 'one', fileName: 'report.txt', requirementName: 'greenProcurement', scanStatus: 'pendingScan', version: '0000000000000002' };
    throw new Error('Connection lost');
  } });
  await c.upload();
  assert.equal(c.saved[0].version, '0000000000000002');
  assert.equal(c.saved[0].documentAttachments[0].fileName, 'report.txt');
  assert.match(c.notices[0][2], /saved.*could not be refreshed/i);
  assert.match(text(c.card('greenProcurement')), /Reload the draft/);
});

test('empty, oversized and unsafe filenames never allocate a draft or upload bytes', async () => {
  const c = fixture();
  for (const file of [{ name: 'empty.txt', type: 'text/plain', size: 0 },
    { name: 'large.txt', type: 'text/plain', size: 11 * 1024 * 1024 },
    { name: '../name.txt', type: 'text/plain', size: 3 }]) await c.upload('greenProcurement', file);
  assert.equal(c.calls.length, 0);
  assert.equal(c.notices.length, 3);
});

test('supporting files use normal bytes encoding without a requirement category', async () => {
  const c = fixture({ defaultReadFile: true });
  await c.upload('supporting', { name: 'readme.txt', type: 'text/plain', size: 3, arrayBuffer: async () => Uint8Array.from([97, 98, 99]).buffer });
  const call = c.calls.find(item => item.options?.method === 'POST');
  assert.equal(JSON.parse(call.options.body).base64, 'YWJj');
  assert.equal(Object.hasOwn(JSON.parse(call.options.body), 'requirementName'), false);
});

test('requirement notes use immutable edits and submitted documents cannot mutate', async () => {
  const c = fixture();
  const note = tree(c.card('supplierDocument')).find(node => node.type === 'text');
  note.value = 'Detailed material report'; await note.emit('change');
  assert.equal(c.changes[0].internalReview.docs.supplierDocumentNote, 'Detailed material report');
  c.context({ ...initial(), status: 'submitted' }); c.control.render(); await c.upload();
  assert.equal(c.calls.length, 0);
});

test('failed document loads report the failure and destroyed controls ignore later edits', async () => {
  const c = fixture({ api: async () => { throw new Error('Files unavailable'); } });
  await c.control.refresh();
  assert.match(text(c.card('supporting')), /Files unavailable/);
  c.control.destroy(); c.control.render(); await c.control.refresh(); await c.upload();
  assert.equal(c.calls.length, 1);
});

test('missing integration options fail explicitly', () => {
  assert.throws(() => documents.mount({}), /container, context, API client and autosave queue/);
});

for (const key of ['supplierDocument', 'otherRequirement']) {
  test(`${key} description persists while a delayed file refresh completes and keeps the typing selection`, async () => {
    let finish;
    const c = fixture({ rerenderOnChange: true, api: async () => new Promise(resolve => { finish = resolve; }) });
    const pending = c.control.refresh();
    let input = tree(c.card(key)).find(node => node.type === 'text');
    input.focus(); input.value = 'Supplier technical specification'; input.setSelectionRange(9, 18, 'backward');
    await input.emit('input');
    assert.equal(c.changes.at(-1)?.internalReview.docs[`${key}Note`], 'Supplier technical specification');
    input = tree(c.card(key)).find(node => node.type === 'text');
    assert.equal(c.container.ownerDocument.activeElement, input);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [9, 18, 'backward']);
    finish([]); await pending;
    input = tree(c.card(key)).find(node => node.type === 'text');
    assert.equal(input.value, 'Supplier technical specification');
    assert.equal(c.container.ownerDocument.activeElement, input);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [9, 18, 'backward']);
  });
}

test('keyboard requirement toggles retain contextual checkbox focus after parent rerender', async () => {
  const c = fixture({ rerenderOnChange: true });
  let checkbox = tree(c.card('greenProcurement')).find(node => node.type === 'checkbox');
  checkbox.focus(); checkbox.checked = false; await checkbox.emit('change');
  checkbox = tree(c.card('greenProcurement')).find(node => node.type === 'checkbox');
  assert.equal(c.container.ownerDocument.activeElement, checkbox);
  assert.equal(checkbox.checked, false);
  assert.equal(checkbox.attributes['aria-label'], 'Green Procurement declaration: Required document');
});

test('file picker retains focus during refresh while outside focus remains untouched', async () => {
  const c = fixture();
  c.input('greenProcurement').focus(); await c.control.refresh();
  assert.equal(c.container.ownerDocument.activeElement, c.input('greenProcurement'));
  const outside = c.container.ownerDocument.createElement('button'); outside.focus();
  c.control.render();
  assert.equal(c.container.ownerDocument.activeElement, outside);
});

test('removal returns keyboard focus to its card and download names identify the file', async () => {
  const c = fixture();
  c.context({ ...initial(), documentAttachments: [
    { id: '00000000-0000-0000-0000-000000000001', fileName: 'report.txt', requirementName: 'greenProcurement', scanStatus: 'clean' }
  ] }); c.control.render();
  const link = tree(c.card('greenProcurement')).find(node => node.tagName === 'A');
  assert.equal(link.attributes['aria-label'], 'Download report.txt');
  const remove = tree(c.card('greenProcurement')).find(node => node.tagName === 'BUTTON');
  remove.focus(); await remove.emit('click');
  assert.equal(c.container.ownerDocument.activeElement, c.card('greenProcurement'));
});
