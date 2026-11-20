const test = require('node:test');
const assert = require('node:assert/strict');
const { PcnService } = require('../src/pcnService');
const { SqlPcnRepository } = require('../src/sqlPcnRepository');
const { memoryRepository, unsignedPayload } = require('./helpers/apiHarness');
const { splitRecord, hydratePcn } = require('../src/sqlPcnHydration');
const fs = require('node:fs');
const admin = { id: 'admin', isActive: true, roles: ['admin'] };
const payload = type => ({ ...unsignedPayload, documentType: type, status: 'draft' });

test('new PCNs require a type and issue separate Bangkok daily codes at creation', async () => {
  const repository = memoryRepository();
  let now = '2026-11-18T16:59:59Z';
  const service = new PcnService(repository, () => new Date(now));
  await assert.rejects(service.create({ ...payload('ta'), documentType: undefined }, 'Tester', admin), { statusCode: 400 });
  await assert.rejects(service.create(payload('other'), 'Tester', admin), { statusCode: 400 });
  assert.equal((await service.create(payload('ta'), 'Tester', admin)).id, 'T-18112601');
  assert.equal((await service.create(payload('TA'), 'Tester', admin)).id, 'T-18112602');
  assert.equal((await service.create(payload('sc'), 'Tester', admin)).id, 'S-18112601');
  now = '2026-11-18T17:00:00Z';
  assert.equal((await service.create(payload('ta'), 'Tester', admin)).id, 'T-19112601');
});

test('type remains immutable after issuance, ordinary saves preserve it and old documents stay readable', async () => {
  const repository = memoryRepository();
  const service = new PcnService(repository, () => new Date('2026-11-19T00:00:00Z'));
  const created = await service.create(payload('ta'), 'Tester', admin);
  const updated = await service.update(created.id, { version: created.version, reason: 'Changed' }, 'Tester', admin);
  assert.equal(updated.documentType, 'ta');
  assert.equal(updated.id, created.id);
  await assert.rejects(service.update(updated.id, { version: updated.version, documentType: 'sc' }, 'Tester', admin), { statusCode: 400 });
  const { documentType: omitted, ...legacyPayload } = payload('ta');
  const legacy = await repository.create({ ...legacyPayload, createdAt: '2026-01-01T00:00:00Z' });
  assert.equal((await service.getById(legacy.id, admin)).id, legacy.id);
  await assert.rejects(service.update(legacy.id, { version: legacy.version, documentType: 'ta' }, 'Tester', admin), { statusCode: 400 });
});

test('creation retries reuse a number, incompatible type retries fail and deletion does not recycle numbers', async () => {
  const repository = memoryRepository();
  const service = new PcnService(repository, () => new Date('2026-11-19T00:00:00Z'));
  const options = { clientDraftKey: '11111111-1111-4111-8111-111111111111' };
  const first = await service.create(payload('ta'), 'Tester', admin, options);
  const retried = await service.create(payload('ta'), 'Tester', admin, options);
  assert.equal(retried.id, first.id);
  await assert.rejects(service.create(payload('sc'), 'Tester', admin, options), { statusCode: 409 });
  await repository.delete(first.id, 'Tester', first.version);
  assert.equal((await service.create(payload('ta'), 'Tester', admin)).id, 'T-19112602');
});

test('typed daily sequence ends at 99 without wrapping or consuming the other series', async () => {
  const repository = memoryRepository();
  const service = new PcnService(repository, () => new Date('2026-11-19T00:00:00Z'));
  let last;
  for (let n = 0; n < 99; n++) last = await service.create(payload('ta'), 'Tester', admin);
  assert.equal(last.id, 'T-19112699');
  await assert.rejects(service.create(payload('ta'), 'Tester', admin), { statusCode: 409 });
  assert.equal((await service.create(payload('sc'), 'Tester', admin)).id, 'S-19112601');
});

