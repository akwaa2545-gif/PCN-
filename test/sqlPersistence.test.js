const test = require('node:test');
const assert = require('node:assert/strict');
const { getSqlConfig } = require('../src/sqlConfig');
const { hydratePcn, splitRecord, versionHex } = require('../src/sqlPcnHydration');
const { SqlPcnRepository } = require('../src/sqlPcnRepository');
const { migrationManifest, applyMigrations } = require('../src/sqlDatabase');
const fs = require('node:fs');
const path = require('node:path');

test('SQL config requires secrets and uses finite limits and verified TLS', () => {
  assert.throws(() => getSqlConfig({}), /SQL_USER/);
  const config = getSqlConfig({ SQL_USER: 'test', SQL_PASSWORD: 'secret' });
  assert.equal(config.server, 'svr120a');
  assert.equal(config.database, 'Scn_DB');
  assert.equal(config.options.encrypt, true);
  assert.equal(config.options.trustServerCertificate, false);
  assert.equal(config.requestTimeout, 30000);
  assert.throws(() => getSqlConfig({ SQL_USER: 'test', SQL_PASSWORD: 'secret', SQL_PORT: 'abc' }), /SQL_PORT/);
  assert.throws(() => getSqlConfig({ SQL_USER: 'test', SQL_PASSWORD: 'secret', SQL_TRUST_SERVER_CERTIFICATE: 'yes' }), /SQL_TRUST_SERVER_CERTIFICATE/);
  assert.equal(getSqlConfig({ SQL_USER: 'test', SQL_PASSWORD: 'secret', SQL_TRUST_SERVER_CERTIFICATE: 'true' }).options.trustServerCertificate, true);
});

test('normalized aggregate round trip preserves workbook review, arbitrary child fields and Unicode', () => {
  const original = { id: 'PCN-2026-0001', supplierName: 'ผู้ผลิต', status: 'draft', createdAt: '2026-10-05T00:00:00.000Z',
    ownerUserId: '123', internalReview: { qateFinal: { signoff: { approvedDate: 'lot A', prepared: true } }, extra: { flag: true } },
    documents: [{ name: 'Report', required: false, uploaded: true, custom: 'retained' }],
    changeRows: [{ risk: 'RL2', text: 'test', originalText: 'original', more: 2 }], route: ['QA'],
    comments: [{ id: 'legacy-text', comment: 'x' }], approvals: [{ id: 'other', decision: 'hold' }], legacyField: true };
  const split = splitRecord(original);
  const hydrated = hydratePcn({ ...split.parent, PcnCode: original.id, RowVersion: Buffer.from('00000000000000ab', 'hex') },
    split.review, split.children);
  assert.deepEqual(hydrated, { ...original, version: '00000000000000ab' });
  assert.equal(versionHex(Buffer.from('00000000000000ab', 'hex')), '00000000000000ab');
  const nulls = splitRecord({ id: 'PCN-2026-0002', internalReview: null, documents: null });
  assert.deepEqual(hydratePcn({ ...nulls.parent, PcnCode: 'PCN-2026-0002', RowVersion: Buffer.from('0000000000000001', 'hex') }, nulls.review, nulls.children),
    { id: 'PCN-2026-0002', internalReview: null, documents: null, version: '0000000000000001' });
});

function mockPool(results) {
  const calls = [];
  const transaction = { begin: async () => calls.push('begin'), commit: async () => calls.push('commit'), rollback: async () => calls.push('rollback'),
    request() { return request(); } };
  function request() { const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; },
    async query(sql) { calls.push({ sql, inputs }); const next = results.shift(); if (next instanceof Error) throw next; return next || { recordset: [], rowsAffected: [1] }; } }; }
  return { calls, transaction: () => transaction, request };
}

