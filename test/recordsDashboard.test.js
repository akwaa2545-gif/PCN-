const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function dashboard() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../records.js'), 'utf8'), {
    window, document: { addEventListener() {} }, Date, Intl, Blob, URL, setTimeout, clearTimeout,
  });
  return window.PCN_RECORDS_DASHBOARD;
}

const records = [
  { id: 'PCN-2026-0001', status: 'submitted', riskLevel: 'High', supplierName: 'A', updatedAt: '2026-10-14T10:00:00Z', dashboard: { action: { department: 'qaTet', label: 'QA/TET — Checked', people: [{displayName:'Jane'}] }, pending:{needsAttention:true} } },
  { id: 'PCN-2026-0002', status: 'approved', riskLevel: 'Low', supplierName: 'B', updatedAt: '2026-10-13T10:00:00Z', dashboard: { action: {terminal:true}, pending:{needsAttention:false} } },
];

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
  assert.equal(api.pendingLabel({ updatedAt: '2026-10-12T00:00:00Z' }, Date.parse('2026-10-14T00:00:00Z')), 'Updated 2 days ago');
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
  assert.equal(points[0].label, 'GSC/TET â€” Checked'); assert.equal(points[0].person, 'Alice');
  assert.equal(api.timelinePoints([{ revision: 1, isBaseline: true }])[0].label, 'History baseline');
});


