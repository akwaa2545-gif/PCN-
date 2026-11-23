const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function dashboard() {
  const window = { PCN_TYPES: require('../pcn-types') };
  vm.runInNewContext(fs.readFileSync(require.resolve('../records.js'), 'utf8'), {
    window, document: { addEventListener() {} }, Date, Intl, Blob, URL, setTimeout, clearTimeout,
  });
  return window.PCN_RECORDS_DASHBOARD;
}

const records = [
  { id: 'PCN-2026-0001', status: 'submitted', riskLevel: 'High', supplierName: 'A', updatedAt: '2026-10-14T10:00:00Z', dashboard: { action: { department: 'qaTet', label: 'QA/TET — Checked', people: [{displayName:'Jane'}] }, pending:{needsAttention:true} } },
  { id: 'PCN-2026-0002', status: 'approved', riskLevel: 'Low', supplierName: 'B', updatedAt: '2026-10-13T10:00:00Z', dashboard: { action: {terminal:true}, pending:{needsAttention:false} } },
];

test('PCN type filters combine with lifecycle and exports without classifying legacy documents', () => {
  const api = dashboard();
  const items = [...records,
    { id: 'T-19112601', documentType: 'ta', status: 'technical_review', supplierName: 'A' },
    { id: 'S-19112601', documentType: 'sc', status: 'closed', supplierName: 'A' }];
  assert.deepEqual(Array.from(api.filterRecords(items, { documentType: 'ta', lifecycle: 'open', supplier: 'A' }), row => row.id), ['T-19112601']);
  assert.deepEqual(Array.from(api.filterRecords(items, { documentType: 'sc', lifecycle: 'closed' }), row => row.id), ['S-19112601']);
  assert.equal(api.filterRecords(items, { documentType: 'legacy' }).length, 2);
  const csv = api.exportCsv(items, ['id', 'documentType']);
  assert.match(csv, /"PCN type"/);
  assert.match(csv, /"T-19112601","TA"/);
  assert.match(csv, /"S-19112601","SC"/);
  assert.match(csv, /"PCN-2026-0001","Legacy \/ unassigned"/);
  const views = api.readPreferences(JSON.stringify({ views: [{ name: 'TA', filters: { documentType: 'ta' } }, { name: 'Old', filters: {} }] }));
  assert.equal(views.views[0].filters.documentType, 'ta');
  assert.equal(views.views[1].filters.documentType, '');
});

test('document lifecycle groups terminal statuses without rewriting status or changing legacy filters', () => {
  const api = dashboard();
  const items = [...records, { id: 'rejected', status: 'rejected' }, { id: 'closed', status: 'closed' }, { id: 'legacy' }];
  assert.deepEqual(JSON.parse(JSON.stringify(api.lifecycleCounts(items))), { open: 2, closed: 3 });
  assert.deepEqual(Array.from(api.lifecycleRecords(items, 'closed'), item => item.status), ['approved', 'rejected', 'closed']);
  assert.equal(api.filterRecords(items, {}).length, 5);
  assert.equal(api.filterRecords(items, { lifecycle: 'open' }).length, 2);
  assert.equal(api.filterRecords(items, { lifecycle: 'closed', status: 'approved' }).length, 1);
  assert.equal(items[1].status, 'approved');
});

test('dashboard filters combine summary, text, department, supplier, dates and risk without changing source', () => {
  const api = dashboard();
  const result = api.filterRecords(records, { summary: 'attention', search: 'jane', department: 'QA/TET', supplier: 'A', risk: 'High', from: '2026-10-14', to: '2026-10-14' });
  assert.equal(result.length, 1); assert.equal(result[0].id, records[0].id);
  assert.equal(api.filterRecords(records, { summary: 'approved' }).length, 1);
  assert.equal(api.filterRecords(records, { from: 'invalid-date' }).length, 2);
  assert.equal(records[0].dashboard.action.people.length, 1);
});

test('counts use backend attention and approved evidence, never make missing readiness green', () => {
  const api = dashboard();
  assert.deepEqual(JSON.parse(JSON.stringify(api.summaryCounts([...records, { id: 'legacy', status: 'draft' }]))), { all: 3, review: 1, approved: 1, attention: 1 });
  assert.equal(api.documentLabel({}), 'Not available');
  assert.equal(api.documentLabel({dashboard:{documents:{}}}), 'Not available');
  assert.equal(api.pendingLabel({ updatedAt: '2026-10-12T00:00:00Z' }, Date.parse('2026-10-14T00:00:00Z')), '—');
  assert.doesNotMatch(api.pendingLabel({ dashboard: { dueAt: 'invalid' } }), /overdue/i);
});

test('sorting and pagination are stable and do not mutate records', () => {
  const api = dashboard();
  assert.equal(api.sortRecords(records, 'supplierName', 'desc')[0].supplierName, 'B');
  assert.equal(records[0].supplierName, 'A');
  const page = api.paginate(records, 999, 10);
  assert.equal(page.page, 1); assert.equal(page.items.length, 2);
  assert.equal(api.paginate([], 1, 25).pages, 1);
});

test('pending time measures the current status independently of ordinary edits', () => {
  const api = dashboard();
  const record = { status: 'qa_review', updatedAt: '2026-10-30T08:30:00Z', dashboard: { pending: {
    since: '2026-10-21T08:30:00Z', source: 'status_transition', ageDays: 9
  } } };
  assert.equal(api.pendingLabel(record), '9 days');
  const nextStatus = { ...record, status: 'qualification', dashboard: { pending: {
    ...record.dashboard.pending, since: '2026-10-30T08:30:00Z', ageDays: 0
  } } };
  assert.equal(api.pendingLabel(nextStatus), '<1 day');
  assert.equal(api.pendingLabel(record, Date.parse('2026-10-22T08:30:00Z')), '1 day');
});

test('pending time shows only one overdue duration using server time, without dates or repeated deadlines', () => {
  const api = dashboard(); const base = qaRecord({ overdue: true });
  const record = { ...base, dashboard: { pending: { ...base.dashboard.pending,
    since: '2026-10-20T08:30:00Z', source: 'status_transition', ageDays: 9, departmentOverdueDays: 3
  } } };
  const expected = 'Overdue 3 days';
  assert.equal(api.pendingLabel(record), expected);
  assert.ok(api.exportCsv([record], ['pending']).includes(expected));
  assert.equal(api.pendingLabel(record, Date.parse('2026-10-26T08:30:00.001Z')), 'Overdue <1 day');
  assert.equal(api.pendingLabel(record, Date.parse('2026-10-27T08:30:00Z')), 'Overdue 1 day');
  const both = { ...record, dashboard: { pending: { ...record.dashboard.pending,
    reviewDueAt: '2026-10-26T08:30:00Z', reviewOverdueDays: 3
  } } };
  assert.equal(api.pendingLabel(both), 'Overdue 3 days');
  assert.equal(api.pendingLabel({ ...both, dashboard: { pending: { ...both.dashboard.pending, reviewOverdueDays: 4 } } }), 'Overdue 4 days');
});

