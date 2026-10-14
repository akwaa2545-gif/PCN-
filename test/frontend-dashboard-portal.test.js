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
    const actualLoadDetail = loadDetail;
    render = () => { window.renders++; recordsDashboard?.setRecords(state.pcns); };
    showAdminNotice = () => {}; showAdminToast = () => {};
    renderLoadingState = () => {};
    loadDetail = async id => { window.selectedId = id; };
    openTimeline = (record, opener) => { window.timelineAction = { record, opener }; };
    requestRemovePcn = record => { window.removeAction = record; };
    window.TEST = { state, els, initializeRecordsDashboard, loadPcns, refreshQuietly, canAutoRefresh, loadDetail: actualLoadDetail };
  })();`);
  vm.runInNewContext(source, { window, document: { addEventListener() {}, querySelector: () => null, activeElement: null,
    createElement() { return { events: {}, attributes: {}, addEventListener(name, handler) { this.events[name] = handler; }, setAttribute(name, value) { this.attributes[name] = value; } }; } } });
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
  const actions = page.window.options.actions(items[0]);
  assert.equal(actions.length, 1);
  assert.match(actions[0].className, /admin-view-button/);
  actions[0].events.click();
  assert.equal(page.window.timelineAction.record, items[0]);
  assert.equal(page.window.timelineAction.opener, actions[0]);
  page.state.user = { id: 'admin', roles: ['admin'] };
  const adminActions = page.window.options.actions(items[0]);
  assert.equal(adminActions.length, 2);
  adminActions[1].events.click(); assert.equal(page.window.removeAction, items[0]);
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
  await page.loadPcns(); assert.equal(page.calls.length, 1);
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

test('late detail reads cannot restore protected sidebar data after preview detects access loss', async () => {
  const pending = new Map();
  const page = portal(url => new Promise(resolve => pending.set(url, resolve)));
  const detail = page.loadDetail('protected');
  page.window.options.onAccessLost(Object.assign(new Error('denied'), { status: 403 }));
  pending.get('/api/pcns/protected')({ id: 'protected', supplierName: 'Secret' });
  pending.get('/api/pcns/protected/progress')({ status: 'private' });
  await detail;
  assert.equal(page.state.selected, null); assert.equal(page.state.progress, null);
  assert.match(page.state.message, /Access unavailable/);
  assert.equal(page.canAutoRefresh(), false);
});

test('late manual list reads cannot restore protected records after preview detects access loss', async () => {
  let resolve;
  const page = portal(() => new Promise(done => { resolve = done; }));
  const list = page.loadPcns();
  page.window.options.onAccessLost(Object.assign(new Error('denied'), { status: 403 }));
  resolve({ items: [{ id: 'protected' }] }); await list;
  assert.equal(page.state.pcns.length, 0); assert.equal(page.state.selected, null);
  assert.match(page.state.message, /Access unavailable/);
  assert.equal(page.canAutoRefresh(), false);
});

test('late selected progress in a manual list refresh cannot restore sidebar data after access loss', async () => {
  let resolveProgress;
  const page = portal(url => url === '/api/pcns/overview' ? { items: [{ id: 'selected' }] }
    : new Promise(done => { resolveProgress = done; }));
  page.state.selected = { id: 'selected' };
  const list = page.loadPcns();
  await new Promise(setImmediate);
  page.window.options.onAccessLost(Object.assign(new Error('denied'), { status: 403 }));
  resolveProgress({ status: 'private' }); await list;
  assert.equal(page.state.pcns.length, 0); assert.equal(page.state.selected, null);
  assert.equal(page.state.progress, null);
  assert.match(page.state.message, /Access unavailable/);
});

test('direct detail authorization denial clears the full overview and invalidates sibling detail reads', async () => {
  const pending = new Map();
  const page = portal(url => new Promise((resolve, reject) => pending.set(url, { resolve, reject })));
  page.state.pcns = [{ id: 'protected' }]; page.state.selected = { id: 'protected' };
  const denied = page.loadDetail('denied');
  const sibling = page.loadDetail('sibling');
  pending.get('/api/pcns/denied/progress').reject(Object.assign(new Error('Forbidden'), { status: 403 }));
  await denied;
  pending.get('/api/pcns/sibling').resolve({ id: 'sibling' });
  pending.get('/api/pcns/sibling/progress').resolve({ status: 'private' });
  await sibling;
  assert.equal(page.controller.clears, 1);
  assert.equal(page.state.pcns.length, 0); assert.equal(page.state.selected, null);
  assert.equal(page.state.progress, null); assert.equal(page.canAutoRefresh(), false);
  assert.match(page.state.message, /Access unavailable/);
});
