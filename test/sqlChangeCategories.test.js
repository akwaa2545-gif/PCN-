const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sql = require('mssql');
const { SqlChangeCategories } = require('../src/sqlChangeCategories');
const { baselineDefinition, categorySettings } = require('../src/changeCategories');
const { SqlPcnRepository } = require('../src/sqlPcnRepository');

const user = Object.freeze({ id: '00000000-0000-4000-8000-000000000001', version: '0000000000000001',
  sessionSecurityStamp: 'fixture-stamp', roles: ['admin'] });
const initial = () => ({ ...baselineDefinition(), versionId: 7 });
function payload(master = initial(), changed = true) {
  const input = { ...categorySettings(master), reason: 'Clarify change category wording' };
  if (changed) input.forms.rawMaterial[0].text = `${input.forms.rawMaterial[0].text} — clarified`;
  return input;
}

function mockPool(options = {}) {
  const calls = [];
  const executedWrites = [];
  const source = options.definition || baselineDefinition();
  const originalJson = options.corruptJson === undefined ? JSON.stringify(source) : options.corruptJson;
  let active = options.missing ? null : { Id: options.versionId || 7, DefinitionJson: originalJson };
  let staged, serial = active?.Id || 7;
  const request = transactional => { const inputs = {}; return {
    input(name, type, value) { inputs[name] = value; return this; },
    async query(statement) {
      calls.push({ statement, inputs: { ...inputs }, transactional });
      if (statement.includes('sp_getapplock')) return { recordset: [{ LockResult: options.lockFailure ? -1 : 0 }] };
      if (statement.includes('SELECT IsActive,SecurityStamp,AccessVersion')) return { recordset: options.missingUser ? [] : [{
        IsActive: !options.inactive, SecurityStamp: options.staleStamp ? 'revoked-stamp' : 'fixture-stamp',
        AccessVersion: Buffer.from(options.staleAccess ? '0000000000000002' : user.version, 'hex')
      }] };
      if (statement.includes('RoleName')) return { recordset: (options.roles || ['admin']).map(RoleName => ({
        IsActive: !options.roleInactive, DepartmentKey: options.department, SigningStep: options.signingStep, RoleName
      })) };
      if (/INSERT\s+(?:INTO\s+)?pcn\.AuditLogs/i.test(statement)) {
        if (options.auditFailure) throw new Error('audit failed');
        return { recordset: [], rowsAffected: [1] };
      }
      if (/DECLARE @active int/i.test(statement) && staged) {
        assert.match(statement, /IF @active IS NOT NULL SELECT @active AS Id;\s*ELSE BEGIN/i);
        assert.doesNotMatch(statement, /SET IsActive\s*=\s*0/i);
        return { recordset: [{ Id: staged.Id }] };
      }
      if (/INSERT\s+(?:INTO\s+)?pcn\.MasterDataVersions/i.test(statement)) {
        if (options.insertFailure) throw new Error('master insert failed');
        executedWrites.push({ statement, inputs: { ...inputs } });
        staged = { Id: ++serial, DefinitionJson: inputs.json };
        return { recordset: [structuredClone(staged)], rowsAffected: [1] };
      }
      if (/UPDATE\s+pcn\.MasterDataVersions/i.test(statement)) {
        executedWrites.push({ statement, inputs: { ...inputs } });
        return { recordset: [], rowsAffected: [1] };
      }
      if (/SELECT[\s\S]*FROM\s+pcn\.MasterDataVersions/i.test(statement)) {
        const selected = transactional ? staged : active;
        return { recordset: selected ? [structuredClone(selected)] : [] };
      }
      throw new Error(`Unexpected SQL in fixture: ${statement}`);
    }
  }; };
  const tx = {
    request: () => request(true),
    async begin(level) { staged = active && structuredClone(active); calls.push({ event: 'begin', level }); },
    async commit() { active = staged && structuredClone(staged); calls.push({ event: 'commit' }); },
    async rollback() { staged = active && structuredClone(active); calls.push({ event: 'rollback' }); if (options.rollbackFailure) throw new Error('rollback failed'); }
  };
  return { calls, executedWrites, request: () => request(false), transaction: () => tx,
    active: () => active && structuredClone(active), originalJson };
}
const queries = pool => pool.calls.filter(call => call.statement);
const writes = pool => queries(pool).filter(call => /(?:UPDATE|INSERT)\s+(?:INTO\s+)?pcn\.MasterDataVersions/i.test(call.statement));

