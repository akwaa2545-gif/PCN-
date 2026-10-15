const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { exportStamp } = require('../document-bridge');

function recordsPage(fetch) {
  const all = [];
  const document = { addEventListener() {} };
  const element = tag => {
    const value = { tag, children: [], events: {}, dataset: {}, textContent: '', attributes: {}, value: '',
      append(...items) { this.children.push(...items); }, prepend(item) { this.children.unshift(item); },
      replaceChildren(...items) { this.children = items; }, setAttribute(key, entry) { this.attributes[key] = entry; },
      addEventListener(key, listener) { this.events[key] = [...(this.events[key] || []), listener]; },
      async emit(key) { for (const listener of this.events[key] || []) await listener({ target: this }); },
      querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); },
      focus() {}, showModal() { this.open = true; }, close() { this.open = false; }
    };
    all.push(value); return value;
  };
  document.createElement = element; document.body = element('body');
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../records.js'), 'utf8'), { window, document, Date, Blob, URL });
  const root = element('main'), rows = element('tbody'); root.append(rows);
  const controller = window.PCN_RECORDS_DASHBOARD.create({ root, rows, search: element('input'), count: element('span'), message: element('p'), fetch });
  return { controller, rows, all, find: id => all.find(value => value.id === id) };
}

test('record rows and fetched preview visibly identify TESTING DOC without replacing PCN codes', async () => {
  for (const marker of [true, false, 'true']) {
    const record = { id: 'PCN-2026-0001', version: '1', status: 'submitted', isTestDocument: marker };
    const page = recordsPage(async route => route.endsWith('/progress') ? { steps: [] } : record);
    page.controller.setRecords([record]);
    const rowItems = page.rows.querySelectorAll();
    assert.equal(rowItems.some(item => item.textContent === 'TESTING DOC'), marker === true);
    assert.ok(rowItems.some(item => item.tag === 'a' && item.textContent === record.id));
    await rowItems.find(item => item.tag === 'button' && item.attributes['aria-label'] === `Quick view ${record.id}`).emit('click');
    const preview = page.find('rdPreviewDialog').querySelectorAll();
    assert.equal(preview.some(item => item.textContent === 'TESTING DOC' && item.hidden !== true), marker === true);
  }
});

test('controlled print stamps retain TESTING DOC separately from draft and unsaved watermarks', () => {
  const record = { id: 'PCN-2026-0001', status: 'approved', isTestDocument: true, documentControl: { contentRevision: 2 } };
  assert.equal(exportStamp(record, false).testDocumentLabel, 'TESTING DOC');
  assert.equal(exportStamp(record, false).watermark, '');
  assert.equal(exportStamp(record, true).testDocumentLabel, 'TESTING DOC');
  assert.equal(exportStamp(record, true).watermark, 'UNSAVED PREVIEW');
  assert.equal(exportStamp({ ...record, status: 'submitted' }, false).watermark, 'DRAFT');
  for (const value of [false, undefined, 'true']) assert.equal(exportStamp({ ...record, isTestDocument: value }, false).testDocumentLabel, undefined);
});

test('beforeprint writes TESTING DOC identity without overwriting UNSAVED PREVIEW', () => {
  const ids = new Map();
  const element = id => ({ id, hidden: true, textContent: '', addEventListener() {} });
  const document = { getElementById(id) { if (!ids.has(id)) ids.set(id, element(id)); return ids.get(id); },
    querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {} };
  const listeners = {};
  const window = { document, addEventListener(key, listener) { listeners[key] = listener; },
    PCN_DOCUMENT_RECOVERY: { create() { return {}; } }, PCN_DOCUMENT_WORKSPACE: { mount() { return {}; } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../document-bridge.js'), 'utf8'), { window });
  const record = { id: 'PCN-2026-0001', isTestDocument: true, status: 'approved' };
  window.PCN_DOCUMENT_BRIDGE.mount({ getContext: () => ({ record, savedRecord: record, dirty: true }) });
  listeners.beforeprint();
  assert.match(ids.get('documentPrintIdentity').textContent, /TESTING DOC/);
  assert.equal(ids.get('documentPrintWatermark').textContent, 'UNSAVED PREVIEW');
  assert.equal(ids.get('documentPrintWatermark').hidden, false);
});