test('routing saves compare the locked current version before writing groups or audit', async () => {
  const { settingsVersion } = require('../src/mailRouting');
  const previous = { groups: [{ key: 'signoff.gscTet', emails: 'original@example.com' }] };
  const next = { schemaVersion: 2, groups: [{ key: 'department.gscTet.approved', label: 'GSC/TET Approved', emails: 'new@example.com', recipients: [] }], legacyGroups: previous.groups };
  const stale = mockPool([{ recordset: [{ SettingsJson: JSON.stringify(previous) }] }]);
  await assert.rejects(new SqlPcnRepository(stale).saveNotificationSettings(next, 'admin', 'a'.repeat(64)), { statusCode: 409 });
  assert.equal(stale.calls.at(-1), 'rollback');
  assert.match(stale.calls[1].sql, /UPDLOCK,HOLDLOCK/);
  assert.equal(stale.calls.filter(call => call.sql).length, 1);
  const current = mockPool([{ recordset: [{ SettingsJson: JSON.stringify(previous) }] }]);
  assert.deepEqual(await new SqlPcnRepository(current).saveNotificationSettings(next, 'admin', settingsVersion(previous)), next);
  assert.equal(current.calls.at(-1), 'commit');
  const write = current.calls.find(call => call.inputs?.json);
  assert.deepEqual(JSON.parse(write.inputs.json).legacyGroups, previous.groups);
});

test('stale update rolls back before updater, children or audit writes', async () => {
  const pool = mockPool([{ recordset: [{ PcnId: 1, PcnCode: 'PCN-2026-0001', RowVersion: Buffer.from('0000000000000002', 'hex') }] }]);
  let invoked = false;
  await assert.rejects(new SqlPcnRepository(pool).update('PCN-2026-0001', () => { invoked = true; }, 'actor', '0000000000000001'), { statusCode: 409 });
  assert.equal(invoked, false);
  assert.equal(pool.calls.at(-1), 'rollback');
  assert.match(pool.calls[1].sql, /UPDLOCK, HOLDLOCK/);
});

test('list uses parameterized owner scope and hides deleted rows', async () => {
  const pool = mockPool([]);
  assert.deepEqual(await new SqlPcnRepository(pool).list({ ownerUserId: 'owner', status: "draft'; DROP TABLE x" }), []);
  assert.equal(pool.calls[0].inputs.owner, 'owner');
  assert.equal(pool.calls[0].inputs.status, "draft'; DROP TABLE x");
  assert.match(pool.calls[0].sql, /DeletedAt IS NULL/);
  assert.doesNotMatch(pool.calls[0].sql, /DROP TABLE/);
});

test('create rolls back atomic counter allocation when parent insert fails', async () => {
  const pool = mockPool([{ recordset: [{ Sequence: 1 }] }, new Error('insert failed')]);
  await assert.rejects(new SqlPcnRepository(pool).create({ createdAt: '2026-10-05T00:00:00.000Z', status: 'draft' }, 'actor'), /insert failed/);
  assert.equal(pool.calls.at(-1), 'rollback');
  assert.equal(pool.calls.includes('commit'), false);
  assert.match(pool.calls[1].sql, /UPDLOCK, HOLDLOCK/);
});

test('year counter refuses code overflow rather than creating an inaccessible code', async () => {
  const pool = mockPool([{ recordset: [{ Sequence: 10000 }] }]);
  await assert.rejects(new SqlPcnRepository(pool).create({ createdAt: '2026-10-05T00:00:00.000Z' }), { statusCode: 409 });
  assert.equal(pool.calls.at(-1), 'rollback');
});

test('readiness rejects unapplied migration and missing seeded master data', async () => {
  const pool = mockPool([{ recordsets: [[], [], []] }]);
  await assert.rejects(new SqlPcnRepository(pool).readiness(), { statusCode: 503 });
  const ready = mockPool([{ recordsets: [migrationManifest.map(MigrationId => ({ MigrationId })), [{ Id: 1 }], [{ Id: 'admin' }], [{ TableCount: 21 }]] }]);
  assert.deepEqual(await new SqlPcnRepository(ready).readiness(), { ready: true, migrations: migrationManifest.length });
});