test('pending time does not invent status age or negative overdue days from missing or future timestamps', () => {
  const api = dashboard(); const now = Date.parse('2026-10-29T08:30:00Z');
  const base = qaRecord({ dueAt: null, overdue: null });
  assert.doesNotMatch(api.pendingLabel({ ...base, updatedAt: '2026-10-28T08:30:00Z' }, now), /In current status|Overdue/);
  const future = { status: 'submitted', dashboard: { pending: { source: 'status_transition', since: '2026-10-30T08:30:00Z' } } };
  assert.equal(api.pendingLabel(future, now), '—');
  assert.doesNotMatch(api.pendingLabel({ ...qaRecord({ overdue: true }), status: 'approved' }, now), /In current status|Overdue/);
});

test('CSV exports selected visible columns with BOM, preserves false/zero and prevents spreadsheet formulas', () => {
  const api = dashboard();
  const csv = api.exportCsv([{ id: 'PCN-1', supplierName: '  =WEBSERVICE("url")', materialName: 'Line\n"quote"', riskLevel: 0, status: false }], ['id', 'supplierName', 'materialName', 'riskLevel', 'status']);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /'  =WEBSERVICE/); assert.match(csv, /"Line\n""quote"""/);
  assert.match(csv, /"0","false"/);
  for (const formula of ['+x', '-x', '@x', '\tx', '\rx', ' \t=x']) assert.ok(api.csvCell(formula).startsWith('"\''));
  assert.doesNotMatch(api.exportCsv([{ id: 'PCN', supplierName: 'Hidden' }], ['id']), /Hidden/);
});

test('stored views reject malformed, oversized and unexpected data, and user preferences remain bounded', () => {
  const api = dashboard();
  assert.equal(api.readPreferences('{broken').views.length, 0);
  const prefs = api.readPreferences(JSON.stringify({ views: [{ name: 'QA queue', filters: { department: 'QA/TET', bad: 'ignored' } }, { name: '', filters: {} }], columns: ['id', 'unknown', 'status'], pageSize: 999 }));
  assert.equal(prefs.views.length, 1); assert.equal(prefs.views[0].filters.bad, undefined);
  assert.equal(prefs.pageSize, 25); assert.deepEqual(Array.from(prefs.columns), ['id', 'status']);
  assert.equal(api.readPreferences('x'.repeat(25000)).views.length, 0);
});

test('timeline signing points show department, action and signer from stored changes', () => {
  const api = dashboard();
  const points = api.timelinePoints([{ revision: 2, actor: 'Editor', createdAt: '2026-10-14T01:00:00Z', status: 'review', changes: [
    { path: 'internalReview.signoff.gscTet.checked', before: false, after: true },
    { path: 'internalReview.signoff.gscTet.checkedName', after: 'Alice' },
  ] }]);
  assert.equal(points[0].label, 'GSC/TET — Checked'); assert.equal(points[0].person, 'Alice');
  assert.equal(api.timelinePoints([{ revision: 1, isBaseline: true }])[0].label, 'History baseline');
});

test('preview markers never imply approval for rejected, draft or unknown baseline events', () => {
  const api = dashboard();
  assert.equal(api.timelineTone({ isBaseline: true, status: 'approved' }).tone, 'neutral');
  assert.equal(api.timelineTone({ status: 'rejected' }).marker, '!');
  assert.equal(api.timelineTone({ status: 'draft' }).tone, 'active');
  assert.equal(api.timelineTone({ signed: true, status: 'gsc_review' }).marker, '✓');
});

test('preview does not combine a newer record with stale assignee or readiness metadata', () => {
  const api = dashboard();
  const old = {version:1, dashboard:{action:{label:'QA checked'}}};
  const newer = {version:2,status:'approved'};
  assert.equal(api.currentSummary(newer, old), newer);
  assert.equal(api.currentSummary({...newer,version:1}, old), old);
});

