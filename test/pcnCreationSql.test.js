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
      if (statement.includes('PcnRequests') && statement.includes('OwnerUserId')) return { recordset: rows };
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

test('SQL submission receipt scopes safe status aggregates to the exact PCN version and excludes update batches', async () => {
  const calls = [];
  const pool = { request() { const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; }, async query(statement) { calls.push({ statement, inputs }); return { recordset: [{ Status: 'sent', JobCount: 1 }] }; } }; } };
  const repository = new SqlPcnRepository(pool);
  assert.deepEqual(await repository.getNotificationStatus('PCN-2026-0001', '00000000000000ab'), [{ Status: 'sent', JobCount: 1 }]);
  assert.deepEqual(calls[0].inputs, { code: 'PCN-2026-0001', version: '00000000000000ab' });
  assert.match(calls[0].statement, /PcnId=@code AND PcnVersion=@version/);
  assert.match(calls[0].statement, /Action<>N'pcn_update'/);
  assert.doesNotMatch(calls[0].statement, /Recipient|PayloadJson|LastError|SELECT\s+\*/i);
  await assert.rejects(repository.getNotificationStatus('PCN-2026-0001', "bad'"), { statusCode: 400 });
});

test('concurrent first-save retries allocate one SQL identity and append history once', async () => {
  const rows = []; const locks = new Map(); let allocations = 0; let audits = 0; let revisions = 0;
  const pool = { transaction() {
    let unlock;
    return { async begin() {}, async commit() { unlock?.(); }, async rollback() { unlock?.(); }, request() {
      const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; }, async query(statement) {
        if (statement.includes('sp_getapplock')) {
          if (inputs.resource.startsWith('pcn:creation:')) {
            const previous = locks.get(inputs.resource) || Promise.resolve();
            const current = new Promise(resolve => { unlock = resolve; });
            locks.set(inputs.resource, current); await previous;
          }
          return { recordset: [{ LockResult: 0 }] };
        }
        if (statement.includes('OwnerUserId')) return { recordset: rows };
        throw new Error('Unexpected SQL in isolated concurrent adapter');
      } };
    } };
  } };
  const repository = new SqlPcnRepository(pool);
  repository.allocateCode = async () => `PCN-2026-${String(++allocations).padStart(4, '0')}`;
  repository.writeParent = async (tx, record) => { const row = { PcnCode: record.id, LegacyExtrasJson: JSON.stringify({ creationDraftKey: record.creationDraftKey }), record }; rows.push(row); return row; };
  repository.writeChildren = async () => {};
  repository.audit = async () => { audits += 1; };
  repository.readAggregate = async (tx, row) => ({ ...row.record, version: '0000000000000001' });
  repository.revisions.append = async () => { revisions += 1; };
  const make = () => repository.create({ ownerUserId: 'owner', status: 'draft', createdAt: '2026-10-15T00:00:00Z' }, 'actor', undefined, { clientDraftKey: key });
  const [first, retry] = await Promise.all([make(), make()]);
  assert.equal(first.id, retry.id); assert.equal(retry.creationReused, true);
  assert.equal(allocations, 1); assert.equal(audits, 1); assert.equal(revisions, 1);
});

test('normal and keyed creation take the same transaction gate before replay scans or counter allocation', async () => {
  for (const options of [{}, { clientDraftKey: key }]) {
    const { repository, calls } = setup([]);
    repository.allocateCode = async () => {
      const gate = calls.findIndex(call => call.inputs?.resource === 'pcn:creation-global');
      assert.ok(gate >= 0, 'Global creation gate must precede annual counter allocation');
      const routing = calls.findIndex(call => call.inputs?.resource === 'pcn:user-mail-routing');
      assert.ok(routing < gate, 'Routing lock must precede creation gate');
      const scan = calls.findIndex(call => call.inputs?.owner === 'owner');
      if (options.clientDraftKey) assert.ok(scan > gate, 'Global creation gate must precede owner replay scan');
      assert.match(calls[gate].statement, /LockMode=N'Exclusive'/);
      assert.match(calls[gate].statement, /LockOwner=N'Transaction'/);
      assert.match(calls[gate].statement, /LockTimeout=10000/);
      throw new Error('Reached safe allocation boundary');
    };
    await assert.rejects(repository.create({ ownerUserId: 'owner', status: 'draft' }, 'actor', undefined, options), /Reached safe allocation boundary/);
  }
});

test('failed or missing creation lock results roll back before replay or allocation', async () => {
  for (const failedResource of ['pcn:creation-global', 'owner-key']) {
    for (const result of [[], [{ LockResult: -1 }]]) {
      let rolledBack = false; let touchedRecords = false;
      const tx = { async begin() {}, async commit() { assert.fail('Failed lock must not commit'); }, async rollback() { rolledBack = true; }, request() {
        const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; }, async query(statement) {
          const target = failedResource === 'owner-key' ? inputs.resource?.startsWith('pcn:creation:') : inputs.resource === failedResource;
          if (statement.includes('sp_getapplock')) return { recordset: target ? result : [{ LockResult: 0 }] };
          touchedRecords = true; throw new Error('Failed lock must not reach owner rows');
        } };
      } };
      const repository = new SqlPcnRepository({ transaction: () => tx });
      repository.allocateCode = async () => { touchedRecords = true; throw new Error('Failed lock must not allocate'); };
      await assert.rejects(repository.create({ ownerUserId: 'owner', status: 'draft' }, 'actor', undefined,
        failedResource === 'owner-key' ? { clientDraftKey: key } : {}), { statusCode: 409 });
      assert.equal(rolledBack, true); assert.equal(touchedRecords, false);
    }
  }
});
