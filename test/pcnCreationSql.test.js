const test = require('node:test');
const assert = require('node:assert/strict');
const { SqlPcnRepository } = require('../src/sqlPcnRepository');
const key = '50000000-0000-4000-8000-000000000001';
function setup(rows) {
  const calls = [];
  const tx = { async begin() {}, async commit() {}, async rollback() {}, request() {
    const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; }, async query(statement) {
      calls.push({ statement, inputs });
      if (statement.includes('sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
      if (statement.includes('LegacyExtrasJson') && statement.includes('OwnerUserId')) return { recordset: rows };
      return { recordset: [] };
    } };
  } };
  const repository = new SqlPcnRepository({ transaction: () => tx });
  repository.allocateCode = async () => { calls.push('allocate'); throw new Error('Should reuse before allocation'); };
  repository.readAggregate = async (source, row) => ({ id: row.PcnCode, status: row.Status, version: '0000000000000001' });
  return { repository, calls };
}
test('SQL draft creation replay locks owner and key, searches all statuses, and returns canonical submitted record without writes', async () => {
  const { repository, calls } = setup([{ PcnCode: 'PCN-2026-0001', Status: 'submitted', LegacyExtrasJson: JSON.stringify({ creationDraftKey: key }) }]);
  const saved = await repository.create({ ownerUserId: 'owner', status: 'draft' }, 'actor', undefined, { clientDraftKey: key });
  assert.equal(saved.id, 'PCN-2026-0001'); assert.equal(saved.creationReused, true);
  const ownerLock = calls.find(call => call.inputs?.resource?.startsWith('pcn:creation:'));
  assert.ok(ownerLock); assert.match(ownerLock.statement, /sp_getapplock/);
  const lookup = calls.find(call => call.inputs?.owner === 'owner');
  assert.ok(lookup); assert.doesNotMatch(lookup.statement, /Status\s*=|DeletedAt IS NULL|JSON_VALUE|OPENJSON/i);
  assert.equal(calls.includes('allocate'), false);
});
test('SQL draft replay never resurrects a deleted matching record', async () => {
  const { repository } = setup([{ PcnCode: 'PCN-2026-0001', DeletedAt: new Date(), LegacyExtrasJson: JSON.stringify({ creationDraftKey: key }) }]);
  await assert.rejects(repository.create({ ownerUserId: 'owner', status: 'draft' }, 'actor', undefined, { clientDraftKey: key }), { statusCode: 409 });
});
