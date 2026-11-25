const sql = require('mssql');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { ApiError } = require('./apiError');
const { validateChangeCategories, categorySettings, buildDefinition } = require('./changeCategories');
const { SqlWorkflowSettings } = require('./sqlWorkflowSettings');
const { lockUserMailRouting, assertCurrentUser } = require('./userMailRouting');

function hydrate(row) {
  try {
    if (!row) throw new Error('Missing master data');
    const master = { ...JSON.parse(row.DefinitionJson), versionId: row.Id };
    validateChangeCategories({ ...categorySettings(master), reason: 'Read stored settings' });
    return master;
  } catch {
    throw new ApiError(503, 'Content of Changes master data is unavailable');
  }
}

class SqlChangeCategories {
  constructor(pool) { this.pool = pool; }
  async get() {
    const result = await this.pool.request().query('SELECT TOP(1) Id,DefinitionJson FROM pcn.MasterDataVersions WHERE IsActive=1 ORDER BY Id DESC');
    return categorySettings(hydrate(result.recordset[0]));
  }
  async save(input, actor, user) {
    const validated = validateChangeCategories(input);
    if (!user?.id) throw new ApiError(401, 'Sign in again before saving');
    const tx = this.pool.transaction();
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      await lockUserMailRouting(tx);
      await assertCurrentUser(tx, user);
      await new SqlWorkflowSettings(this.pool).assertAdministrator(tx, user.id);
      const locked = await tx.request().query('SELECT TOP(1) Id,DefinitionJson FROM pcn.MasterDataVersions WITH (UPDLOCK,HOLDLOCK) WHERE IsActive=1 ORDER BY Id DESC');
      const before = hydrate(locked.recordset[0]), previous = categorySettings(before);
      if (before.versionId !== validated.versionId) throw new ApiError(409, 'Content of Changes settings changed; reload before saving');
      if (isDeepStrictEqual(previous.forms, validated.forms)) { await tx.commit(); return previous; }
      const updatedBy = `user:${user.id}`;
      const definition = buildDefinition(before, validated, { id: crypto.randomUUID(), time: new Date().toISOString(), actor: updatedBy });
      const json = JSON.stringify(definition), hash = crypto.createHash('sha256').update(json).digest('hex');
      await tx.request().query('UPDATE pcn.MasterDataVersions SET IsActive=0 WHERE IsActive=1');
      const inserted = await tx.request().input('json', sql.NVarChar(sql.MAX), json).input('hash', sql.Char(64), hash)
        .query('INSERT pcn.MasterDataVersions(DefinitionHash,DefinitionJson,IsActive) OUTPUT inserted.Id VALUES(@hash,@json,1)');
      const after = categorySettings({ ...definition, versionId: inserted.recordset[0].Id });
      await tx.request().input('id', sql.NVarChar(128), crypto.randomUUID()).input('actor', sql.NVarChar(256), updatedBy)
        .input('metadata', sql.NVarChar(sql.MAX), JSON.stringify({ reason: validated.reason, before: previous, after }))
        .query("INSERT pcn.AuditLogs(Id,PcnCode,Action,Actor,MetadataJson,CreatedAt,SourceJson) VALUES(@id,N'change-categories',N'updated',@actor,@metadata,SYSUTCDATETIME(),NULL)");
      await tx.commit();
      return after;
    } catch (error) {
      try { await tx.rollback(); } catch { /* Keep the original publication failure. */ }
      throw error;
    }
  }
}

module.exports = { SqlChangeCategories };
