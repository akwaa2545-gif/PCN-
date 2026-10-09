const test = require('node:test');
const assert = require('node:assert/strict');
const { SqlRevisions } = require('../src/sqlRevisions');
function source(responses) {
  const calls = [];
  return { calls, request() { const args = {}; return { input(name, type, value) { args[name] = value; return this; }, async query(query) { calls.push({ args, query }); return responses.shift() || { recordset: [] }; } }; } };
}
test('first changed save captures real legacy baseline and next revision atomically', async () => {
  const tx = source([{ recordset: [{ Revision: 0 }] }, { recordset: [] }, { recordset: [] }]);
  await new SqlRevisions().append(tx, 'PCN-2026-0001', { supplierName: 'Before' }, { supplierName: 'After', documentControl: { contentRevision: 2 } }, 'admin');
  assert.equal(tx.calls.length, 3);
  assert.equal(tx.calls[1].args.revision, 1);
  assert.equal(tx.calls[1].args.actor, 'Legacy baseline');
  assert.equal(tx.calls[2].args.revision, 2);
  assert.equal(JSON.parse(tx.calls[1].args.snapshot).supplierName, 'Before');
});
test('create records one immutable revision and removes transient notification', async () => {
  const tx = source([{ recordset: [{ Revision: 0 }] }, { recordset: [] }]);
  await new SqlRevisions().append(tx, 'PCN-2026-0001', null, { status: 'draft', notification: { secret: 'transient' } }, 'admin');
  assert.equal(tx.calls.length, 2);
  assert.equal(JSON.parse(tx.calls[1].args.snapshot).notification, undefined);
});
test('list excludes snapshots while detail exposes parsed snapshot', async () => {
  const row = { Revision: 1, ContentRevision: 1, Actor: 'admin', CreatedAt: new Date('2026-10-09'), Status: 'draft', ChangesJson: '[]', SnapshotJson: '{"reason":"Saved"}' };
  const list = await new SqlRevisions().list(source([{ recordset: [row] }]), 'PCN-2026-0001');
  assert.equal(list[0].snapshot, undefined);
  const detail = await new SqlRevisions().get(source([{ recordset: [row] }]), 'PCN-2026-0001', 1);
  assert.equal(detail.snapshot.reason, 'Saved');
});