function controllerPage(fetch, options = {}) {
  const all = [];
  const document = { activeElement: null, events: {}, addEventListener(name, listener) { this.events[name] = listener; }, removeEventListener(name) { delete this.events[name]; } };
  const createElement = tag => {
    const element = { tag, children: [], events: {}, attributes: {}, dataset: {}, value: '', textContent: '', open: false, isConnected: true,
      append(...children) { children.forEach(child => { child.parentElement = this; }); this.children.push(...children); }, prepend(child) { child.parentElement = this; this.children.unshift(child); },
      replaceChildren(...children) { children.forEach(child => { child.parentElement = this; }); this.children = children; }, getAttribute(key) { return this.attributes[key]; }, contains(target) { return this === target || this.querySelectorAll().includes(target); }, closest(selector) { return selector.split(',').includes(this.tag) ? this : this.parentElement?.closest(selector); }, setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(event, listener) { this.events[event] = [...(this.events[event] || []), listener]; },
      async emit(event, value = {}) { for (const listener of this.events[event] || []) await listener({target:this, preventDefault(){}, ...value}); },
      querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); },
      focus() { document.activeElement = this; }, showModal() { this.open = true; }, close() { this.open = false; }, remove() {},
    };
    if (tag === 'a' && options.resolveLinks) Object.defineProperty(element, 'href', { get() { return new URL(this.attributes.href, 'http://records.example').href; }, set(value) { this.attributes.href = value; } });
    all.push(element); return element;
  };
  document.createElement = createElement; document.body = createElement('body');
  const window = { PCN_TYPES: require('../pcn-types'), location: { href: options.href || 'http://records.example/records' }, localStorage: {getItem(){return null;},setItem(){} } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../records.js'), 'utf8'), {window, document, Date, Blob, URL});
  const root = createElement('main'); const rows = createElement('tbody'); root.append(rows);
  const search = createElement('input'); root.append(search);
  const count = createElement('span'); const message = createElement('p'); let accessLost = 0;
  const controller = window.PCN_RECORDS_DASHBOARD.create({root,rows,search,count,message,user:{id:'viewer'},fetch,onAccessLost(){accessLost++;}, ...options});
  return { controller, document, rows, root, search, count, message, all, createElement, find:id => all.find(item => item.id === id),
    button: (text, inside = root) => inside.querySelectorAll().find(item => item.tag === 'button' && (item.textContent === text || item.attributes['aria-label']?.startsWith(`${text} `))),
    lost:()=>accessLost };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('advanced record filters start collapsed and preserve their values and expanded state across renders', async () => {
  const page = controllerPage(async () => ({}));
  page.controller.setRecords([{id:'T-23112601',supplierName:'Acme',status:'submitted'}]);
  const toggle = page.find('rdFiltersToggle'); const advanced = page.find('rdAdvancedFilters');
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.equal(toggle.attributes['aria-controls'], advanced.id);
  assert.equal(advanced.hidden, true);
  assert.equal(advanced.contains(page.find('rdFilter-saved')), true);
  assert.equal(advanced.contains(page.find('rdViewEditor')), true);
  assert.equal(advanced.contains(page.search), false);
  await toggle.emit('click');
  assert.equal(advanced.hidden, false); assert.equal(toggle.attributes['aria-expanded'], 'true');
  const supplier = page.find('rdFilter-supplier'); supplier.value='Acme'; await supplier.emit('change');
  page.controller.setRecords([{id:'T-23112601',supplierName:'Acme',status:'submitted'},{id:'T-23112602',supplierName:'Other',status:'submitted'}]);
  assert.equal(advanced.hidden, false); assert.equal(supplier.value, 'Acme');
  await toggle.emit('click');
  assert.equal(advanced.hidden, true); assert.equal(page.rows.children.length, 1);
  page.controller.setRecords([{id:'T-23112601',supplierName:'Acme',status:'submitted'}]);
  assert.equal(advanced.hidden, true); assert.equal(page.controller.getState().filters.supplier, 'Acme');
});

test('collapsing advanced filters safely closes editors, returns focused controls and clear resets expansion', async () => {
  const page = controllerPage(async () => ({})); page.controller.setRecords([]);
  const toggle = page.find('rdFiltersToggle'); const advanced = page.find('rdAdvancedFilters');
  await toggle.emit('click'); page.find('rdViewEditor').open = true; page.find('rdColumnChooser').open = true;
  page.find('rdViewName').focus(); await toggle.emit('click');
  assert.equal(page.document.activeElement, toggle);
  assert.equal(page.find('rdViewEditor').open, false); assert.equal(page.find('rdColumnChooser').open, false);
  await toggle.emit('click'); page.controller.clear();
  assert.equal(advanced.hidden, true); assert.equal(toggle.attributes['aria-expanded'], 'false');
});

test('initial records loading shows only decorative skeleton rows with a single busy status', () => {
  const page = controllerPage(async () => ({}));
  page.controller.setLoading(true);
  assert.equal(page.find('rdRecordsPanel').attributes['aria-busy'], 'true');
  assert.equal(page.find('rdRecordsLoading').hidden, false);
  assert.equal(page.find('rdRecordsLoading').attributes.role, 'status');
  assert.equal(page.find('rdRecordsLoadingOverlay').hidden, false);
  assert.equal(page.find('rdRecordsLoadingOverlay').attributes['aria-hidden'], 'true');
  assert.equal(page.count.textContent, '—');
  assert.equal(page.rows.children.length, 5);
  for (const row of page.rows.children) {
    assert.equal(row.className, 'rd-skeleton-row');
    assert.equal(row.attributes['aria-hidden'], 'true');
    assert.equal(row.children.length, page.controller.getState().preferences.columns.length + 1);
    assert.equal(row.dataset.pcnId, undefined);
  }
  page.controller.setRecords([]);
  page.controller.setLoading(false);
  assert.equal(page.find('rdRecordsLoading').hidden, true);
  assert.equal(page.find('rdRecordsPanel').attributes['aria-busy'], 'false');
  assert.equal(page.count.textContent, '0');
  assert.match(page.rows.children[0].children[0].textContent, /No PCN records/);
});

test('manual refresh keeps real rows and filter state while quiet polling never changes the loading presentation', async () => {
  const page = controllerPage(async () => ({}));
  page.controller.setRecords([{ id:'T-23112601', status:'submitted', supplierName:'Acme' }]);
  page.search.value = 'Acme'; await page.search.emit('input');
  const row = page.rows.children[0];
  const count = page.count.textContent;
  page.controller.setLoading(true);
  assert.equal(page.rows.children[0], row);
  assert.equal(page.count.textContent, count);
  assert.equal(page.controller.getState().filters.search, 'Acme');
  assert.equal(page.find('rdRecordsLoadingLabel').textContent, 'Refreshing PCN records…');
  page.controller.setLoading(false);
  page.controller.setLoading(true, { quiet:true });
  assert.equal(page.find('rdRecordsLoading').hidden, true);
  assert.equal(page.find('rdRecordsPanel').attributes['aria-busy'], 'false');
  assert.equal(page.rows.children[0], row);
});

test('failed initial records load offers retry and clears skeletons, retry and access cleanup cannot retain loading UI', () => {
  const page = controllerPage(async () => ({}));
  page.controller.setLoading(true);
  page.controller.setLoading(false, { error:true });
  assert.equal(page.rows.children.length, 1);
  assert.equal(page.rows.children[0].children[0].className, 'rd-load-error records-empty');
  assert.match(page.rows.children[0].children[0].textContent, /Refresh.*try again/);
  assert.equal(page.find('rdRecordsLoading').hidden, true);
  page.search.value = 'Acme'; page.search.events.input[0]();
  assert.match(page.rows.children[0].children[0].textContent, /Refresh.*try again/);
  page.controller.setLoading(true);
  assert.equal(page.rows.children.length, 5);
  page.controller.clear();
  assert.equal(page.rows.children.length, 0);
  assert.equal(page.find('rdRecordsLoading').hidden, true);
  assert.equal(page.find('rdRecordsLoadingOverlay').hidden, true);
  assert.equal(page.find('rdRecordsPanel').attributes['aria-busy'], 'false');
  page.controller.destroy();
  page.controller.setLoading(true);
  assert.equal(page.rows.children.length, 0);
  assert.equal(page.find('rdRecordsLoading').hidden, true);
});

test('type selection survives lifecycle switching, refresh and saved views while reset keeps the active tab', async () => {
  const page = controllerPage(async () => ({}));
  const items = [
    { id: 'T-19112601', documentType: 'ta', status: 'submitted', supplierName: 'Shared' },
    { id: 'T-19112602', documentType: 'ta', status: 'closed', supplierName: 'Shared' },
    { id: 'S-19112601', documentType: 'sc', status: 'closed', supplierName: 'Shared' },
  ];
  page.controller.setRecords(items);
  const type = page.find('rdFilter-documentType');
  assert.deepEqual(type.children.map(option => option.value), ['', 'ta', 'sc', 'legacy']);
  type.value = 'ta'; await type.emit('change');
  assert.equal(page.rows.children[0].dataset.pcnId, 'T-19112601');
  await page.find('rdLifecycleTab-closed').emit('click');
  assert.equal(type.value, 'ta'); assert.equal(page.rows.children[0].dataset.pcnId, 'T-19112602');
  page.controller.setRecords([...items, { id: 'T-19112603', documentType: 'ta', status: 'closed' }]);
  assert.equal(type.value, 'ta'); assert.equal(page.count.textContent, '2');
  page.find('rdViewName').value = 'TA completed'; await page.button('Save current view').emit('click');
  type.value = 'sc'; await type.emit('change');
  const saved = page.find('rdFilter-saved'); saved.value = 'TA completed'; await saved.emit('change');
  assert.equal(type.value, 'ta'); assert.equal(page.count.textContent, '2');
  await page.button('Reset filters').emit('click');
  assert.equal(page.controller.getState().lifecycle, 'closed');
  assert.equal(type.value, ''); assert.equal(page.count.textContent, '3');
});

test('revision history identifies the typed engineering group while retaining the legacy signing path', () => {
  const revisions = [{ revision: 2, changes: [{ path: 'internalReview.signoff.prodEngTet.prepared', after: true }] }];
  const api = dashboard();
  for (const [documentType, expected] of [['ta', 'Prod.Eng/TA'], ['sc', 'Prod.Eng/SC']]) {
    assert.match(api.timelinePoints(revisions, { documentType })[0].label, new RegExp(`^${expected}`));
  }
  assert.match(api.timelinePoints(revisions)[0].label, /^Prod.Eng\/TET/);
});

test('shared records tabs default to Open and scope counts, options, summaries and refreshed rows', async () => {
  const page = controllerPage(async () => ({}));
  const items = [...records, { id: 'PCN-REJECTED', status: 'rejected', supplierName: 'C' }, { id: 'PCN-CLOSED', status: 'closed', supplierName: 'D' }];
  page.controller.setRecords(items);
  const open = page.find('rdLifecycleTab-open'); const closed = page.find('rdLifecycleTab-closed');
  assert.equal(open.attributes.role, 'tab'); assert.equal(open.attributes['aria-selected'], 'true'); assert.equal(open.tabIndex, 0); assert.equal(closed.tabIndex, -1);
  assert.equal(page.controller.getState().lifecycle, 'open'); assert.equal(page.count.textContent, '1');
  assert.equal(open.children[1].textContent, '1'); assert.equal(closed.children[1].textContent, '3');
  assert.deepEqual(page.find('rdFilter-status').children.map(item => item.value), ['', 'submitted']);
  await closed.emit('click');
  assert.equal(page.count.textContent, '3'); assert.equal(page.controller.getState().lifecycle, 'closed');
  assert.equal(closed.attributes['aria-selected'], 'true'); assert.equal(open.tabIndex, -1);
  assert.deepEqual(page.find('rdFilter-status').children.map(item => item.value), ['', 'approved', 'closed', 'rejected']);
  const rejected = page.all.filter(item => item.dataset.summary === 'rejected').at(-1);
  await rejected.emit('click'); assert.equal(page.count.textContent, '1'); assert.equal(page.rows.children[0].dataset.pcnId, 'PCN-REJECTED');
  await page.button('Reset filters').emit('click'); assert.equal(page.controller.getState().lifecycle, 'closed'); assert.equal(page.count.textContent, '3');
  page.controller.setRecords([...items, { id: 'NEW', status: 'closed' }]);
  assert.equal(page.controller.getState().lifecycle, 'closed'); assert.equal(page.count.textContent, '4'); assert.equal(closed.children[1].textContent, '4');
  page.controller.clear(); assert.equal(open.children[1].textContent, '0'); assert.equal(closed.children[1].textContent, '0');
});

test('lifecycle keyboard switching resets status and page while retaining search and sorting', async () => {
  const page = controllerPage(async () => ({}));
  page.controller.setRecords([...Array.from({length:30}, (_, index) => ({ id: `OPEN-${index}`, status: 'submitted', supplierName: 'Shared' })), { id: 'CLOSED', status: 'closed', supplierName: 'Shared' }]);
  const status = page.find('rdFilter-status'); status.value = 'submitted'; await status.emit('change');
  page.search.value = 'Shared'; await page.search.emit('input'); await page.button('Next').emit('click');
  assert.equal(page.controller.getState().page, 2);
  const tablist = page.find('rdLifecycleTab-open').parentElement;
  await tablist.emit('keydown', {key:'End'});
  assert.equal(page.controller.getState().lifecycle, 'closed'); assert.equal(page.controller.getState().page, 1);
  assert.equal(page.controller.getState().filters.status, ''); assert.equal(page.controller.getState().filters.search, 'Shared');
  assert.equal(page.document.activeElement, page.find('rdLifecycleTab-closed'));
  assert.equal(page.count.textContent, '1');
  await tablist.emit('keydown', {key:'ArrowRight'}); assert.equal(page.controller.getState().lifecycle, 'open');
  await tablist.emit('keydown', {key:'ArrowLeft'}); assert.equal(page.controller.getState().lifecycle, 'closed');
  await tablist.emit('keydown', {key:'Home'}); assert.equal(page.controller.getState().lifecycle, 'open');
});

test('closed records deep links are allowlisted and saved views retain their lifecycle', async () => {
  const page = controllerPage(async () => ({}), { href: 'http://records.example/admin?documents=closed#records' });
  page.controller.setRecords(records); assert.equal(page.controller.getState().lifecycle, 'closed');
  page.find('rdViewName').value = 'Finished'; await page.button('Save current view').emit('click');
  assert.equal(page.controller.getState().preferences.views[0].lifecycle, 'closed');
  await page.find('rdLifecycleTab-open').emit('click'); const saved = page.find('rdFilter-saved'); saved.value = 'Finished'; await saved.emit('change');
  assert.equal(page.controller.getState().lifecycle, 'closed'); assert.equal(page.rows.children[0].dataset.pcnId, records[1].id);
  const invalid = controllerPage(async () => ({}), { href: 'http://records.example/records?documents=anything' });
  assert.equal(invalid.controller.getState().lifecycle, 'open');
  const stored = dashboard().readPreferences(JSON.stringify({ views: [{ name:'Finished', lifecycle:'closed', filters:{} }, {name:'Legacy', filters:{}}] }));
  assert.equal(stored.views[0].lifecycle, 'closed'); assert.equal(stored.views[1].lifecycle, 'open');
});

test('legacy saved terminal views select Closed while explicit lifecycle selections are preserved', () => {
  const views = [
    { name: 'Approved summary', filters: { summary: 'approved' } },
    ...['approved', 'rejected', 'closed'].map(status => ({ name: status, filters: { status } })),
    { name: 'Rejected summary', filters: { summary: 'rejected' } },
    { name: 'Closed summary', filters: { summary: 'closed' } },
    { name: 'Open explicit', lifecycle: 'open', filters: { summary: 'approved' } },
    { name: 'Closed explicit', lifecycle: 'closed', filters: {} },
    { name: 'Open legacy', filters: { summary: 'attention', status: 'submitted' } },
  ];
  const restored = dashboard().readPreferences(JSON.stringify({ views })).views;
  assert.deepEqual(Array.from(restored, view => view.lifecycle), ['closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'open', 'closed', 'open']);
  assert.equal(restored[0].filters.summary, 'approved');
  assert.equal(restored[2].filters.status, 'rejected');
});

test('closed lifecycle empty state distinguishes no finished documents from filtered results', async () => {
  const page = controllerPage(async () => ({})); page.controller.setRecords([records[0]]);
  await page.find('rdLifecycleTab-closed').emit('click');
  assert.match(page.rows.children[0].children[0].textContent, /No closed documents yet/);
  page.controller.setRecords(records); page.search.value = 'not found'; await page.search.emit('input');
  assert.match(page.rows.children[0].children[0].textContent, /No closed documents match/);
  assert.equal(page.find('rdLifecycleTab-closed').children[1].textContent, '1');
});

function prodEngRecord(overrides = {}) {
  return { id: 'PCN-DUE', status: 'technical_review', version: 1, dashboard: { pending: { overdue: false,
    since: '2026-10-20T08:30:00Z', source: 'status_transition', ageDays: 1, departmentOverdueDays: overrides.overdue === true ? 2 : null, prodEngDeadline: {
    department: 'prodEngTet', label: 'Prod.Eng/TET', startedAt: '2026-10-20T08:30:00Z', dueAt: '2026-10-23T08:30:00Z', overdue: false, source: 'handoff', ...overrides,
  } } } };
}

function qaRecord(overrides = {}) {
  const deadline = { department: 'qaTet', label: 'QA/TET', startedAt: '2026-10-23T08:30:00Z', dueAt: '2026-10-26T08:30:00Z', overdue: false, source: 'handoff', ...overrides };
  return { id: 'PCN-QA-DUE', status: 'qa_review', version: 1, dashboard: { pending: { overdue: deadline.overdue === true,
    since: '2026-10-23T08:30:00Z', source: 'status_transition', ageDays: 1, departmentOverdueDays: deadline.overdue === true ? 2 : null,
    activeReviewDeadline: deadline, prodEngDeadline: null, qaDeadline: deadline } } };
}

test('QA/TET pending duration stays compact with legacy department metadata and in CSV', () => {
  const api = dashboard(); const base = qaRecord();
  const record = { ...base, dashboard: { pending: { ...base.dashboard.pending, prodEngDeadline: prodEngRecord().dashboard.pending.prodEngDeadline } } };
  const expected = '1 day';
  assert.equal(api.pendingLabel(record), expected);
  assert.ok(api.exportCsv([record], ['pending']).includes(expected));
  assert.equal(api.pendingLabel({ ...base, dashboard: { pending: { ...base.dashboard.pending, activeReviewDeadline: undefined } } }), expected);
  assert.equal(api.pendingLabel(qaRecord({ dueAt: null, startedAt: null, source: 'unknown', overdue: null })), '1 day');
});

test('overdue review highlights the whole row, preserves selection and clears after completion', () => {
  const page = controllerPage(async () => ({}), { selectedId: () => 'PCN-QA-DUE' });
  page.controller.setRecords([qaRecord({ overdue: true }), prodEngRecord({ overdue: true }), { ...qaRecord(), id: 'PCN-ON-TIME' }]);
  const row = id => page.rows.children.find(item => item.dataset.pcnId === id);
  assert.match(row('PCN-QA-DUE').className || '', /rd-row-overdue/);
  assert.match(row('PCN-QA-DUE').className, /is-selected/);
  assert.equal(row('PCN-QA-DUE').attributes['aria-selected'], 'true');
  assert.match(row('PCN-DUE').className || '', /rd-row-overdue/);
  assert.doesNotMatch(row('PCN-ON-TIME').className || '', /rd-row-overdue/);
  page.controller.setRecords([qaRecord(), prodEngRecord({ dueAt: null, overdue: null }), { ...qaRecord({ overdue: true }), status: 'approved' }]);
  assert.ok(page.rows.children.every(row => !/rd-row-overdue/.test(row.className || '')));
});

test('QA/TET red overdue alerts and badges coexist with Prod.Eng/TET counts and clear when review completes', async () => {
  const page = controllerPage(async () => ({}));
  const qa = qaRecord({ overdue: true });
  page.controller.setRecords([qa, { ...qa, id: 'PCN-QA-2' }, prodEngRecord({ overdue: true })]);
  const banner = page.root.querySelectorAll().find(item => item.className === 'rd-overdue-alert');
  assert.equal(banner.hidden, false); assert.match(banner.textContent, /2 PCNs overdue for QA\/TET/); assert.match(banner.textContent, /1 PCN overdue for Prod\.Eng\/TET/);
  const pendingCell = page.rows.children.find(row => row.dataset.pcnId === qa.id).children.find(item => item.dataset.column === 'pending');
  assert.match(pendingCell.className, /rd-overdue/); assert.equal(pendingCell.textContent, 'Overdue 2 days');
  const pendingChoice = page.find('rdColumnChooser').querySelectorAll().find(item => item.tag === 'label' && item.children.some(child => child.textContent === 'Pending time')).children[0];
  pendingChoice.checked = false; await pendingChoice.emit('change');
  const qaBadges = page.rows.querySelectorAll().filter(item => item.attributes?.['aria-label'] === 'QA/TET overdue');
  assert.equal(qaBadges.length, 2); assert.ok(qaBadges.every(item => item.className.includes('rd-deadline-overdue')));
  page.controller.setRecords([{ ...qa, dashboard: { action: { department: 'qaTet', label: 'QA/TET Final Judgment' }, pending: { overdue: false, activeReviewDeadline: null, prodEngDeadline: null, qaDeadline: null } } }]);
  assert.equal(banner.hidden, true); assert.equal(banner.textContent, '');
  assert.equal(page.rows.querySelectorAll().some(item => item.attributes?.['aria-label'] === 'QA/TET overdue'), false);
  page.controller.setRecords([{ ...qa, status: 'approved' }]); assert.equal(banner.hidden, true);
});

test('QA/TET due time is shared by overview and current department timeline details', async () => {
  const record = qaRecord({ overdue: true }); const deadline = record.dashboard.pending.qaDeadline;
  const snapshot = { id: record.id, version: 1, status: 'qa_review', nextAction: { label: 'QA/TET — Prepared', terminal: false }, stages: [{
    key: 'qaTet', label: 'QA/TET', state: 'current', completed: 0, total: 3, currentStep: 'Prepared', deadline,
    steps: ['prepared', 'checked', 'approved'].map(action => ({ action, label: action[0].toUpperCase() + action.slice(1), completed: false, person: null, signedAt: null })),
  }] };
  const page = controllerPage(async url => url.endsWith('/workflow-summary') ? snapshot : url.endsWith('/progress') ? { steps: [] } : record);
  const expected = `QA/TET due ${new Date(deadline.dueAt).toLocaleString()} (overdue)`;
  page.controller.setRecords([record]); await page.button('Quick view').emit('click');
  assert.ok(page.find('rdPreviewContent').querySelectorAll().some(item => item.textContent === dashboard().pendingLabel(record)));
  await page.find('rdPreviewTab-timeline').emit('click'); await settle();
  const details = page.find('rdWorkflowDetails');
  assert.ok(details.children.some(item => item.textContent === expected && item.className === 'rd-overdue'));
});

test('Prod.Eng/TET pending duration is shared with CSV without due dates', () => {
  const api = dashboard(); const record = prodEngRecord();
  const expected = '1 day';
  assert.equal(api.pendingLabel(record), expected);
  assert.ok(api.exportCsv([record], ['pending']).includes(expected));
  assert.equal(api.pendingLabel(prodEngRecord({ dueAt: null, startedAt: null, source: 'unknown', overdue: null })), '1 day');
  assert.doesNotMatch(api.pendingLabel({ ...record, status: 'approved' }), /Prod\.Eng\/TET/);
  assert.equal(api.pendingLabel({ dashboard: { pending: { overdue: true, reviewDueAt: '2026-10-21T08:30:00Z' } } }, Date.parse('2026-10-24T08:30:00Z')), 'Overdue 3 days');
});

test('pending time counts explicit overdue days when the department deadline is unknown or still on time', () => {
  const api = dashboard(); const now = Date.parse('2026-10-22T08:30:00Z');
  const reviewDueAt = '2026-10-21T08:30:00Z';
  for (const overrides of [{ overdue: false }, { dueAt: null, overdue: null, source: 'unknown' }]) {
    const base = prodEngRecord(overrides);
    const record = { ...base, dashboard: { pending: { ...base.dashboard.pending, overdue: true, reviewDueAt } } };
    const text = api.pendingLabel(record, now);
    assert.equal(text, 'Overdue 1 day');
  }
  const base = prodEngRecord({ overdue: true });
  const record = { ...base, dashboard: { pending: { ...base.dashboard.pending, overdue: true, reviewDueAt: '2026-10-25T08:30:00Z' } } };
  assert.equal(api.pendingLabel(record, Date.parse('2026-10-24T08:30:00Z')), 'Overdue 1 day');
});

test('Prod.Eng/TET overdue alert counts records and persists in PCN code when pending column is hidden', async () => {
  const page = controllerPage(async () => ({}));
  const overdue = prodEngRecord({ overdue: true }); overdue.dashboard.pending.overdue = true;
  page.controller.setRecords([overdue, { ...overdue, id: 'PCN-DUE-2' }]);
  const banner = page.root.querySelectorAll().find(item => item.className === 'rd-overdue-alert');
  assert.ok(banner); assert.equal(banner.attributes.role, 'status'); assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /2 PCNs overdue for Prod\.Eng\/TET/);
  const pendingCell = page.rows.querySelectorAll().find(item => item.dataset.column === 'pending');
  assert.match(pendingCell.className, /rd-overdue/); assert.equal(pendingCell.textContent, 'Overdue 2 days');
  const pendingChoice = page.find('rdColumnChooser').querySelectorAll().find(item => item.tag === 'label' && item.children.some(child => child.textContent === 'Pending time')).children[0];
  pendingChoice.checked = false; await pendingChoice.emit('change');
  assert.equal(page.rows.querySelectorAll().some(item => item.dataset.column === 'pending'), false);
  const badges = page.rows.querySelectorAll().filter(item => item.attributes?.['aria-label'] === 'Prod.Eng/TET overdue');
  assert.equal(badges.length, 2); assert.ok(badges.every(item => item.className.includes('rd-deadline-overdue')));
  assert.ok(badges.every(item => item.parentElement.className === 'rd-code-cell'));
  page.controller.setRecords([prodEngRecord()]);
  assert.equal(banner.hidden, true); assert.equal(banner.textContent, '');
  assert.equal(page.rows.querySelectorAll().some(item => item.attributes?.['aria-label'] === 'Prod.Eng/TET overdue'), false);
  page.controller.setRecords([prodEngRecord({ dueAt: null, overdue: null, source: 'unknown' })]);
  assert.equal(banner.hidden, true);
  assert.equal(page.rows.querySelectorAll().some(item => item.attributes?.['aria-label'] === 'Prod.Eng/TET overdue'), false);
  page.controller.setRecords([{ ...overdue, status: 'qa_review', dashboard: { pending: { prodEngDeadline: null, overdue: false } } }]);
  assert.equal(banner.hidden, true);
  page.controller.setRecords([{ ...overdue, status: 'approved' }]);
  assert.equal(banner.hidden, true);
  assert.equal(page.rows.querySelectorAll().some(item => item.attributes?.['aria-label'] === 'Prod.Eng/TET overdue'), false);
  page.controller.setRecords([overdue]); assert.match(banner.textContent, /^1 PCN overdue/); page.controller.clear();
  assert.equal(banner.hidden, true); assert.equal(banner.textContent, '');
});

test('Prod.Eng/TET preview overview shows the same compact pending duration', async () => {
  const record = prodEngRecord();
  const page = controllerPage(async url => url.endsWith('/progress') ? { steps: [] } : record);
  page.controller.setRecords([record]); await page.button('Quick view').emit('click');
  const expected = '1 day';
  assert.ok(page.find('rdPreviewContent').querySelectorAll().some(item => item.textContent === expected));
});

test('Prod.Eng/TET overdue badge and alert use readable red text with a red surface', () => {
  const css = fs.readFileSync(require.resolve('../records.css'), 'utf8');
  assert.match(css, /\.rd-deadline-overdue[^{}]*\{[^}]*color:\s*#8e2624/);
  assert.match(css, /\.rd-overdue-alert[^{}]*\{[^}]*background:\s*#fff0ef/);
});

test('shared controller preserves focus after changed records and pauses polling while preview is open', async () => {
  const page = controllerPage(async url => url.endsWith('/progress') ? {steps:[]} : {id:'PCN-1',version:1});
  page.controller.setRecords([{id:'PCN-1',version:1}]);
  const preview = page.button('Quick view'); preview.focus();
  page.controller.setRecords([{id:'PCN-1',version:1,supplierName:'Changed'}]);
  assert.equal(page.document.activeElement.dataset.rdFocus, 'preview:PCN-1');
  assert.notEqual(page.document.activeElement, preview);
  await page.button('Quick view').emit('click');
  assert.equal(page.controller.canRefresh(),false);
  await page.find('rdPreviewDialog').emit('cancel');
  assert.equal(page.controller.canRefresh(),true);
  assert.equal(page.document.activeElement.dataset.rdFocus,'preview:PCN-1');
});

test('malformed timeline response is not cached and Retry issues a new authorized read', async () => {
  let revisionCalls = 0;
  const page = controllerPage(async url => {
    if(url.endsWith('/revisions')) return ++revisionCalls === 1 ? {items:null} : {items:[{revision:1,actor:'Actual signer'}]};
    return url.endsWith('/progress') ? {steps:[]} : {id:'PCN-1'};
  });
  page.controller.setRecords([{id:'PCN-1'}]); await page.button('Quick view').emit('click');
  await page.find('rdPreviewTab-history').emit('click'); await settle();
  const content = page.find('rdPreviewContent');
  assert.match(content.children[0].textContent,/invalid response/);
  await page.button('Retry',content).emit('click');
  assert.equal(revisionCalls,2); assert.ok(content.querySelectorAll().some(item=>item.textContent==='Actual signer'));
});

test('permission loss in preview clears record options and stops future preview reads', async () => {
  let calls = 0;
  const page = controllerPage(async()=>{calls++;throw Object.assign(new Error('Forbidden'),{status:403});});
  page.controller.setRecords([{id:'PCN-1',supplierName:'Protected supplier',status:'submitted'}]);
  const preview = page.button('Quick view'); await preview.emit('click');
  assert.equal(page.rows.children.length,0); assert.equal(page.count.textContent,'0');
  assert.equal(page.find('rdFilter-supplier').children.length,1);
  assert.equal(page.controller.canRefresh(),false); assert.equal(page.find('rdPreviewDialog').open,false); assert.equal(page.lost(),1);
  await preview.emit('click'); assert.equal(calls,2); // Two parallel overview GETs; no subsequent reads.
});

test('a closed or superseded preview cannot render late responses', async () => {
  let resolveRead;
  const late = new Promise(resolve=>{resolveRead=resolve;});
  const page = controllerPage(()=>late);
  page.controller.setRecords([{id:'PCN-1'}]);
  const opened = page.button('Quick view').emit('click');
  await page.find('rdPreviewDialog').emit('cancel');
  resolveRead({id:'PCN-1',supplierName:'Late private data',steps:[]}); await opened;
  assert.equal(page.find('rdPreviewContent').children.length,0);
  assert.equal(page.controller.getState().preview,null);
});

test('Portal selection retains its existing highlight and accessible selection state', () => {
  const page = controllerPage(async()=>({}),{selectedId:()=> 'PCN-2'});
  page.controller.setRecords([{id:'PCN-1'},{id:'PCN-2'}]);
  const selected = page.rows.children.find(row=>row.dataset.pcnId==='PCN-2');
  assert.equal(selected.className,'is-selected'); assert.equal(selected.attributes['aria-selected'],'true');
  assert.equal(page.rows.children.find(row=>row.dataset.pcnId==='PCN-1').attributes['aria-selected'],'false');
});

test('overview never mixes a fresh record with independently fetched old progress', async () => {
  const page = controllerPage(async url => url.endsWith('/progress') ? {status:'submitted',currentStepTitle:'Old GSC review',steps:[{title:'Old pending stage',state:'active'}]} : {id:'PCN-1',version:2,status:'approved'});
  page.controller.setRecords([{id:'PCN-1',version:1,status:'submitted',dashboard:{progress:{status:'submitted',currentStepTitle:'Old GSC review'},action:{label:'Old pending approver'}}}]);
  await page.button('Quick view').emit('click');
  const content = page.find('rdPreviewContent'); const text = content.querySelectorAll().map(item=>item.textContent).join(' ');
  assert.match(text,/Approved/); assert.match(text,/Refresh the records list/);
  assert.doesNotMatch(text,/Old GSC review|Old pending stage|Old pending approver/);
  const api = dashboard(); const record={version:3,status:'qa_review'};
  const summary={...record,dashboard:{progress:{status:'qa_review',currentStepTitle:'Verified snapshot'}}};
  assert.equal(api.currentProgress(record,summary,{status:'approved',currentStepTitle:'Racing independent read'}).currentStepTitle,'Verified snapshot');
  assert.equal(api.currentProgress(record,{...record},{status:'qa_review',currentStepTitle:'Stale same-status signing stage'}),null);
});

test('Rejected displays its actual signing count without a false 100 percent completed workflow', async () => {
  const progress = {status:'rejected',terminal:true,progressPercent:100,totalSignatures:18,completedSignatures:2,steps:[{title:'Stage never signed',state:'completed'}]};
  const record = {id:'PCN-1',version:1,status:'rejected',dashboard:{progress}};
  const page = controllerPage(async url => url.endsWith('/progress') ? progress : record);
  page.controller.setRecords([record]);
  await page.find('rdLifecycleTab-closed').emit('click');
  assert.equal(page.rows.querySelectorAll().filter(item=>item.tag==='progress').length,0);
  assert.ok(page.rows.querySelectorAll().some(item=>item.textContent==='2/18 signing steps'));
  await page.button('Quick view').emit('click');
  const content = page.find('rdPreviewContent'); const displayed=content.querySelectorAll().map(item=>item.textContent).join(' ');
  assert.match(displayed,/Rejected/); assert.match(displayed,/Review ended with rejection/);
  assert.doesNotMatch(displayed,/Stage never signed|100%/);
  assert.equal(content.querySelectorAll().filter(item=>item.className==='rd-step-completed').length,0);
  const approved = {...record,status:'approved',dashboard:{progress:{...progress,status:'approved'}}};
  const normal = controllerPage(async()=>({})); normal.controller.setRecords([approved]); await normal.find('rdLifecycleTab-closed').emit('click');
  assert.equal(normal.rows.querySelectorAll().filter(item=>item.tag==='progress').length,1);
});


test('record opening uses native links with the exact authorized route and keeps testing identity separate', () => {
  const page = controllerPage(async () => ({}), { codeHref: record => `/view/${record.id}?readonly=1` });
  const record = { id: 'PCN-2026-0001', isTestDocument: true };
  page.controller.setRecords([record]);
  const links = page.rows.querySelectorAll().filter(item => item.tag === 'a');
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent, record.id);
  assert.equal(links[1].textContent, 'Open PCN');
  for (const link of links) {
    assert.equal(link.href, '/view/PCN-2026-0001?readonly=1');
    assert.equal(link.target, undefined);
    assert.equal(link.events.click, undefined, 'native navigation supports modifiers and middle click');
  }
  assert.equal(links[1].dataset.rdFocus, `open:${record.id}`);
  links[1].focus();
  page.controller.setRecords([{ ...record, supplierName: 'Updated' }]);
  assert.equal(page.document.activeElement.dataset.rdFocus, `open:${record.id}`);
  const identity = page.rows.querySelectorAll().find(item => item.className === 'rd-code-cell');
  assert.equal(identity.children[0].textContent, record.id);
  assert.equal(identity.children[1].textContent, 'TESTING DOC');
  assert.equal(identity.children[2].textContent, 'Open PCN');
  assert.equal(identity.parentElement.dataset.column, 'id');
});

test('compact identity exposes canonical TA or SC badges without changing the code link or inventing legacy types', () => {
  const page = controllerPage(async () => ({}), { codeHref: record => `/view/${record.id}?readonly=1` });
  const records = [{id:'T-23112601',documentType:'ta',isTestDocument:true}, {id:'S-23112601',documentType:'sc'},
    {id:'T-23112602'}, {id:'PCN-2026-0001'}, {id:'T-invalid'}];
  page.controller.setRecords(records);
  for (const record of records) {
    const row = page.rows.children.find(item => item.dataset.pcnId === record.id);
    const identity = row.children.find(item => item.dataset.column === 'id').children[0];
    assert.equal(identity.children[0].tag, 'a'); assert.equal(identity.children[0].textContent, record.id);
    assert.equal(identity.children[0].href, `/view/${record.id}?readonly=1`);
    const badges = identity.children.filter(item => item.className?.includes('rd-type-badge'));
    const type = require('../pcn-types').typeOf(record);
    assert.equal(badges.length, type ? 1 : 0);
    if (type) { assert.equal(badges[0].textContent, type.toUpperCase()); assert.equal(badges[0].attributes['aria-label'], `PCN type ${type.toUpperCase()}`); }
    assert.equal(identity.children.at(-1).textContent, 'Open PCN');
    assert.equal(identity.children.at(-1).href, `/view/${record.id}?readonly=1`);
  }
});

test('compact rows retain full supplier, material and responsible text for tooltips and CSV', () => {
  const page = controllerPage(async () => ({}));
  const supplier = 'Supplier <img src=x> with a long unabridged organization name';
  const material = 'Material with a long complete specification and original designation';
  const next = 'QA/TET — Prepare a long detailed review action'; const person = 'A long reviewer display name';
  const record = {id:'T-23112601',supplierName:supplier,materialName:material,status:'qa_review',dashboard:{action:{label:next,people:[{displayName:person}]}}};
  page.controller.setRecords([record]); const row = page.rows.children[0];
  for (const [key, value] of [['supplierName',supplier],['materialName',material]]) {
    const cell = row.children.find(item => item.dataset.column === key);
    assert.equal(cell.title, value); assert.equal(cell.children[0].textContent, value); assert.equal(cell.children[0].title, value);
  }
  const responsible = row.children.find(item => item.dataset.column === 'next');
  assert.equal(responsible.children[0].title, next); assert.equal(responsible.children[1].title, person);
  const status = row.children.find(item => item.dataset.column === 'status').children[0]; assert.equal(status.textContent, 'QA Review');
  const csv = dashboard().exportCsv([record], ['supplierName','materialName','next']);
  assert.ok(csv.includes(supplier)); assert.ok(csv.includes(material)); assert.ok(csv.includes(person));
});

test('overflow actions pause refresh, close safely and never select their row', async () => {
  let removed = false; let selected = 0; let invalidations = 0; let page;
  page = controllerPage(async () => ({}), { onRowSelect() { selected++; }, onOpen() { invalidations++; }, actions() {
    const remove = page.createElement('button'); remove.textContent = 'Remove'; remove.dataset.rdOverflow = 'true';
    remove.addEventListener('click', () => { removed = true; }); return [remove];
  } });
  page.controller.setRecords([{ id: 'PCN-1' }]);
  const more = page.rows.querySelectorAll().find(item => item.tag === 'details');
  assert.ok(more, 'destructive actions live inside a disclosure');
  const summary = more.children[0];
  assert.equal(summary.title, 'More actions for PCN-1');
  assert.match(summary.innerHTML, /<svg/);
  assert.equal(summary.attributes['aria-label'], 'More actions for PCN-1');
  await summary.emit('click'); more.open = true; await more.emit('toggle');
  assert.ok(invalidations > 0); assert.equal(page.controller.canRefresh(), false);
  await page.rows.children[0].emit('click', { target: summary }); assert.equal(selected, 0);
  await more.emit('keydown', { key: 'Escape', stopPropagation() {} });
  assert.equal(more.open, false); assert.equal(page.document.activeElement, summary);
  more.open = true;
  await more.emit('focusout', { relatedTarget: page.root });
  assert.equal(more.open, false);
  more.open = true;
  page.document.events.click({ target: page.root });
  assert.equal(more.open, false);
  more.open = true;
  const remove = page.button('Remove');
  await more.emit('click', { target: remove });
  await remove.emit('click');
  assert.equal(more.open, false); assert.equal(removed, true);
  assert.equal(page.controller.canRefresh(), true);
});


test('Open uses the original route once without resolving it through the code anchor URL property', () => {
  let hrefCalls = 0;
  const page = controllerPage(async () => ({}), { resolveLinks: true, codeHref(record) { hrefCalls++; return `/document/${record.id}?readonly=1`; } });
  page.controller.setRecords([{ id: 'PCN-1' }]);
  const links = page.rows.querySelectorAll().filter(item => item.tag === 'a');
  assert.equal(hrefCalls, 1);
  assert.equal(links[0].getAttribute('href'), '/document/PCN-1?readonly=1');
  assert.equal(links[1].getAttribute('href'), links[0].getAttribute('href'));
  const quickView = page.button('Quick view');
  assert.equal(quickView.title, 'Quick view PCN-1');
  assert.match(quickView.innerHTML, /<svg/);
});


test('Quick view timeline reads a coherent department snapshot and keeps revision history secondary', async () => {
  const calls = [];
  const snapshot = { id: 'PCN-1', version: 'fresh', status: 'qa_review', stages: [{ key: 'qaTet', label: 'QA/TET', completed: 1, total: 3, state: 'current', currentStep: 'Checked', steps: [
    { action: 'prepared', label: 'Prepared', completed: true, person: 'Actual preparer', signedAt: '2026-10-15' },
    { action: 'checked', label: 'Checked', completed: false, person: null, signedAt: null },
    { action: 'approved', label: 'Approved', completed: false, person: null, signedAt: null }] }], nextAction: { stage: 'qaTet', signingStep: 'checked', label: 'QA/TET \u2014 Checked', terminal: false } };
  const page = controllerPage(async url => { calls.push(url); return url.endsWith('/workflow-summary') ? snapshot : url.endsWith('/progress') ? { steps: [] } : { id: 'PCN-1', version: 'stale' }; });
  page.controller.setRecords([{ id: 'PCN-1', version: 'stale' }]); await page.button('Quick view').emit('click');
  await page.find('rdPreviewTab-timeline').emit('click'); await settle();
  assert.equal(calls.at(-1), '/api/pcns/PCN-1/workflow-summary');
  assert.equal(calls.some(url => url.endsWith('/revisions')), false);
  const content = page.find('rdPreviewContent');
  const text = content.querySelectorAll().map(item => item.textContent).join(' ');
  assert.match(text, /QA\/TET/); assert.match(text, /1\/3 signed/); assert.match(text, /Waiting for Checked/);
  assert.match(text, /Actual preparer/); assert.match(text, /2026-10-15/);
  assert.equal(content.querySelectorAll().filter(item => item.dataset.workflowStage).length, 1);
});


test('department markers and saved placeholders use their real symbols and partial waiting is honest', async () => {
  const api = dashboard();
  assert.equal(api.workflowStageCaption({ state: 'waiting', completed: 1 }), 'Waiting for earlier departments');
  assert.equal(api.workflowStageCaption({ state: 'waiting', completed: 0 }), 'Not started');
  const counts = [3, 1, 1, 1];
  const snapshot = { id: 'PCN-1', version: 'latest', status: 'submitted', nextAction: { label: 'Current review', terminal: false },
    stages: ['completed', 'current', 'waiting', 'stopped'].map((state, index) => ({ key: state, label: state, state, completed: counts[index], total: 3, currentStep: state === 'current' ? 'Checked' : null,
      steps: ['prepared', 'checked', 'approved'].map((action, position) => ({ action, label: action[0].toUpperCase() + action.slice(1), completed: position < counts[index], person: position < counts[index] ? 'Signer' : null, signedAt: position < counts[index] ? '2026-10-15' : null })) })) };
  const page = controllerPage(async url => url.endsWith('/workflow-summary') ? snapshot : url.endsWith('/progress') ? { steps: [] } : { id: 'PCN-1', version: 'latest' });
  page.controller.setRecords([{ id: 'PCN-1' }]); await page.button('Quick view').emit('click');
  await page.find('rdPreviewTab-timeline').emit('click'); await settle();
  const descendants = page.find('rdPreviewContent').querySelectorAll();
  const markers = descendants.filter(item => item.className === 'rd-timeline-point').map(item => item.textContent);
  assert.deepEqual(markers, ['\u2713', '\u2022', '\u25cb', '\u25cb']);
  assert.ok(descendants.some(item => item.textContent === 'current \u00b7 1/3 signed'));
  assert.ok(descendants.some(item => item.tag === 'td' && item.textContent === '\u2014'));
  assert.equal(descendants.some(item => item.textContent === '?'), false);
});

test('department timeline shows current Prod.Eng/TET deadline in red and preserves keyboard department selection', async () => {
  const deadline = prodEngRecord({ overdue: true }).dashboard.pending.prodEngDeadline;
  const snapshot = { id: 'PCN-DUE', version: 1, status: 'technical_review', nextAction: { label: 'Prod.Eng/TET — Checked', terminal: false },
    stages: ['prodEngTet', 'qaTet'].map((key, index) => ({ key, label: index ? 'QA/TET' : 'Prod.Eng/TET', state: index ? 'waiting' : 'current', completed: 0, total: 3,
      currentStep: index ? null : 'Prepared', deadline: index ? null : deadline,
      steps: ['prepared', 'checked', 'approved'].map(action => ({ action, label: action[0].toUpperCase() + action.slice(1), completed: false, person: null, signedAt: null })) })) };
  const page = controllerPage(async url => url.endsWith('/workflow-summary') ? snapshot : url.endsWith('/progress') ? { steps: [] } : prodEngRecord());
  page.controller.setRecords([prodEngRecord()]); await page.button('Quick view').emit('click');
  await page.find('rdPreviewTab-timeline').emit('click'); await settle();
  const expected = `Prod.Eng/TET due ${new Date(deadline.dueAt).toLocaleString()} (overdue)`;
  const content = page.find('rdPreviewContent'); const details = page.find('rdWorkflowDetails');
  const point = content.querySelectorAll().find(item => item.dataset.workflowStage === 'prodEngTet');
  assert.ok(point.children.some(item => item.textContent === expected && item.className.includes('rd-overdue')));
  assert.ok(details.children.some(item => item.textContent === expected && item.className === 'rd-overdue'));
  const track = content.querySelectorAll().find(item => item.attributes['aria-label'] === 'Signing departments');
  await track.emit('keydown', { key: 'ArrowRight' });
  assert.equal(page.document.activeElement.dataset.workflowStage, 'qaTet');
  assert.equal(details.querySelectorAll().some(item => item.textContent === expected), false);
  await track.emit('keydown', { key: 'Home' });
  assert.equal(page.document.activeElement, point);
  assert.ok(details.querySelectorAll().some(item => item.textContent === expected));
});