test('SQL category reads expose current forms and fail closed for missing or invalid master definitions', async () => {
  const pool = mockPool();
  assert.deepEqual(await new SqlChangeCategories(pool).get(), categorySettings(initial()));
  assert.equal(queries(pool).some(call => /(?:UPDATE|INSERT)/i.test(call.statement)), false);
  for (const options of [{ missing: true }, { corruptJson: '{' }, { corruptJson: '{}' }]) {
    await assert.rejects(new SqlChangeCategories(mockPool(options)).get(), { statusCode: 503 });
  }
});

test('SQL category publication locks live access and CAS then atomically records immutable master and audit', async () => {
  const pool = mockPool(), input = payload();
  const untouchedInput = structuredClone(input);
  const result = await new SqlChangeCategories(pool).save(input, 'user:admin-fixture', user);
  assert.deepEqual(input, untouchedInput);
  assert.equal(result.versionId, 8); assert.deepEqual(result.forms, input.forms);
  assert.equal(pool.calls[0].level, sql.ISOLATION_LEVEL.SERIALIZABLE);
  assert.equal(pool.calls.at(-1).event, 'commit');
  const statements = queries(pool);
  assert.match(statements[0].statement, /sp_getapplock/);
  const userRead = statements.findIndex(call => call.statement.includes('SELECT IsActive,SecurityStamp,AccessVersion'));
  const roleRead = statements.findIndex(call => call.statement.includes('RoleName'));
  const masterRead = statements.findIndex(call => /SELECT[\s\S]*FROM pcn.MasterDataVersions/i.test(call.statement));
  assert.ok(userRead > 0 && roleRead > userRead && masterRead > roleRead);
  assert.match(statements[masterRead].statement, /UPDLOCK\s*,\s*HOLDLOCK/i);
  const insert = statements.find(call => /INSERT\s+(?:INTO\s+)?pcn\.MasterDataVersions/i.test(call.statement));
  assert.ok(insert); assert.doesNotMatch(insert.statement, /clarified|user:admin-fixture/);
  const newDefinition = JSON.parse(insert.inputs.json), oldDefinition = JSON.parse(pool.originalJson);
  assert.deepEqual(newDefinition.formDefinitions.rawMaterial.riskOptions, input.forms.rawMaterial);
  assert.deepEqual(newDefinition.formDefinitions.packaging.riskOptions, input.forms.packaging);
  assert.deepEqual(newDefinition.commonDocuments, oldDefinition.commonDocuments);
  assert.deepEqual(newDefinition.workflowBase, oldDefinition.workflowBase);
  assert.equal(newDefinition.versionId, undefined);
  assert.equal(newDefinition.changeCategoriesPublication.reason, input.reason);
  assert.equal(newDefinition.changeCategoriesPublication.actor, `user:${user.id}`);
  assert.equal(insert.inputs.hash, crypto.createHash('sha256').update(insert.inputs.json).digest('hex'));
  const audit = statements.find(call => /INSERT\s+(?:INTO\s+)?pcn\.AuditLogs/i.test(call.statement));
  const metadata = JSON.parse(audit.inputs.metadata);
  assert.deepEqual(metadata.before, categorySettings(initial()));
  assert.deepEqual(metadata.after, result);
  assert.equal(JSON.stringify(metadata).includes(input.reason), true);
  assert.equal(statements.some(call => /(?:UPDATE|INSERT|DELETE)\s+(?:INTO\s+|FROM\s+)?pcn\.Pcn/i.test(call.statement)), false);
});

test('live permission, account, lock and version failures roll back before changing categories', async () => {
  for (const [options, statusCode] of [[{ versionId: 8 }, 409], [{ staleStamp: true }, 401], [{ staleAccess: true }, 401],
    [{ inactive: true }, 401], [{ missingUser: true }, 401], [{ roles: ['reviewer'] }, 403],
    [{ roles: ['developer'], department: 'qaTet' }, 403], [{ roles: ['developer', 'reviewer'], department: 'developer' }, 403],
    [{ roles: ['admin'], roleInactive: true }, 403], [{ lockFailure: true }, 409]]) {
    const pool = mockPool(options);
    await assert.rejects(new SqlChangeCategories(pool).save(payload(), 'actor', user), { statusCode });
    assert.equal(pool.calls.at(-1).event, 'rollback'); assert.deepEqual(writes(pool), []);
  }
  const developer = mockPool({ roles: ['developer'], department: 'developer', signingStep: null });
  assert.equal((await new SqlChangeCategories(developer).save(payload(), 'actor', user)).versionId, 8);
  const noUser = mockPool();
  await assert.rejects(new SqlChangeCategories(noUser).save(payload(), 'actor'), { statusCode: 401 });
  assert.deepEqual(noUser.calls, []);
});

