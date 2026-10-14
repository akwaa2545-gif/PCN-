const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function portal(fetch) {
  const calls = [];
  const controller = { updates: [], clears: 0, ready: true,
    setRecords(records) { this.updates.push(records); },
    clear() { this.clears++; }, canRefresh() { return this.ready; }, getState() { return {}; } };
  const window = { location: { hash: '#records' }, renders: 0,
    PCN_SESSION: { fetch: async url => { calls.push(url); return fetch(url); } },
    PCN_RECORDS_DASHBOARD: { create(options) { window.options = options; return controller; } } };
  const source = fs.readFileSync(require.resolve('../admin.js'), 'utf8').replace(/\}\)\(\);\s*$/, `
    render = () => { window.renders++; recordsDashboard?.setRecords(state.pcns); };
    showAdminNotice = () => {}; showAdminToast = () => {};
    renderLoadingState = () => {};
    loadDetail = async id => { window.selectedId = id; };
    window.TEST = { state, els, initializeRecordsDashboard, loadPcns, refreshQuietly, canAutoRefresh };
  })();`);
  vm.runInNewContext(source, { window, document: { addEventListener() {}, querySelector: () => null, activeElement: null } });
  const { state, els } = window.TEST;
  state.user = { id: 'reviewer', roles: ['qa'] }; state.isLoading = false;
  for (const id of ['pcnAdminView', 'adminPcnRows', 'adminSearchInput', 'adminStatusFilter', 'adminRiskFilter', 'adminCount', 'adminMessage']) els[id] = { id };
  els.adminRemoveDialog = { hidden: true };
  window.TEST.initializeRecordsDashboard();
  return { ...window.TEST, window, controller, calls };
}

test('Portal dashboard uses batched authorized overview and preserves row selection and existing View action', async () => {
  const items = [{ id: 'PCN-1', dashboard: { progress: { percent: 20 } } }];
  const page = portal(async url => url === '/api/pcns/overview' ? { items, generatedAt: '2026-10-14T00:00:00Z' } : {});
  await page.loadPcns();
  assert.deepEqual(page.calls, ['/api/pcns/overview']);
  assert.equal(page.state.pcns, items);
  assert.equal(page.controller.updates.at(-1), items);
  assert.equal(page.window.options.root, page.els.pcnAdminView);
  assert.equal(page.window.options.user, page.state.user);
  assert.equal(page.window.options.codeHref(items[0]), '/PCN-1');
  await page.window.options.onRowSelect(items[0]);
  assert.equal(page.window.selectedId, 'PCN-1');
  assert.equal(typeof page.window.options.actions, 'function');
  assert.equal(typeof page.window.options.selectedId, 'function');
});

test('preview opening invalidates an in-flight overview even if it closes before the response returns', async () => {
  let resolve;
  const page = portal(() => new Promise(done => { resolve = done; }));
  page.state.pcns = [{ id: 'keep' }];
  const pending = page.refreshQuietly();
  page.window.options.onOpen(); page.window.options.onClose();
  resolve({ items: [{ id: 'stale' }] }); await pending;
  assert.equal(page.state.pcns[0].id, 'keep');
  assert.equal(page.window.renders, 0);
  page.controller.ready = false;
  assert.equal(page.canAutoRefresh(), false);
});

test('permission failure clears dashboard preview and records and stops future polls', async () => {
  const page = portal(async () => { throw Object.assign(new Error('denied'), { status: 403 }); });
  page.state.pcns = [{ id: 'protected' }];
  await assert.rejects(page.refreshQuietly());
  assert.equal(page.controller.clears, 1);
  assert.equal(page.state.pcns.length, 0);
  assert.equal(page.canAutoRefresh(), false);
  await page.refreshQuietly(); assert.equal(page.calls.length, 1);
});

test('malformed overview fails visibly without silently falling back to legacy data', async () => {
  const page = portal(async () => [{ id: 'wrong envelope' }]);
  await page.loadPcns();
  assert.equal(page.state.pcns.length, 0);
  assert.match(page.state.message, /invalid response/i);
  assert.deepEqual(page.calls, ['/api/pcns/overview']);
});

test('Portal loads the shared dashboard factory before its integration', () => {
  const html = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  assert.ok(html.indexOf('src="/records.js"') >= 0);
  assert.ok(html.indexOf('src="/records.js"') < html.indexOf('src="/admin.js"'));
});
