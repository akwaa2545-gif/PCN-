const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function portal(fetch) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      open: false, hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {},
      attributes: {}, isConnected: true, events: {},
      addEventListener(name, listener) { this.events[name] = listener; },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelectorAll() { return []; }, querySelector() { return null; },
      showModal() { this.open = true; }, close() { this.open = false; }, focus() { this.focused = true; },
      scrollTo() {}, scrollBy() {},
    });
    return nodes.get(id);
  };
  const window = { location: { hash: '#records' }, PCN_SESSION: { fetch: async (...args) => ({ items: await fetch(...args), capabilities: {} }) }, selections: [] };
  const document = { addEventListener() {}, activeElement: element('eye'),
    querySelector(selector) { return selector === 'dialog[open]' && element('pcnTimelineDialog').open ? element('pcnTimelineDialog') : null; },
    body: { classList: { add() {}, remove() {} } } };
  const source = fs.readFileSync(require.resolve('../admin.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, `
      loadDetail = async id => window.selections.push(id);
      window.TEST = { state, els, openTimeline, loadTimeline, closeTimeline, selectTimelineRevision,
        chronologicalTimeline, timelineSummary, canAutoRefresh, getTimeline: () => timeline };
    })();`);
  vm.runInNewContext(source, { window, document, Date });
  const html = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  for (const match of html.matchAll(/id="([^"]+)"/g)) window.TEST.els[match[1]] = element(match[1]);
  window.TEST.state.user = { roles: ['qa'] }; window.TEST.state.isLoading = false;
  element('adminRemoveDialog').hidden = true;
  return { ...window.TEST, window, element };
}

const revisions = [
  { revision: 3, contentRevision: 2, actor: '<img src=x onerror=alert(1)>', createdAt: '2026-10-12T03:00:00Z', status: 'completed', changes: [{ path: 'supplierName', label: 'Supplier name', before: 'Old & Co', after: '<b>New supplier</b>' }] },
  { revision: 1, contentRevision: 1, actor: 'Legacy baseline', createdAt: '2026-10-11T01:00:00Z', status: 'draft', changes: [], isBaseline: true },
  { revision: 2, contentRevision: 1, actor: 'Review employee', createdAt: '2026-10-12T02:00:00Z', status: 'submitted', changes: [{ path: 'status', label: 'Status', before: 'draft', after: 'submitted' }] },
];

test('View opens a read-only history, preserves workflow selection, orders actual revisions and blocks quiet polling', async () => {
  const calls = [];
  const page = portal(async (url, options) => { calls.push([url, options]); return revisions; });
  await page.openTimeline({ id: 'PCN-2026-0001', materialName: 'Resistor' }, page.element('eye'));
  assert.deepEqual(page.window.selections, ['PCN-2026-0001']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/pcns/PCN-2026-0001/revisions');
  assert.equal(calls[0][1].method, undefined);
  assert.equal(page.element('pcnTimelineDialog').open, true);
  assert.equal(page.canAutoRefresh(), false);
  assert.deepEqual(Array.from(page.getTimeline().revisions, item => item.revision), [1, 2, 3]);
  assert.equal(page.getTimeline().selectedRevision, 3);
  const track = page.element('pcnTimelineTrack').innerHTML;
  assert.ok(track.indexOf('data-revision="1"') < track.indexOf('data-revision="3"'));
  assert.match(track, /History baseline/);
  assert.match(track, /Review employee/);
  assert.match(track, /2026-10-12T03:00:00Z/);
  assert.doesNotMatch(track, /<img/);
  const details = page.element('pcnTimelineDetails').innerHTML;
  assert.match(details, /Old &amp; Co/); assert.match(details, /&lt;b&gt;New supplier&lt;\/b&gt;/);
  assert.match(details, /Before/); assert.match(details, /After/);
  page.selectTimelineRevision(1);
  assert.match(page.element('pcnTimelineDetails').innerHTML, /Earlier changes were not recorded/);
  page.closeTimeline();
  assert.equal(page.canAutoRefresh(), true);
  assert.equal(page.element('eye').focused, true);
});

test('late reads cannot reopen closed dialogs or replace a different PCN history', async () => {
  const pending = [];
  const page = portal(() => new Promise(resolve => pending.push(resolve)));
  const first = page.openTimeline({ id: 'first' });
  page.closeTimeline(); pending[0](revisions); await first;
  assert.equal(page.element('pcnTimelineDialog').open, false);
  assert.equal(page.element('pcnTimelineTrack').innerHTML, '');
  const second = page.openTimeline({ id: 'second' });
  const third = page.openTimeline({ id: 'third' });
  pending[2]([revisions[1]]); await third;
  pending[1](revisions); await second;
  assert.equal(page.getTimeline().record.id, 'third');
  assert.equal(page.getTimeline().revisions.length, 1);
});

test('empty, failed, retried and permission denied reads clear old history and expose honest messages', async () => {
  let result = revisions;
  const page = portal(async () => { if (result instanceof Error) throw result; return result; });
  await page.openTimeline({ id: 'one' });
  result = new Error('Database temporarily unavailable'); await page.loadTimeline();
  assert.equal(page.element('pcnTimelineTrack').innerHTML, '');
  assert.equal(page.element('pcnTimelineDetails').innerHTML, '');
  assert.match(page.element('pcnTimelineMessage').textContent, /Database temporarily unavailable/);
  assert.equal(page.element('pcnTimelineRefreshButton').textContent, 'Retry');
  result = []; await page.loadTimeline();
  assert.match(page.element('pcnTimelineMessage').textContent, /No recorded changes/);
  result = revisions; await page.loadTimeline();
  assert.equal(page.getTimeline().revisions.length, 3);
  result = Object.assign(new Error('Access denied'), { status: 403 }); await page.loadTimeline();
  assert.equal(page.getTimeline().revisions.length, 0);
  assert.equal(page.element('pcnTimelineRefreshButton').hidden, true);
});

test('history never invents an actor, timestamp or creation event for a baseline', () => {
  const page = portal(async () => []);
  assert.equal(page.timelineSummary({ isBaseline: true, changes: [] }), 'History baseline');
  assert.equal(page.timelineSummary({ revision: 1, changes: [{ path: 'status', after: 'draft' }] }), 'PCN created');
  const ordered = page.chronologicalTimeline([{ revision: 2 }, { revision: 1 }]);
  assert.deepEqual(Array.from(ordered, item => item.revision), [1, 2]);
  assert.equal(ordered[0].actor, undefined); assert.equal(ordered[0].createdAt, undefined);
});