test('migration manifest contains repeatable normalized SQL and no embedded credentials', () => {
  assert.equal(new Set(migrationManifest).size, migrationManifest.length);
  const ddl = migrationManifest.map(file => fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', file), 'utf8')).join('\n');
  for (const table of ['Users', 'Roles', 'Sessions', 'AccountTokens', 'PcnRequests', 'PcnInternalReviews', 'PcnChangeRows', 'PcnDocuments', 'PcnRouteSteps', 'PcnComments', 'PcnApprovals', 'PcnCounters', 'AuditLogs', 'MasterDataVersions', 'NotificationJobs', 'PcnDocumentFiles']) {
    assert.ok(ddl.includes(`IF OBJECT_ID(N'pcn.${table}', N'U') IS NULL`));
  }
  assert.match(ddl, /RowVersion rowversion/);
  assert.match(ddl, /MustChangePassword bit/);
  assert.doesNotMatch(ddl, /Password\s*=|Scn_admin/);
});

test('SQL 2014 compatibility: schema and persistence never require native JSON functions', () => {
  const sources = [path.join(__dirname, '..', 'src', 'sqlPcnRepository.js'), ...migrationManifest.map(file => path.join(__dirname, '..', 'sql', 'migrations', file))];
  for (const source of sources) assert.doesNotMatch(fs.readFileSync(source, 'utf8'), /\b(?:ISJSON|OPENJSON|JSON_VALUE|JSON_QUERY|JSON_MODIFY)\s*\(/i, source);
});

test('SQL 2014 child inserts bind Unicode, full text, flags, ordering and raw provenance', async () => {
  const record = { internalReview: { docs: { otherRequirementNote: 'ไทย' } },
    changeRows: [{ risk: 'RL2', originalText: 'legacy label', text: 'ไทย'.repeat(3000), custom: true }],
    documents: [{ name: 'report', required: false, uploaded: true }, { name: 'optional', required: null, uploaded: false }],
    route: ['QA', { historic: true }], comments: [{ id: 'original', role: 'QA', comment: 'note', createdAt: 'legacy unknown date' }],
    approvals: [{ id: 'decision', role: 'QA', decision: 'hold', createdAt: '2026-10-05T00:00:00.000Z' }] };
  const pool = mockPool([]);
  const repository = new SqlPcnRepository(pool);
  await repository.transaction(tx => repository.writeChildren(tx, 42, record));
  const changes = pool.calls.find(call => call.sql?.includes('INSERT pcn.PcnChangeRows'));
  assert.equal(changes.inputs.v1, 'legacy label');
  assert.equal(changes.inputs.v2, record.changeRows[0].text);
  assert.deepEqual(JSON.parse(changes.inputs.payload), record.changeRows[0]);
  const docs = pool.calls.filter(call => call.sql?.includes('INSERT pcn.PcnDocuments'));
  assert.deepEqual(docs.map(call => [call.inputs.order, call.inputs.v1, call.inputs.v2]), [[0, false, true], [1, null, false]]);
  assert.equal(pool.calls.find(call => call.sql?.includes('INSERT pcn.PcnComments')).inputs.v3, null);
  assert.equal(pool.calls.find(call => call.sql?.includes('INSERT pcn.PcnApprovals')).inputs.v3.toISOString(), '2026-10-05T00:00:00.000Z');
  const opaqueRoute = pool.calls.filter(call => call.sql?.includes('INSERT pcn.PcnRouteSteps'))[1];
  assert.equal(opaqueRoute.inputs.v0, null);
  assert.deepEqual(JSON.parse(opaqueRoute.inputs.payload), { value: { historic: true } });
  assert.equal(pool.calls.at(-1), 'commit');
});

test('SQL 2014 per-row insert failure rolls back the complete aggregate', async () => {
  const pool = mockPool([undefined, undefined, new Error('child insert failed')]);
  const repository = new SqlPcnRepository(pool);
  await assert.rejects(repository.transaction(tx => repository.writeChildren(tx, 42, { changeRows: [{ text: 'new' }] })), /child insert failed/);
  assert.equal(pool.calls.at(-1), 'rollback');
  assert.equal(pool.calls.includes('commit'), false);
});

test('import never overwrites a previously imported changed source', async () => {
  const pool = mockPool([{ recordset: [{ SourceHash: 'old-hash' }] }]);
  await assert.rejects(new SqlPcnRepository(pool).importDatabase({ pcnRequests: { 'PCN-2026-0001': { id: 'PCN-2026-0001' } } }), /Imported source changed/);
  assert.equal(pool.calls.at(-1), 'rollback');
});

test('soft delete preserves children and audit writes within its transaction', async () => {
  const pool = mockPool([{ recordset: [{ PcnId: 12, RowVersion: Buffer.from('0000000000000001', 'hex') }] }]);
  assert.equal(await new SqlPcnRepository(pool).delete('PCN-2026-0001', 'user', '0000000000000001'), true);
  const statements = pool.calls.filter(call => typeof call === 'object').map(call => call.sql).join('\n');
  assert.match(statements, /SET DeletedAt=SYSUTCDATETIME/);
  assert.match(statements, /INSERT pcn.AuditLogs/);
  assert.doesNotMatch(statements, /DELETE pcn/);
  assert.equal(pool.calls.at(-1), 'commit');
});

function aggregateSets(record) {
  return { recordsets: [[{ ReviewJson: JSON.stringify(record.internalReview || {}) }], ...['changeRows', 'documents', 'route', 'comments', 'approvals'].map(key =>
    (record[key] || []).map(value => ({ PayloadJson: JSON.stringify(key === 'route' ? { value } : value) }))) ] };
}
function childWriteCount(record) {
  return 6 + ['changeRows', 'documents', 'route', 'comments', 'approvals'].reduce((total, key) => total + (record[key] || []).length, 0);
}

test('create atomically commits the complete workbook aggregate and returns its SQL version', async () => {
  const expected = { id: 'PCN-2026-0007', status: 'draft', createdAt: '2026-10-05T00:00:00.000Z',
    ownerUserId: 'user-id', internalReview: { docs: { supplierDocument: true }, pcnCode: 'PCN-2026-0007' },
    documents: [{ name: 'sheet', required: true, uploaded: false }], route: ['QA'], changeRows: [], comments: [], approvals: [] };
  const parent = { ...splitRecord(expected).parent, PcnId: 7, PcnCode: expected.id, RowVersion: Buffer.from('0000000000000007', 'hex') };
  const pool = mockPool([{ recordset: [{ Sequence: 7 }] }, { recordset: [parent] }, ...Array(childWriteCount(expected) + 1).fill(undefined), aggregateSets(expected)]);
  const { id, ...input } = expected;
  assert.deepEqual(await new SqlPcnRepository(pool).create(input, 'actor'), { ...expected, version: '0000000000000007' });
  assert.equal(pool.calls.at(-1), 'commit');
  assert.equal(pool.calls.filter(call => call.sql?.includes('INSERT pcn.AuditLogs')).length, 1);
  const documentWrite = pool.calls.find(call => call.sql?.includes('INSERT pcn.PcnDocuments'));
  assert.deepEqual(JSON.parse(documentWrite.inputs.payload), expected.documents[0]);
});

test('update locks and hydrates before updater; ownership and created timestamp remain immutable', async () => {
  const original = { id: 'PCN-2026-0001', ownerUserId: 'real-owner', createdAt: '2026-10-05T00:00:00.000Z', status: 'draft', internalReview: { pcnCode: 'PCN-2026-0001' }, documents: [] };
  const originalParent = { ...splitRecord(original).parent, PcnId: 1, PcnCode: original.id, RowVersion: Buffer.from('0000000000000001', 'hex') };
  const expected = { ...original, status: 'submitted' };
  const nextParent = { ...splitRecord(expected).parent, PcnId: 1, PcnCode: original.id, RowVersion: Buffer.from('0000000000000002', 'hex') };
  const pool = mockPool([{ recordset: [originalParent] }, aggregateSets(original), { recordset: [nextParent] }, ...Array(childWriteCount(expected) + 1).fill(undefined), aggregateSets(expected)]);
  const result = await new SqlPcnRepository(pool).update(original.id, current => ({ ...current, ownerUserId: 'forged', createdAt: '1990-01-01', status: 'submitted' }), 'reviewer', '0000000000000001');
  assert.deepEqual(result, { ...expected, version: '0000000000000002' });
  const write = pool.calls.find(call => call.sql?.startsWith('UPDATE pcn.PcnRequests SET'));
  assert.ok(Object.values(write.inputs).includes('real-owner'));
  assert.equal(Object.values(write.inputs).includes('forged'), false);
  assert.equal(pool.calls.at(-1), 'commit');
});

test('find returns full children with a consistent transaction and handles missing rows', async () => {
  const record = { id: 'PCN-2026-0001', status: 'submitted', internalReview: { supplierSignoff: { approved: { checked: true, date: '2026-10-01' } } },
    route: ['QA'], comments: [{ id: 'legacy', comment: '中文' }], approvals: [{ decision: 'hold' }], documents: [{ required: false, uploaded: true }], changeRows: [{ text: 'new' }] };
  const parent = { ...splitRecord(record).parent, PcnId: 1, PcnCode: record.id, RowVersion: Buffer.from('0000000000000002', 'hex') };
  assert.deepEqual(await new SqlPcnRepository(mockPool([{ recordset: [parent] }, aggregateSets(record)])).findById(record.id), { ...record, version: '0000000000000002' });
  assert.equal(await new SqlPcnRepository(mockPool([])).findById(record.id), null);
  assert.equal(await new SqlPcnRepository(mockPool([])).update(record.id, () => assert.fail()), null);
  assert.equal(await new SqlPcnRepository(mockPool([])).delete(record.id), false);
});

test('settings and master-data operations preserve profiles and require initialized SQL definitions', async () => {
  const settings = { flowUrl: '', directoryLookupUrl: '', groups: [{ key: 'qa', label: 'QA', emails: 'a@example.com', recipients: [{ email: 'a@example.com', displayName: 'QA Person' }] }] };
  const pool = mockPool([]);
  assert.deepEqual(await new SqlPcnRepository(pool).saveNotificationSettings(settings, 'admin'), settings);
  assert.ok(pool.calls.some(call => call.sql?.includes('INSERT pcn.NotificationRecipients')));
  assert.equal(pool.calls.at(-1), 'commit');
  assert.deepEqual(await new SqlPcnRepository(mockPool([{ recordset: [{ SettingsJson: JSON.stringify(settings) }] }])).getNotificationSettings(), settings);
  const empty = await new SqlPcnRepository(mockPool([])).getNotificationSettings();
  assert.equal(empty.groups.length, 7);
  assert.ok(empty.groups.every(group => group.emails === '' && group.recipients.length === 0));
  const definitions = { formDefinitions: { rawMaterial: {} }, commonDocuments: ['sheet'] };
  assert.deepEqual(await new SqlPcnRepository(mockPool([{ recordset: [{ Id: 3, DefinitionJson: JSON.stringify(definitions) }] }])).getMasterData(3), { ...definitions, versionId: 3 });
  await assert.rejects(new SqlPcnRepository(mockPool([])).getMasterData(), { statusCode: 503 });
  const seed = mockPool([{ recordset: [{ Id: 3 }] }]);
  assert.equal(await new SqlPcnRepository(seed).seedMasterData(definitions), 3);
  assert.match(seed.calls[1].sql, /UPDLOCK,HOLDLOCK/);
});

test('import idempotently preserves source records and raises counters above deleted audit targets', async () => {
  const record = { id: 'PCN-2026-0001', internalReview: {}, documents: [], createdAt: '2026-01-01T00:00:00.000Z' };
  const parent = { PcnId: 1, PcnCode: record.id };
  const event = { id: 'legacy-audit', pcnId: 'PCN-2026-0042', action: 'deleted', actor: 'legacy', metadata: {}, createdAt: '2026-02-01T00:00:00.000Z' };
  const pool = mockPool([undefined, undefined, { recordset: [parent] }]);
  assert.deepEqual(await new SqlPcnRepository(pool).importDatabase({ pcnRequests: { [record.id]: record }, auditLogs: [event] }), { imported: 1, skipped: 0, audits: 1 });
  assert.ok(pool.calls.some(call => call.inputs?.sequence === 42));
  assert.ok(pool.calls.some(call => call.sql?.includes('INSERT pcn.MigrationSourceRecords')));
  assert.ok(pool.calls.some(call => call.sql?.includes('Imported audit identity conflicts')));
  const checksum = require('node:crypto').createHash('sha256').update(JSON.stringify(record)).digest('hex');
  const repeat = mockPool([{ recordset: [{ SourceHash: checksum }] }]);
  assert.deepEqual(await new SqlPcnRepository(repeat).importDatabase({ pcnRequests: { [record.id]: record } }), { imported: 0, skipped: 1, audits: 0 });
  assert.equal(repeat.calls.some(call => call.sql?.includes('INSERT pcn.PcnRequests')), false);
});

test('migration administration serializes DDL, records checksum and refuses changed applied files', async () => {
  const checksum = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', migrationManifest[0]), 'utf8')).digest('hex');
  const initial = mockPool([]);
  await applyMigrations(initial);
  assert.ok(initial.calls.some(call => call.sql?.includes('sys.sp_getapplock')));
  assert.ok(initial.calls.some(call => call.sql?.includes('INSERT pcn.SchemaMigrations') && call.inputs.checksum === checksum));
  assert.equal(initial.calls.at(-1), 'commit');
  const repeat = mockPool([undefined, undefined, undefined, { recordset: [{ Checksum: checksum }] }]);
  await applyMigrations(repeat);
  assert.equal(repeat.calls.some(call => call.sql?.includes('CREATE TABLE pcn.Users')), false);
  const changed = mockPool([undefined, undefined, undefined, { recordset: [{ Checksum: 'different' }] }]);
  await assert.rejects(applyMigrations(changed), /Migration checksum changed/);
  assert.equal(changed.calls.at(-1), 'rollback');
});

test('audit reads keep original provenance and serialize new timestamps', async () => {
  const original = { id: 'old', pcnId: 'PCN-2026-0001', customProvenance: 'legacy' };
  const pool = mockPool([{ recordset: [{ SourceJson: JSON.stringify(original) }, { Id: 'new', PcnCode: 'PCN-2026-0001', Action: 'updated', Actor: 'admin', MetadataJson: '{"status":"draft"}', CreatedAt: new Date('2026-10-05T00:00:00.000Z') }] }]);
  assert.deepEqual(await new SqlPcnRepository(pool).getAudit('PCN-2026-0001'), [original, { id: 'new', pcnId: 'PCN-2026-0001', action: 'updated', actor: 'admin', metadata: { status: 'draft' }, createdAt: '2026-10-05T00:00:00.000Z' }]);
});

test('import initializes empty routing only when absent, restores saved counters and rejects overflow', async () => {
  const settings = { flowUrl: '', directoryLookupUrl: '', groups: [] };
  const pool = mockPool([]);
  assert.deepEqual(await new SqlPcnRepository(pool).importDatabase({ counters: { pcn_years: { 2026: 63 } }, notificationSettings: settings }), { imported: 0, skipped: 0, audits: 0 });
  assert.ok(pool.calls.some(call => call.inputs?.sequence === 63));
  assert.ok(pool.calls.some(call => call.inputs?.json === JSON.stringify(settings)));
  const invalid = mockPool([]);
  await assert.rejects(new SqlPcnRepository(invalid).importDatabase({ counters: { 2026: 10000 } }), /Invalid imported yearly counter/);
  assert.equal(invalid.calls.at(-1), 'rollback');
  const conflicting = mockPool([undefined, { recordset: [{ SettingsJson: '{"groups":[{"emails":"other@example.com"}]}' }] }]);
  await assert.rejects(new SqlPcnRepository(conflicting).importDatabase({ notificationSettings: settings }), /conflict with existing SQL routing/);
  assert.equal(conflicting.calls.at(-1), 'rollback');
  const prior = mockPool([{ recordset: [{ SourceHash: 'previous' }] }]);
  await assert.rejects(new SqlPcnRepository(prior).importDatabase({ notificationSettings: settings }), /notification settings source changed/);
});
