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
      scrollTo() {}, scrollBy() {}, getBoundingClientRect() { return { left: 20, top: 20, right: 800, bottom: 700 }; },
    });
    return nodes.get(id);
  };
  const window = { location: { hash: '#records' }, PCN_SESSION: { fetch: async (...args) => ({ items: await fetch(...args), capabilities: {} }) }, selections: [] };
  const document = { addEventListener() {}, activeElement: element('eye'),
    querySelector(selector) { return selector === 'dialog[open]' && element('pcnTimelineDialog').open ? element('pcnTimelineDialog') : null; },
    body: { classList: { add() {}, remove() {} } } };
  const source = fs.readFileSync(require.resolve('../admin.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, `
      render = () => {};
      showAdminToast = () => {};
      loadDetail = async id => window.selections.push(id);
      window.TEST = { state, els, openTimeline, loadTimeline, closeTimeline, selectTimelineRevision,
        initializeTimeline, chronologicalTimeline, timelineSummary, canAutoRefresh, getTimeline: () => timeline,
        timelineEntries: typeof timelineEntries === 'function' ? timelineEntries : undefined };
    })();`);
  vm.runInNewContext(source, { window, document, Date });
  const html = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  for (const match of html.matchAll(/id="([^"]+)"/g)) window.TEST.els[match[1]] = element(match[1]);
  window.TEST.state.user = { roles: ['qa'] }; window.TEST.state.isLoading = false;
  element('adminRemoveDialog').hidden = true;
  window.TEST.initializeTimeline();
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
  assert.equal(page.element('pcnTimelineDialog').open, false);
  assert.equal(page.getTimeline().record, null);
  assert.match(page.state.message, /Access unavailable/);
  assert.equal(page.canAutoRefresh(), false);
});

test('timeline authorization loss clears all protected records and late sibling history cannot restore them', async () => {
  const pending = [];
  const page = portal(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  page.state.pcns = [{ id: 'private' }]; page.state.selected = { id: 'private' };
  const first = page.openTimeline({ id: 'first' });
  const second = page.openTimeline({ id: 'second' });
  pending[0].reject(Object.assign(new Error('Not signed in'), { status: 401 }));
  await first;
  pending[1].resolve(revisions); await second;
  assert.equal(page.state.pcns.length, 0); assert.equal(page.state.selected, null);
  assert.equal(page.element('pcnTimelineDialog').open, false);
  assert.equal(page.element('pcnTimelineTrack').innerHTML, '');
  assert.equal(page.element('pcnTimelineDetails').innerHTML, '');
  assert.equal(page.getTimeline().record, null);
  assert.equal(page.canAutoRefresh(), false);
  assert.match(page.state.message, /Access unavailable/);
});

test('history never invents an actor, timestamp or creation event for a baseline', () => {
  const page = portal(async () => []);
  assert.equal(page.timelineSummary({ isBaseline: true, changes: [] }), 'History baseline');
  assert.equal(page.timelineSummary({ revision: 1, changes: [{ path: 'status', after: 'draft' }] }), 'PCN created');
  const ordered = page.chronologicalTimeline([{ revision: 2 }, { revision: 1 }]);
  assert.deepEqual(Array.from(ordered, item => item.revision), [1, 2]);
  assert.equal(ordered[0].actor, undefined); assert.equal(ordered[0].createdAt, undefined);
});

test('keyboard event selection stays in chronological bounds and Escape/backdrop cancel only the open dialog', async () => {
  const page = portal(async () => revisions);
  await page.openTimeline({ id: 'one' }, page.element('eye'));
  const select = key => page.element('pcnTimelineTrack').events.keydown({ key, preventDefault() {} });
  select('ArrowLeft'); assert.equal(page.getTimeline().selectedRevision, 2);
  assert.match(page.element('pcnTimelineDetails').innerHTML, /draft/);
  assert.match(page.element('pcnTimelineDetails').innerHTML, /submitted/);
  select('Home'); select('ArrowLeft'); assert.equal(page.getTimeline().selectedRevision, 1);
  select('End'); select('ArrowRight'); assert.equal(page.getTimeline().selectedRevision, 3);
  const dialog = page.element('pcnTimelineDialog');
  dialog.events.click({ target: dialog, clientX: 100, clientY: 100 });
  assert.equal(dialog.open, true, 'clicking dialog padding is not a backdrop click');
  dialog.events.cancel({ preventDefault() {} });
  assert.equal(dialog.open, false); assert.equal(page.element('eye').focused, true);
  await page.openTimeline({ id: 'two' });
  dialog.events.click({ target: dialog, clientX: 0, clientY: 0 });
  assert.equal(dialog.open, false);
});

test('a pending history read shows loading and cleared details without creating events or enabling duplicate refreshes', async () => {
  let resolve;
  const page = portal(() => new Promise(done => { resolve = done; }));
  const loading = page.openTimeline({ id: 'one' });
  assert.match(page.element('pcnTimelineMessage').textContent, /Loading change history/);
  assert.equal(page.element('pcnTimelineRefreshButton').disabled, true);
  assert.equal(page.element('pcnTimelineTrack').attributes['aria-busy'], 'true');
  assert.equal(page.element('pcnTimelineTrack').innerHTML, '');
  resolve([{ revision: 4, changes: [{ path: 'internalReview.materialCodeDescription', before: null, after: ['<strong>Code</strong>'] }] }]);
  await loading;
  assert.equal(page.element('pcnTimelineRefreshButton').disabled, false);
  assert.match(page.element('pcnTimelineTrack').innerHTML, /Actor not recorded/);
  assert.match(page.element('pcnTimelineTrack').innerHTML, /Time not recorded/);
  assert.match(page.element('pcnTimelineDetails').innerHTML, /Internal Review \/ Material Code Description/);
  assert.match(page.element('pcnTimelineDetails').innerHTML, /Not set/);
  assert.match(page.element('pcnTimelineDetails').innerHTML, /&lt;strong&gt;Code&lt;\/strong&gt;/);
});

test('timeline nodes show each actual department/action and signer from signing deltas, without metadata labels', async () => {
  const item = { revision: 5, contentRevision: 3, actor: 'Admin operator', status: 'gsc_review', changes: [
    { path: 'internalReview.signoff.gscTet.checked', before: false, after: true },
    { path: 'internalReview.signoff.gscTet.checkedName', before: '', after: 'Verified checker' },
    { path: 'internalReview.signoff.gscTet.approved', before: false, after: true },
    { path: 'internalReview.signoff.gscTet.approvedName', before: '', after: 'Verified approver' },
    { path: 'internalReview.tapbu.qa.prepared', before: false, after: true },
    { path: 'internalReview.supplierSignoff.checked.checked', before: false, after: true },
    { path: 'internalReview.supplierSignoff.checked.name', before: '', after: 'Supplier checker' },
  ] };
  const page = portal(async () => [item]);
  assert.deepEqual(JSON.parse(JSON.stringify(page.timelineEntries(item))), [
    { label: 'GSC/TET — Checked', person: 'Verified checker', cleared: false },
    { label: 'GSC/TET — Approved', person: 'Verified approver', cleared: false },
    { label: 'QA/TaPBU — Prepared', person: 'Admin operator', cleared: false },
    { label: 'Supplier — Checked', person: 'Supplier checker', cleared: false },
  ]);
  await page.openTimeline({ id: 'one' });
  const track = page.element('pcnTimelineTrack').innerHTML;
  assert.match(track, /GSC\/TET — Checked/); assert.match(track, /Verified checker/);
  assert.match(track, /GSC\/TET — Approved/); assert.match(track, /Verified approver/);
  assert.doesNotMatch(track, /fields changed|Event 5|Content revision/);
});

test('cleared signatures identify the clearing actor and never claim a completed signing action', () => {
  const page = portal(async () => []);
  const item = { revision: 6, actor: 'Clearing administrator', status: 'supplier_action', changes: [
    { path: 'internalReview.signoff.gscTet.approved', before: true, after: false },
    { path: 'internalReview.signoff.gscTet.approvedName', before: 'Former approver', after: '' },
    { path: 'internalReview.signoff.prodEngTet.prepared', before: true, after: null },
    { path: 'internalReview.signoff.qaTet.checked', before: false, after: false },
    { path: 'internalReview.signoff.prodEngTet.preparedName', before: '', after: 'Name only' },
  ] };
  assert.deepEqual(JSON.parse(JSON.stringify(page.timelineEntries(item))), [
    { label: 'GSC/TET — Approved cleared', person: 'Clearing administrator', cleared: true },
    { label: 'Prod.Eng/TET — Prepared cleared', person: 'Clearing administrator', cleared: true },
  ]);
});

test('non-signing edits show the recorded current status and actor without inventing a department or action', async () => {
  const item = { revision: 8, contentRevision: 3, actor: 'Actual editor', status: 'qa_review', changes: [{ path: 'supplierName', before: 'Old', after: 'New' }] };
  const page = portal(async () => [item]);
  assert.deepEqual(JSON.parse(JSON.stringify(page.timelineEntries(item))), [{ label: 'Qa Review', person: 'Actual editor', cleared: false }]);
  await page.openTimeline({ id: 'one' });
  const track = page.element('pcnTimelineTrack').innerHTML;
  assert.match(track, /Qa Review/); assert.match(track, /Actual editor/);
  assert.doesNotMatch(track, /fields changed|Event 8|Content revision|GSC\/TET/);
});

test('selected details show form and signing changes first while omitting technical storage metadata from the UI', async () => {
  const changes = [
    { path: 'documentControl.contentHash', before: 'old-hidden-hash', after: 'new-hidden-hash' },
    { path: 'documentControl.signatureBindings.signoff.gscTet.checked.userId', before: null, after: 'hidden-user-id' },
    { path: 'documentControl.signatureBindings.signoff.gscTet.checked.contentRevision', before: null, after: 42 },
    { path: 'documentControl.signatureBindings.signoff.gscTet.checked.contentHash', before: null, after: 'hidden-signature-hash' },
    { path: 'documentControl.revisionReason', before: '', after: 'Supplier correction' },
    { path: 'documentControl.contentRevision', before: 1, after: 2 },
    { path: 'version', before: 'hidden-version-old', after: 'hidden-version-new' },
    { path: 'id', before: '', after: 'hidden-storage-id' },
    { path: 'updatedAt', before: '', after: 'hidden-updated-at' },
    { path: 'supplierName', before: 'Old supplier', after: 'New supplier' },
    { path: 'internalReview.signoff.gscTet.checked', before: false, after: true },
    { path: 'internalReview.signoff.gscTet.checkedName', before: '', after: 'Real signer' },
    { path: 'internalReview.signoff.gscTet.checkedDate', before: '', after: '2026-10-12' },
  ];
  const page = portal(async () => [{ revision: 5, actor: 'Real signer', status: 'gsc_review', changes }]);
  await page.openTimeline({ id: 'one' });
  const details = page.element('pcnTimelineDetails').innerHTML;
  assert.match(details, /Old supplier/); assert.match(details, /New supplier/);
  assert.match(details, /Real signer/); assert.match(details, /Checked Name/); assert.match(details, /Checked Date/);
  assert.match(details, /Supplier correction/);
  assert.doesNotMatch(details, /hidden-|Content Hash|Signature Bindings|Content Revision|Updated At/);
  assert.ok(details.indexOf('Checked Name') < details.indexOf('Revision Reason'));
  assert.ok(details.indexOf('New supplier') < details.indexOf('Revision Reason'));
  assert.equal(page.getTimeline().revisions[0].changes.length, changes.length, 'The stored API history is preserved');
});