test('unchanged categories still check current account, role and CAS but create no publication or audit', async () => {
  const pool = mockPool();
  assert.deepEqual(await new SqlChangeCategories(pool).save(payload(initial(), false), 'actor', user), categorySettings(initial()));
  assert.equal(pool.calls.at(-1).event, 'commit'); assert.deepEqual(writes(pool), []);
  assert.equal(queries(pool).some(call => call.statement.includes('RoleName')), true);
  assert.equal(queries(pool).some(call => call.statement.includes('SELECT IsActive,SecurityStamp,AccessVersion')), true);
  assert.equal(queries(pool).some(call => call.statement.includes('INSERT pcn.AuditLogs')), false);
  for (const [options, statusCode] of [[{ staleAccess: true }, 401], [{ roles: ['reviewer'] }, 403], [{ versionId: 8 }, 409]]) {
    await assert.rejects(new SqlChangeCategories(mockPool(options)).save(payload(initial(), false), 'actor', user), { statusCode });
  }
});

test('publication or audit failure rolls back active definition and preserves original errors', async () => {
  for (const options of [{ insertFailure: true }, { auditFailure: true }, { auditFailure: true, rollbackFailure: true }]) {
    const pool = mockPool(options), before = pool.active();
    await assert.rejects(new SqlChangeCategories(pool).save(payload(), 'actor', user), options.insertFailure ? /master insert failed/ : /audit failed/);
    assert.equal(pool.calls.at(-1).event, 'rollback');
    assert.equal(pool.calls.some(call => call.event === 'commit'), false);
    assert.deepEqual(pool.active(), before);
  }
});

test('reverting categories publishes a fresh identity and hash instead of reactivating old definitions', async () => {
  const pool = mockPool(), adapter = new SqlChangeCategories(pool);
  const changed = await adapter.save(payload(), 'actor', user);
  const firstJson = pool.active().DefinitionJson;
  const reverted = await adapter.save({ ...categorySettings(initial()), versionId: changed.versionId, reason: 'Restore original wording' }, 'actor', user);
  assert.equal(reverted.versionId, 9);
  assert.deepEqual(reverted.forms, categorySettings(initial()).forms);
  assert.notEqual(pool.active().DefinitionJson, pool.originalJson);
  assert.notEqual(pool.active().DefinitionJson, firstJson);
  const inserts = queries(pool).filter(call => /INSERT\s+(?:INTO\s+)?pcn\.MasterDataVersions/i.test(call.statement));
  assert.equal(inserts.length, 2);
  assert.notEqual(inserts[0].inputs.hash, inserts[1].inputs.hash);
});

test('invalid category input is rejected before opening any database transaction', async () => {
  for (const value of [{ ...payload(), extra: true }, { ...payload(), versionId: 0 }, { ...payload(), reason: '' }]) {
    const pool = mockPool();
    await assert.rejects(new SqlChangeCategories(pool).save(value, 'actor', user), { statusCode: 400 });
    assert.deepEqual(pool.calls, []);
  }
});

test('repository settings delegates remain separate from record data and master seed preserves published definitions', async () => {
  const pool = mockPool(), repository = new SqlPcnRepository(pool);
  assert.deepEqual(await repository.getChangeCategories(), categorySettings(initial()));
  assert.equal((await repository.saveChangeCategories(payload(), 'actor', user)).versionId, 8);
  const published = pool.active();
  pool.calls.length = 0;
  pool.executedWrites.length = 0;
  assert.equal(await repository.seedMasterData(baselineDefinition()), published.Id);
  assert.deepEqual(pool.active(), published);
  assert.equal(pool.executedWrites.length, 0, 'Starting the server must not deactivate an administrator publication');
});
