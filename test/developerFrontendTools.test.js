'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../developer.js');

test('Developer tools require an active exclusive Developer assignment', () => {
  const user = { isActive: true, roles: ['developer'], department: 'developer', signingStep: null };
  assert.equal(tools.isDeveloper(user), true);
  assert.equal(tools.isDeveloper({ ...user, roles: ['Developer'] }), true);
  for (const change of [{ isActive: false }, { roles: ['admin'] }, { roles: ['developer', 'admin'] }, { department: 'it' }, { signingStep: 'prepared' }, { signingStep: '' }, { signingStep: false }, { signingStep: 0 }, { isActive: undefined }]) {
    assert.equal(tools.isDeveloper({ ...user, ...change }), false);
  }
  assert.equal(tools.isDeveloper(null), false);
});

test('PCN deep links accept one canonical ID only', () => {
  assert.equal(tools.requestedPcn('?pcn=PCN-2026-0002'), 'PCN-2026-0002');
  for (const query of ['?pcn=bad', '?pcn=PCN-2026-00002', '?pcn=PCN-2026-0002&pcn=PCN-2026-0003', '', '?pcn=%3Cscript%3E']) assert.equal(tools.requestedPcn(query), '');
});

test('transactions preserve each field change, baseline and empty saves with newest first', () => {
  const rows = tools.flattenTransactions([
    { revision: 1, actor: 'Original', createdAt: '2026-01-01T00:00:00Z', isBaseline: true, changes: [] },
    { revision: 2, actor: 'Employee', createdAt: '2026-01-02T00:00:00Z', changes: [{ path: 'reason', label: 'Reason', before: '', after: '<script>bad</script>' }, { path: 'status', label: 'Status', before: 'Draft', after: 'Submitted' }] },
    { revision: 3, actor: 'Reviewer', createdAt: '2026-01-03T00:00:00Z', changes: [] }
  ]);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.revision), [3, 2, 2, 1]);
  assert.equal(rows[0].label, 'Saved');
  assert.equal(rows[1].after, '<script>bad</script>');
  assert.equal(rows[3].label, 'History baseline');
  assert.match(rows[3].after, /unavailable/i);
});

test('transaction filters combine text and inclusive calendar dates without mutating rows', () => {
  const rows = [
    { actor: 'Jane', actorReference: '123', label: 'Reason', before: 'old', after: 'NEW', createdAt: '2026-10-10T23:59:59Z' },
    { actor: 'John', label: 'Status', after: 'NEW', createdAt: '2026-10-11T00:00:00Z' }
  ];
  assert.equal(tools.filterTransactions(rows, { query: 'new', from: '2026-10-10', to: '2026-10-10' }).length, 1);
  assert.equal(tools.filterTransactions(rows, { query: '123' }).length, 1);
  assert.equal(tools.filterTransactions(rows, { query: 'jAnE' }).length, 1);
  assert.equal(tools.filterTransactions(rows, { from: '2026-10-12', to: '2026-10-10' }).length, 0);
  assert.equal(rows.length, 2);
});

test('pagination clamps stale pages and handles empty results', () => {
  const rows = Array.from({ length: 51 }, (_, n) => n);
  assert.deepEqual(tools.pageTransactions(rows, 8), { items: [50], page: 3, pages: 3, total: 51, first: 51, last: 51 });
  assert.deepEqual(tools.pageTransactions([], 1), { items: [], page: 1, pages: 1, total: 0, first: 0, last: 0 });
});

function page(fetch, user = { isActive: true, roles: ['developer'], department: 'developer', signingStep: null }) {
  const nodes = new Map(), calls = [];
  function element() {
    return { value: '', hidden: false, disabled: false, textContent: '', children: [], events: {}, attributes: {},
      appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(key, callback) { this.events[key] = callback; }, focus() { this.focused = true; } };
  }
  const document = { createElement: element, getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } };
  const root = { document, location: { search: '' }, PCN_SESSION: {
    require: async role => { assert.equal(role, 'developer'); return user ? { user } : null; },
    async fetch(url) { calls.push(url); return fetch(url); }
  } };
  return { root, calls, get: document.getElementById };
}
const record = id => ({ record: { id, supplierName: 'Supplier', status: 'Draft' }, workflow: { stages: [] }, transactions: { items: [] } });

test('unauthorized and malformed Developer sessions never fetch document data', async () => {
  for (const user of [null, { isActive: true, roles: ['admin'], department: 'it' }, { isActive: true, roles: ['developer', 'admin'], department: 'developer' }]) {
    const fixture = page(() => { throw new Error('must not fetch'); }, user);
    await tools.mount(fixture.root);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.get('developerMain').hidden, true);
    assert.ok(fixture.get('developerStatus').textContent);
  }
});

