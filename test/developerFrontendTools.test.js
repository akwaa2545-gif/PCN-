'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../developer.js');

test('Developer tools require an active exclusive Developer assignment', () => {
  const user = { isActive: true, roles: ['developer'], department: 'developer', signingStep: null };
  assert.equal(tools.isDeveloper(user), true);
  for (const change of [{ isActive: false }, { roles: ['admin'] }, { roles: ['developer', 'admin'] }, { department: 'it' }, { signingStep: 'prepared' }, { isActive: undefined }]) {
    assert.equal(tools.isDeveloper({ ...user, ...change }), false);
  }
  assert.equal(tools.isDeveloper(null), false);
});

test('PCN deep links accept one canonical ID only', () => {
  assert.equal(tools.requestedPcn('?pcn=PCN-2026-0002'), 'PCN-2026-0002');
  for (const query of ['?pcn=bad', '?pcn=PCN-2026-0002&pcn=PCN-2026-0003', '', '?pcn=%3Cscript%3E']) assert.equal(tools.requestedPcn(query), '');
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
