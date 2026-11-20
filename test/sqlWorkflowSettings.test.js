const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SqlWorkflowSettings } = require('../src/sqlWorkflowSettings');
const { defaultWorkflowSettings } = require('../src/workflowSettings');
const { migrationManifest } = require('../src/sqlDatabase');
const { SqlPcnRepository } = require('../src/sqlPcnRepository');
const user = { id: '00000000-0000-4000-8000-000000000001', version: '0000000000000001', sessionSecurityStamp: 'stamp', roles: ['admin'] };
const payload = (version = 0) => ({ schemaVersion: 1, version, pendingDays: defaultWorkflowSettings().pendingDays });
const row = (version = 0) => ({ Id: 1, SettingsJson: JSON.stringify({ schemaVersion: 1, pendingDays: payload().pendingDays }), Version: version, UpdatedAt: null, UpdatedBy: null });

function mockPool(options = {}) {
  const calls = [];
  const request = () => { const inputs = {}; return {
    input(name, type, value) { inputs[name] = value; return this; },
    async query(statement) {
      calls.push({ statement, inputs });
      if (statement.includes('sp_getapplock')) return { recordset: [{ LockResult: options.lockFailure ? -1 : 0 }] };
      if (statement.includes('SELECT IsActive,SecurityStamp,AccessVersion')) return { recordset: [{ IsActive: !options.inactive, SecurityStamp: options.stale ? 'changed' : 'stamp', AccessVersion: Buffer.from(user.version, 'hex') }] };
      if (statement.includes('RoleName')) return { recordset: (options.roles || ['admin']).map(RoleName => ({ IsActive: true, DepartmentKey: options.department, SigningStep: options.signingStep, RoleName })) };
      if (statement.includes('UPDATE pcn.WorkflowSettings')) {
        if (options.writeFailure) throw new Error('write failed');
        if (options.writeConflict) return { recordset: [], rowsAffected: [0] };
        return { recordset: [{ ...row(inputs.version + 1), SettingsJson: inputs.json, UpdatedAt: new Date('2026-10-21T01:00:00Z'), UpdatedBy: inputs.actor }], rowsAffected: [1] };
      }
      if (statement.includes('SELECT') && statement.includes('pcn.WorkflowSettings')) return { recordset: options.missing ? [] : [{ ...row(options.version || 0), ...(options.corruptJson ? { SettingsJson: options.corruptJson } : {}) }] };
      if (statement.includes('INSERT pcn.AuditLogs') && options.auditFailure) throw new Error('audit failed');
      return { recordset: [], rowsAffected: [1] };
    }
  }; };
  const tx = { request, async begin() { calls.push('begin'); }, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); if (options.rollbackFailure) throw new Error('rollback failed'); } };
  return { calls, request, transaction: () => tx };
}

test('SQL settings reads use caller transaction and refuse missing initialized singleton', async () => {
  const pool = mockPool(); const adapter = new SqlWorkflowSettings(pool);
  assert.deepEqual(await adapter.get(), defaultWorkflowSettings());
  assert.match(pool.calls[0].statement, /HOLDLOCK/);
  const tx = mockPool({ version: 2 });
  assert.equal((await adapter.get(tx)).version, 2);
  await assert.rejects(new SqlWorkflowSettings(mockPool({ missing: true })).get(), { statusCode: 503 });
});

test('SQL bigint versions from the installed driver become safe numeric versions and malformed stored policy fails closed', async () => {
  assert.equal((await new SqlWorkflowSettings(mockPool({ version: '3' })).get()).version, 3);
  for (const options of [{ version: '9007199254740992' }, { version: 'bad' }, { corruptJson: '{' },
    { corruptJson: JSON.stringify({ schemaVersion: 1, pendingDays: payload().pendingDays, unknown: true }) }]) {
    await assert.rejects(new SqlWorkflowSettings(mockPool(options)).get(), { statusCode: 503 });
  }
});