test('late PCN responses cannot overwrite a newer selection or expose stale transactions', async () => {
  let finishOld;
  const fixture = page(url => url === '/api/developer/pcns' ? { items: [{ id: 'PCN-2026-0001' }, { id: 'PCN-2026-0002' }] }
    : url.includes('0001') ? new Promise(resolve => { finishOld = resolve; }) : record('PCN-2026-0002'));
  const controller = await tools.mount(fixture.root);
  const old = controller.loadDetails('PCN-2026-0001');
  assert.equal(fixture.get('pcnSelect').disabled, false, 'selection remains available while inspecting');
  await controller.loadDetails('PCN-2026-0002');
  finishOld(record('PCN-2026-0001')); await old;
  assert.equal(controller.state.selected, 'PCN-2026-0002');
  assert.equal(fixture.get('workflowSummary').children[0].children[1].textContent, 'PCN-2026-0002');
});

test('failed or mismatched inspection clears previous document and can be retried', async () => {
  let fail = false;
  const fixture = page(url => url === '/api/developer/pcns' ? { items: [{ id: 'PCN-2026-0001' }] }
    : fail ? record('PCN-2026-0099') : record('PCN-2026-0001'));
  const controller = await tools.mount(fixture.root);
  await controller.loadDetails('PCN-2026-0001');
  fail = true; await controller.loadDetails('PCN-2026-0001');
  assert.equal(fixture.get('workflowSummary').children.length, 0);
  assert.equal(controller.state.loaded, false);
  assert.match(fixture.get('developerStatus').textContent, /different PCN/);
  fail = false; await controller.refresh();
  assert.equal(controller.state.loaded, true);
});

test('list failure offers refresh and successful refresh preserves selection and filters', async () => {
  let fail = true;
  const fixture = page(url => {
    if (url === '/api/developer/pcns') {
      if (fail) throw new Error('List unavailable');
      return { items: [{ id: 'PCN-2026-0001' }] };
    }
    return record('PCN-2026-0001');
  });
  const controller = await tools.mount(fixture.root);
  assert.match(fixture.get('developerStatus').textContent, /List unavailable/);
  assert.equal(fixture.get('refreshDeveloper').disabled, false);
  fail = false; await controller.refresh(); await controller.loadDetails('PCN-2026-0001');
  fixture.get('transactionSearch').value = 'Reason';
  await controller.refresh();
  assert.equal(controller.state.selected, 'PCN-2026-0001');
  assert.equal(fixture.get('transactionSearch').value, 'Reason');
  fixture.get('transactionsTab').events.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(fixture.get('workflowPanel').hidden, false);
  assert.equal(fixture.get('workflowTab').focused, true);
});

test('selecting the placeholder during inspection invalidates the response and unlocks Refresh', async () => {
  let release;
  const fixture = page(url => url === '/api/developer/pcns' ? { items: [{ id: 'PCN-2026-0001' }] }
    : new Promise(resolve => { release = resolve; }));
  const controller = await tools.mount(fixture.root);
  const pending = controller.loadDetails('PCN-2026-0001');
  await controller.loadDetails('');
  assert.equal(fixture.get('refreshDeveloper').disabled, false);
  release(record('PCN-2026-0001')); await pending;
  assert.equal(fixture.get('workflowSummary').children.length, 0);
  assert.equal(controller.state.selected, '');
});

test('inspection access loss clears metadata and permanently blocks pending and future data requests', async () => {
  let release, denied = false;
  const fixture = page(url => {
    if (url === '/api/developer/pcns') return { items: [{ id: 'PCN-2026-0001' }, { id: 'PCN-2026-0002' }] };
    if (url.includes('0002')) return new Promise(resolve => { release = resolve; });
    if (denied) throw Object.assign(new Error('Developer access required'), { status: 403 });
    return record('PCN-2026-0001');
  });
  const controller = await tools.mount(fixture.root);
  await controller.loadDetails('PCN-2026-0001');
  const pending = controller.loadDetails('PCN-2026-0002');
  denied = true; await controller.loadDetails('PCN-2026-0001');
  assert.equal(fixture.get('developerMain').hidden, true);
  assert.deepEqual(controller.state.list, []);
  assert.equal(controller.state.selected, '');
  assert.equal(controller.state.authorized, false);
  assert.equal(fixture.get('workflowSummary').children.length, 0);
  assert.equal(fixture.get('pcnSelect').children.length, 1);
  release(record('PCN-2026-0002')); await pending;
  assert.equal(fixture.get('workflowSummary').children.length, 0);
  const requests = fixture.calls.length;
  await controller.refresh(); await controller.loadDetails('PCN-2026-0001');
  assert.equal(fixture.calls.length, requests);
});

test('list access loss clears previously loaded details for 401 and 403 responses', async () => {
  for (const status of [401, 403]) {
    let denied = false;
    const fixture = page(url => {
      if (url !== '/api/developer/pcns') return record('PCN-2026-0001');
      if (denied) throw Object.assign(new Error('Access ended'), { status });
      return { items: [{ id: 'PCN-2026-0001' }] };
    });
    const controller = await tools.mount(fixture.root);
    await controller.loadDetails('PCN-2026-0001');
    denied = true; await controller.refresh();
    assert.equal(fixture.get('developerMain').hidden, true);
    assert.equal(fixture.get('workflowSummary').children.length, 0);
    assert.equal(controller.state.authorized, false);
    assert.deepEqual(controller.state.list, []);
  }
});