function counterSource(result) {
  const calls = [];
  return { calls, request() { const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; }, async query(statement) {
    calls.push({ statement, inputs }); if (result instanceof Error) throw result; return result;
  } }; } };
}
test('SQL daily counter is parameterized, bounded and reports missing migration clearly', async () => {
  const repository = new SqlPcnRepository({});
  const tx = counterSource({ recordset: [{ Sequence: 3 }] });
  assert.equal(await repository.allocateTypedCode(tx, { documentType: 'sc', createdAt: '2026-11-18T17:00:00Z' }), 'S-19112603');
  assert.equal(tx.calls[0].inputs.documentType, 'sc');
  assert.equal(tx.calls[0].inputs.issueDate, '2026-11-19');
  assert.match(tx.calls[0].statement, /UPDLOCK,HOLDLOCK/);
  assert.match(tx.calls[0].statement, /LastSequence\s*<\s*99/);
  await assert.rejects(repository.allocateTypedCode(counterSource({ recordset: [] }), payload('ta')), { statusCode: 409 });
  const missing = Object.assign(new Error('missing'), { number: 208 });
  await assert.rejects(repository.allocateTypedCode(counterSource(missing), { documentType: 'ta', createdAt: '2026-11-19T00:00:00Z' }), { statusCode: 503 });
});

test('typed creation keeps allocation after the global transaction lock and rolls back a failed parent write', async () => {
  const calls = [];
  const tx = { async begin() { calls.push('begin'); }, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); }, request() {
    const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; }, async query(statement) {
      calls.push({ statement, inputs });
      if (statement.includes('sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
      if (statement.includes('PcnDailyCounters')) return { recordset: [{ Sequence: 1 }] };
      throw new Error('Unexpected query');
    } };
  } };
  const repository = new SqlPcnRepository({ transaction: () => tx });
  repository.writeParent = async (source, record) => {
    assert.equal(record.id, 'T-19112601');
    assert.equal(record.internalReview.pcnCode, record.id);
    throw new Error('Parent write failed');
  };
  await assert.rejects(repository.create({ ...payload('ta'), createdAt: '2026-11-19T00:00:00Z' }, 'Tester'), /Parent write failed/);
  const gate = calls.findIndex(call => call.inputs?.resource === 'pcn:creation-global');
  const allocation = calls.findIndex(call => call.statement?.includes('PcnDailyCounters'));
  assert(gate > 0 && allocation > gate);
  assert.equal(calls.at(-1), 'rollback');
  assert(!calls.includes('commit'));
});

test('SQL creation replay of an issued typed draft returns before allocation and rejects another type', async () => {
  const draftKey = '11111111-1111-4111-8111-111111111111';
  const saved = { id: 'T-19112601', documentType: 'ta', ownerUserId: 'owner', status: 'draft' };
  const repository = new SqlPcnRepository({ transaction() { return { async begin() {}, async commit() {}, async rollback() {}, request() {
    return { input() { return this; }, async query(statement) {
      if (statement.includes('sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
      if (statement.includes('OwnerUserId')) return { recordset: [{ LegacyExtrasJson: JSON.stringify({ creationDraftKey: draftKey }), PcnCode: saved.id }] };
      throw new Error('Replay must not allocate or write');
    } };
  } }; } });
  repository.readAggregate = async () => saved;
  assert.equal((await repository.create({ documentType: 'ta', ownerUserId: 'owner', status: 'draft' }, 'Tester', undefined, { clientDraftKey: draftKey })).id, saved.id);
  await assert.rejects(repository.create({ documentType: 'sc', ownerUserId: 'owner', status: 'draft' }, 'Tester', undefined, { clientDraftKey: draftKey }), { statusCode: 409 });
});

test('type survives SQL aggregate hydration without changing legacy scalar/storage fields', () => {
  const value = { id: 'T-19112601', documentType: 'ta', status: 'draft', internalReview: { pcnCode: 'T-19112601' } };
  const split = splitRecord(value);
  assert.equal(JSON.parse(split.parent.LegacyExtrasJson).documentType, 'ta');
  assert.deepEqual(hydratePcn({ ...split.parent, PcnCode: value.id, RowVersion: '0000000000000001' }, split.review, split.children), { ...value, version: '0000000000000001' });
});

test('migration is additive counter setup and explicit signing-department expansion without historical or grant writes', () => {
  const migration = fs.readFileSync(require('node:path').join(__dirname, '../sql/migrations/009_pcn_document_types.sql'), 'utf8');
  assert.match(migration, /PRIMARY KEY \(DocumentType,IssueDate\)/);
  assert.match(migration, /LastSequence BETWEEN 0 AND 99/);
  assert.match(migration, /WITH CHECK ADD CONSTRAINT CK_Users_SigningDepartment/);
  assert.match(migration, /N'prodEngTa',N'prodEngSc'/);
  assert.doesNotMatch(migration, /UPDATE\s+pcn\.(PcnRequests|Users)|INSERT\s+(?:INTO\s+)?pcn\.UserRoles|\bGO\b/i);
});