test('settings save locks access then rechecks live admin and optimistic version before parameterized write and audit', async () => {
  const pool = mockPool();
  const saved = await new SqlWorkflowSettings(pool).save(payload(), 'user:admin', user);
  assert.equal(saved.version, 1); assert.equal(saved.updatedBy, 'user:admin');
  assert.equal(saved.updatedAt, '2026-10-21T01:00:00.000Z');
  assert.equal(pool.calls.at(-1), 'commit');
  const statements = pool.calls.filter(call => call.statement);
  assert.match(statements[0].statement, /sp_getapplock/);
  const lockedRead = statements.find(call => /SELECT.*SettingsJson/.test(call.statement));
  assert.match(lockedRead.statement, /UPDLOCK,HOLDLOCK/);
  const write = statements.find(call => call.statement.includes('UPDATE pcn.WorkflowSettings'));
  assert.equal(write.inputs.version, 0);
  assert.doesNotMatch(write.statement, /user:admin/);
  const audit = statements.find(call => call.statement.includes('INSERT pcn.AuditLogs'));
  const metadata = JSON.parse(audit.inputs.metadata);
  assert.deepEqual(metadata.before, defaultWorkflowSettings()); assert.deepEqual(metadata.after, saved);
  assert.equal(statements.some(call => /(?:UPDATE|INSERT) pcn.Pcn/.test(call.statement)), false);
});

test('stale settings and changed permissions roll back without settings writes', async () => {
  for (const [options, statusCode] of [[{ version: 1 }, 409], [{ stale: true }, 401], [{ inactive: true }, 401], [{ roles: ['reviewer'] }, 403], [{ roles: ['developer'], department: 'qaTet' }, 403], [{ lockFailure: true }, 409]]) {
    const pool = mockPool(options);
    await assert.rejects(new SqlWorkflowSettings(pool).save(payload(), 'actor', user), { statusCode });
    assert.equal(pool.calls.at(-1), 'rollback');
    assert.equal(pool.calls.some(call => call.statement?.includes('UPDATE pcn.WorkflowSettings')), false);
  }
  const developer = mockPool({ roles: ['developer'], department: 'developer', signingStep: null });
  assert.equal((await new SqlWorkflowSettings(developer).save(payload(), 'actor', user)).version, 1);
  await assert.rejects(new SqlWorkflowSettings(mockPool()).save(payload(), 'actor'), { statusCode: 401 });
});

test('repository delegates settings reads to the supplied transaction and saves to the dedicated adapter', async () => {
  const pool = mockPool(); const repository = new SqlPcnRepository(pool);
  const source = mockPool({ version: '2' });
  assert.equal((await repository.getWorkflowSettings(source)).version, 2);
  assert.deepEqual(pool.calls, []);
  assert.equal((await repository.saveWorkflowSettings(payload(), 'actor', user)).version, 1);
});

test('write conflicts and exhausted versions produce conflicts and rollback', async () => {
  const conflict = mockPool({ writeConflict: true });
  await assert.rejects(new SqlWorkflowSettings(conflict).save(payload(), 'actor', user), { statusCode: 409 });
  assert.equal(conflict.calls.at(-1), 'rollback');
  const exhausted = mockPool({ version: String(Number.MAX_SAFE_INTEGER) });
  await assert.rejects(new SqlWorkflowSettings(exhausted).save(payload(Number.MAX_SAFE_INTEGER), 'actor', user), { statusCode: 409 });
  assert.equal(exhausted.calls.some(call => call.statement?.includes('UPDATE pcn.WorkflowSettings')), false);
});

test('settings write or audit errors preserve original errors and roll back the transaction', async () => {
  for (const options of [{ writeFailure: true }, { auditFailure: true }, { auditFailure: true, rollbackFailure: true }]) {
    const pool = mockPool(options);
    await assert.rejects(new SqlWorkflowSettings(pool).save(payload(), 'actor', user), options.writeFailure ? /write failed/ : /audit failed/);
    assert.equal(pool.calls.at(-1), 'rollback'); assert.equal(pool.calls.includes('commit'), false);
  }
  const pool = mockPool();
  await assert.rejects(new SqlWorkflowSettings(pool).save({ ...payload(), unknown: true }, 'actor', user), { statusCode: 400 });
  assert.deepEqual(pool.calls, []);
});

test('explicit migration creates and seeds dedicated singleton without PCN writes', () => {
  assert.ok(migrationManifest.includes('008_workflow_settings.sql'));
  const ddl = fs.readFileSync(path.join(__dirname, '../sql/migrations/008_workflow_settings.sql'), 'utf8');
  assert.match(ddl, /IF OBJECT_ID\(N'pcn.WorkflowSettings', N'U'\) IS NULL/);
  assert.match(ddl, /CHECK\s*\(Id\s*=\s*1\)/);
  assert.match(ddl, /INSERT pcn.WorkflowSettings/);
  assert.doesNotMatch(ddl, /(?:UPDATE|INSERT) pcn.Pcn/);
});
