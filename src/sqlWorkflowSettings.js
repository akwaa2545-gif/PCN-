const sql = require('mssql');
const crypto = require('node:crypto');
const { ApiError } = require('./apiError');
const { validateWorkflowSettings, normalizeWorkflowSettings } = require('./workflowSettings');
const { lockUserMailRouting, assertCurrentUser } = require('./userMailRouting');
const { hasRole } = require('./workflowAccess');

function hydrate(row) {
  if (!row) throw new ApiError(503, 'SQL workflow settings are not initialized');
  try {
    const config = JSON.parse(row.SettingsJson);
    if (!config || Array.isArray(config) || Object.keys(config).some(key => !['schemaVersion', 'pendingDays'].includes(key))) {
      throw new Error('Unexpected workflow settings fields');
    }
    const version = typeof row.Version === 'string' && /^\d+$/.test(row.Version) ? Number(row.Version) : row.Version;
    const validated = normalizeWorkflowSettings({ ...config, version });
    return { ...validated, updatedAt: row.UpdatedAt ? new Date(row.UpdatedAt).toISOString() : null, updatedBy: row.UpdatedBy || null };
  } catch {
    throw new ApiError(503, 'SQL workflow settings are invalid');
  }
}

class SqlWorkflowSettings {
  constructor(pool) { this.pool = pool; }

  async get(source = this.pool) {
    const result = await source.request().query('SELECT SettingsJson,Version,UpdatedAt,UpdatedBy FROM pcn.WorkflowSettings WITH (HOLDLOCK) WHERE Id=1');
    return hydrate(result.recordset[0]);
  }

  async save(input, actor, user) {
    const validated = validateWorkflowSettings(input);
    if (!user) throw new ApiError(401, 'Sign in again before saving');
    const tx = this.pool.transaction();
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      await lockUserMailRouting(tx);
      await assertCurrentUser(tx, user);
      await this.assertAdministrator(tx, user.id);
      const locked = await tx.request().query('SELECT SettingsJson,Version,UpdatedAt,UpdatedBy FROM pcn.WorkflowSettings WITH (UPDLOCK,HOLDLOCK) WHERE Id=1');
      const before = hydrate(locked.recordset[0]);
      if (before.version !== validated.version) throw new ApiError(409, 'Workflow settings changed; reload before saving');
      if (before.version === Number.MAX_SAFE_INTEGER) throw new ApiError(409, 'Workflow settings version limit reached');
      const updatedBy = typeof actor === 'string' ? actor : `user:${user.id}`;
      const result = await tx.request().input('json', sql.NVarChar(sql.MAX), JSON.stringify({ schemaVersion: 1, pendingDays: validated.pendingDays }))
        .input('version', sql.BigInt, validated.version).input('actor', sql.NVarChar(256), updatedBy)
        .query(`UPDATE pcn.WorkflowSettings SET SettingsJson=@json,Version=Version+1,UpdatedAt=SYSUTCDATETIME(),UpdatedBy=@actor
          OUTPUT inserted.SettingsJson,inserted.Version,inserted.UpdatedAt,inserted.UpdatedBy WHERE Id=1 AND Version=@version`);
      if (result.rowsAffected[0] !== 1) throw new ApiError(409, 'Workflow settings changed; reload before saving');
      const after = hydrate(result.recordset[0]);
      await tx.request().input('id', sql.NVarChar(128), crypto.randomUUID()).input('actor', sql.NVarChar(256), updatedBy)
        .input('metadata', sql.NVarChar(sql.MAX), JSON.stringify({ before, after }))
        .query(`INSERT pcn.AuditLogs(Id,PcnCode,Action,Actor,MetadataJson,CreatedAt,SourceJson)
          VALUES(@id,N'workflow-settings',N'updated',@actor,@metadata,SYSUTCDATETIME(),NULL)`);
      await tx.commit();
      return after;
    } catch (error) {
      try { await tx.rollback(); } catch { /* Preserve the original error after automatic SQL rollback. */ }
      throw error;
    }
  }

  async assertAdministrator(tx, id) {
    const result = await tx.request().input('id', sql.UniqueIdentifier, id)
      .query(`SELECT u.IsActive,u.DepartmentKey,u.SigningStep,r.Name AS RoleName FROM pcn.Users u
        LEFT JOIN pcn.UserRoles ur ON ur.UserId=u.Id LEFT JOIN pcn.Roles r ON r.Id=ur.RoleId WHERE u.Id=@id`);
    const current = result.recordset[0];
    const user = current && { isActive: Boolean(current.IsActive), department: current.DepartmentKey, signingStep: current.SigningStep,
      roles: result.recordset.map(row => row.RoleName).filter(Boolean) };
    if (!user?.isActive || !hasRole(user, 'admin')) throw new ApiError(403, 'Administrator access required');
  }
}

module.exports = { SqlWorkflowSettings };
