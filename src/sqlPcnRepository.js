const sql = require('mssql');
const crypto = require('node:crypto');
const { ApiError } = require('./apiError');
const { scalarFields, childTables, splitRecord, hydratePcn, versionHex } = require('./sqlPcnHydration');
const { migrationManifest } = require('./sqlDatabase');

const emptySettings = { flowUrl: '', directoryLookupUrl: '', groups: [
  ['signoff.gscTet', 'GSC/TET'], ['signoff.prodEngTet', 'Prod.Eng/TET'], ['signoff.qaTet', 'QA/TET'],
  ['tapbu.gsc', 'GSC/TaPBU'], ['tapbu.qa', 'QA/TaPBU'], ['qateFinal.signoff', 'QA/TET Final Judgment'],
  ['supplierNotification', 'GSC/TET Supplier Notification']
].map(([key, label]) => ({ key, label, emails: '', recipients: [] })) };

class SqlPcnRepository {
  constructor(pool) { this.pool = pool; this.isSql = true; }

  async transaction(work) {
    const tx = this.pool.transaction();
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try { const result = await work(tx); await tx.commit(); return result; }
    catch (error) { try { await tx.rollback(); } catch { /* Preserve the original error after automatic SQL rollback. */ } throw error; }
  }

  async list(filters = {}) {
    const rows = await this.pool.request().input('status', sql.NVarChar(40), filters.status || null)
      .input('owner', sql.UniqueIdentifier, filters.ownerUserId || null)
      .query('SELECT PcnCode FROM pcn.PcnRequests WHERE DeletedAt IS NULL AND (@status IS NULL OR Status=@status) AND (@owner IS NULL OR OwnerUserId=@owner) ORDER BY UpdatedAt DESC,PcnCode');
    let records = [];
    // Bound hydration concurrency to avoid exhausting the SQL pool when importing large histories.
    for (let offset = 0; offset < rows.recordset.length; offset += 4) {
      records = [...records, ...await Promise.all(rows.recordset.slice(offset, offset + 4).map(row => this.findById(row.PcnCode)))];
    }
    return records.filter(Boolean);
  }

  async findById(code) {
    // A read transaction keeps parent, workbook review and all children at one committed version.
    return this.transaction(async tx => {
      const parent = await this.readParent(tx, code);
      return parent ? this.readAggregate(tx, parent) : null;
    });
  }

  async readParent(source, code, locked = false) {
    const rows = await source.request().input('code', sql.NVarChar(32), code)
      .query(`SELECT * FROM pcn.PcnRequests ${locked ? 'WITH (UPDLOCK, HOLDLOCK)' : ''} WHERE PcnCode=@code AND DeletedAt IS NULL`);
    return rows.recordset[0] || null;
  }

  async readAggregate(source, parent) {
    const queries = ['SELECT ReviewJson FROM pcn.PcnInternalReviews WHERE PcnId=@id',
      ...Object.values(childTables).map(table => `SELECT PayloadJson FROM pcn.${table} WHERE PcnId=@id ORDER BY SortOrder`)];
    const rows = await source.request().input('id', sql.BigInt, parent.PcnId).query(queries.join(';'));
    const sets = rows.recordsets;
    const children = Object.fromEntries(Object.keys(childTables).map((key, index) => [key, (sets[index + 1] || []).map(row => {
      const value = JSON.parse(row.PayloadJson); return key === 'route' && 'value' in value ? value.value : value;
    })]));
    return hydratePcn(parent, JSON.parse(sets[0][0]?.ReviewJson || '{}'), children);
  }

  async allocateCode(tx, year) {
    const result = await tx.request().input('year', sql.Int, year).query(`
      IF NOT EXISTS(SELECT 1 FROM pcn.PcnCounters WITH (UPDLOCK, HOLDLOCK) WHERE Year=@year)
        INSERT pcn.PcnCounters(Year,LastSequence) VALUES(@year,0);
      UPDATE pcn.PcnCounters SET LastSequence=LastSequence+1 OUTPUT inserted.LastSequence AS Sequence WHERE Year=@year;`);
    const sequence = result.recordset[0].Sequence;
    if (sequence > 9999) throw new ApiError(409, 'Annual PCN sequence exhausted; contact the administrator');
    return `PCN-${year}-${String(sequence).padStart(4, '0')}`;
  }

  async create(record, actor = 'system') {
    return this.transaction(async tx => {
      const year = Number(String(record.createdAt || new Date().toISOString()).slice(0, 4));
      const id = record.id || await this.allocateCode(tx, year);
      assertCode(id);
      const next = { ...record, id, internalReview: { ...(record.internalReview || {}), pcnCode: id } };
      const parent = await this.writeParent(tx, next);
      await this.writeChildren(tx, parent.PcnId, next);
      if (record.id) await this.raiseCounter(tx, id);
      await this.audit(tx, id, 'created', actor, { status: record.status });
      return this.readAggregate(tx, parent);
    });
  }

  checkVersion(parent, expectedVersion) {
    if (expectedVersion !== undefined && expectedVersion !== null && versionHex(parent.RowVersion) !== versionHex(expectedVersion)) {
      throw new ApiError(409, 'PCN changed since it was loaded; reload before saving');
    }
  }

  async update(code, updater, actor = 'system', expectedVersion) {
    return this.transaction(async tx => {
      const parent = await this.readParent(tx, code, true);
      if (!parent) return null;
      this.checkVersion(parent, expectedVersion);
      const current = await this.readAggregate(tx, parent);
      const proposed = await updater(current);
      const next = { ...proposed, id: code, ownerUserId: current.ownerUserId, createdAt: current.createdAt,
        ...('masterDataVersionId' in current ? { masterDataVersionId: current.masterDataVersionId } : {}),
        internalReview: { ...(proposed.internalReview || {}), pcnCode: code } };
      const updated = await this.writeParent(tx, next, parent.PcnId);
      await this.writeChildren(tx, parent.PcnId, next);
      await this.audit(tx, code, 'updated', actor, { status: next.status });
      return this.readAggregate(tx, updated);
    });
  }

  async delete(code, actor = 'system', expectedVersion) {
    return this.transaction(async tx => {
      const parent = await this.readParent(tx, code, true);
      if (!parent) return false;
      this.checkVersion(parent, expectedVersion);
      await tx.request().input('id', sql.BigInt, parent.PcnId).input('actor', sql.NVarChar(256), actorName(actor))
        .query('UPDATE pcn.PcnRequests SET DeletedAt=SYSUTCDATETIME(),DeletedBy=@actor WHERE PcnId=@id');
      await this.audit(tx, code, 'deleted', actor, {});
      return true;
    });
  }

  async writeParent(tx, record, pcnId) {
    const split = splitRecord(record);
    const request = tx.request().input('code', sql.NVarChar(32), record.id);
    const columns = [...Object.values(scalarFields), 'LegacyExtrasJson', 'PresentFieldsJson'];
    columns.forEach((column, index) => request.input(`v${index}`, typeFor(column), sqlValue(column, split.parent[column])));
    let statement;
    if (pcnId !== undefined) {
      request.input('id', sql.BigInt, pcnId);
      statement = `UPDATE pcn.PcnRequests SET ${columns.map((column, i) => `[${column}]=@v${i}`).join(',')} OUTPUT inserted.* WHERE PcnId=@id`;
    } else {
      statement = `INSERT pcn.PcnRequests(PcnCode,${columns.map(column => `[${column}]`).join(',')}) OUTPUT inserted.* VALUES(@code,${columns.map((_, i) => `@v${i}`).join(',')})`;
    }
    return (await request.query(statement)).recordset[0];
  }

  async writeChildren(tx, pcnId, record) {
    const { review, children } = splitRecord(record);
    await tx.request().input('id', sql.BigInt, pcnId).input('review', sql.NVarChar(sql.MAX), JSON.stringify(review))
      .query('DELETE pcn.PcnInternalReviews WHERE PcnId=@id; INSERT pcn.PcnInternalReviews(PcnId,ReviewJson) VALUES(@id,@review)');
    for (const [key, table] of Object.entries(childTables)) {
      const values = key === 'route' ? children[key].map(value => ({ value })) : children[key];
      await tx.request().input('id', sql.BigInt, pcnId).query(`DELETE pcn.${table} WHERE PcnId=@id`);
      for (const [sortOrder, value] of values.entries()) {
        const fields = childColumns[key];
        const request = tx.request().input('id', sql.BigInt, pcnId).input('order', sql.Int, sortOrder)
          .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(value));
        fields.forEach(([column, type, field], index) => request.input(`v${index}`, type, childValue(value, column, field)));
        await request.query(`INSERT pcn.${table}(PcnId,SortOrder,PayloadJson,${fields.map(([column]) => `[${column}]`).join(',')})
          VALUES(@id,@order,@payload,${fields.map((_, index) => `@v${index}`).join(',')})`);
      }
    }
  }

  async audit(tx, code, action, actor, metadata, original) {
    const id = original?.id || crypto.randomUUID();
    await tx.request().input('id', sql.NVarChar(128), id).input('code', sql.NVarChar(128), code)
      .input('action', sql.NVarChar(80), action).input('actor', sql.NVarChar(256), actorName(actor))
      .input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(metadata || {}))
      .input('created', sql.DateTime2(3), original?.createdAt ? new Date(original.createdAt) : new Date())
      .input('source', sql.NVarChar(sql.MAX), original ? JSON.stringify(original) : null)
      .query(`IF @source IS NOT NULL AND EXISTS(SELECT 1 FROM pcn.AuditLogs WITH (UPDLOCK,HOLDLOCK) WHERE Id=@id AND (SourceJson IS NULL OR SourceJson<>@source))
        THROW 51001, 'Imported audit identity conflicts with existing source', 1;
        IF NOT EXISTS(SELECT 1 FROM pcn.AuditLogs WITH (UPDLOCK,HOLDLOCK) WHERE Id=@id) INSERT pcn.AuditLogs(Id,PcnCode,Action,Actor,MetadataJson,CreatedAt,SourceJson) VALUES(@id,@code,@action,@actor,@metadata,@created,@source)`);
  }

  async getAudit(code) {
    const result = await this.pool.request().input('code', sql.NVarChar(128), code)
      .query('SELECT * FROM pcn.AuditLogs WHERE PcnCode=@code ORDER BY CreatedAt,Id');
    return result.recordset.map(row => row.SourceJson ? JSON.parse(row.SourceJson) : {
      id: row.Id, pcnId: row.PcnCode, action: row.Action, actor: row.Actor, metadata: JSON.parse(row.MetadataJson), createdAt: row.CreatedAt.toISOString()
    });
  }

  async getNotificationSettings() {
    const result = await this.pool.request().query('SELECT SettingsJson FROM pcn.NotificationSettings WHERE Id=1');
    return result.recordset[0] ? JSON.parse(result.recordset[0].SettingsJson) : structuredClone(emptySettings);
  }

  async saveNotificationSettings(settings, actor = 'system') {
    return this.transaction(async tx => {
      await this.writeSettings(tx, settings);
      await this.audit(tx, 'notification-settings', 'updated', actor, { groups: settings.groups.length });
      return structuredClone(settings);
    });
  }

  async writeSettings(tx, settings) {
    await tx.request().input('json', sql.NVarChar(sql.MAX), JSON.stringify(settings)).query(`
      IF EXISTS(SELECT 1 FROM pcn.NotificationSettings WITH (UPDLOCK,HOLDLOCK) WHERE Id=1)
        UPDATE pcn.NotificationSettings SET SettingsJson=@json,UpdatedAt=SYSUTCDATETIME() WHERE Id=1;
      ELSE INSERT pcn.NotificationSettings(Id,SettingsJson) VALUES(1,@json);
      DELETE pcn.NotificationRecipients; DELETE pcn.NotificationGroups;`);
    for (const [sortOrder, group] of (settings.groups || []).entries()) {
      await tx.request().input('key', sql.NVarChar(80), group.key).input('order', sql.Int, sortOrder)
        .input('label', sql.NVarChar(120), group.label).input('emails', sql.NVarChar(1000), group.emails || '')
        .query('INSERT pcn.NotificationGroups(GroupKey,SortOrder,Label,Emails) VALUES(@key,@order,@label,@emails)');
      for (const [recipientOrder, recipient] of (group.recipients || []).entries()) {
        await tx.request().input('key', sql.NVarChar(80), group.key).input('order', sql.Int, recipientOrder)
          .input('email', sql.NVarChar(320), recipient.email).input('profile', sql.NVarChar(sql.MAX), JSON.stringify(recipient))
          .query('INSERT pcn.NotificationRecipients(GroupKey,SortOrder,Email,ProfileJson) VALUES(@key,@order,@email,@profile)');
      }
    }
  }

  async getMasterData(versionId) {
    const result = await this.pool.request().input('version', sql.Int, versionId || null)
      .query('SELECT TOP(1) Id,DefinitionJson FROM pcn.MasterDataVersions WHERE (@version IS NULL AND IsActive=1) OR Id=@version ORDER BY Id DESC');
    if (!result.recordset[0]) throw new ApiError(503, 'SQL master data is not initialized');
    return { ...JSON.parse(result.recordset[0].DefinitionJson), versionId: result.recordset[0].Id };
  }

  async seedMasterData(definition) {
    const serialized = JSON.stringify(definition);
    const hash = crypto.createHash('sha256').update(serialized).digest('hex');
    return this.transaction(async tx => {
      const result = await tx.request().input('hash', sql.Char(64), hash).input('json', sql.NVarChar(sql.MAX), serialized).query(`
        UPDATE pcn.MasterDataVersions WITH (UPDLOCK,HOLDLOCK) SET IsActive=0 WHERE IsActive=1;
        IF NOT EXISTS(SELECT 1 FROM pcn.MasterDataVersions WHERE DefinitionHash=@hash)
          INSERT pcn.MasterDataVersions(DefinitionHash,DefinitionJson,IsActive) VALUES(@hash,@json,1);
        ELSE UPDATE pcn.MasterDataVersions SET IsActive=1 WHERE DefinitionHash=@hash;
        SELECT Id FROM pcn.MasterDataVersions WHERE DefinitionHash=@hash;`);
      return result.recordset[0].Id;
    });
  }

  async readiness() {
    const required = ['PcnRequests', 'PcnInternalReviews', ...Object.values(childTables), 'PcnCounters', 'AuditLogs', 'NotificationSettings', 'NotificationGroups', 'NotificationRecipients', 'MasterDataVersions', 'Users', 'Roles', 'UserRoles', 'Sessions', 'AccountTokens', 'MigrationSourceRecords', 'NotificationJobs', 'PcnDocumentFiles'];
    const result = await this.pool.request().query(`SELECT MigrationId FROM pcn.SchemaMigrations; SELECT TOP(1) Id FROM pcn.MasterDataVersions WHERE IsActive=1; SELECT TOP(1) Id FROM pcn.Users WHERE IsActive=1;
      SELECT COUNT(*) AS TableCount FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=N'pcn' AND t.name IN (${required.map(name => `N'${name}'`).join(',')})`);
    const applied = new Set(result.recordsets[0].map(row => row.MigrationId));
    const missing = migrationManifest.filter(name => !applied.has(name));
    if (missing.length || !result.recordsets[1].length || !result.recordsets[2].length || result.recordsets[3]?.[0]?.TableCount !== required.length) throw new ApiError(503, 'SQL database initialization is incomplete');
    return { ready: true, migrations: migrationManifest.length };
  }

  async raiseCounter(tx, code) {
    const match = /^PCN-(\d{4})-(\d{4})$/.exec(code);
    if (!match) return;
    await tx.request().input('year', sql.Int, Number(match[1])).input('sequence', sql.Int, Number(match[2])).query(`
      IF NOT EXISTS(SELECT 1 FROM pcn.PcnCounters WITH (UPDLOCK,HOLDLOCK) WHERE Year=@year)
        INSERT pcn.PcnCounters(Year,LastSequence) VALUES(@year,@sequence);
      ELSE UPDATE pcn.PcnCounters SET LastSequence=CASE WHEN LastSequence<@sequence THEN @sequence ELSE LastSequence END WHERE Year=@year;`);
  }

  async importDatabase(database, { source = 'json' } = {}) {
    // One transaction preserves source evidence and imported aggregates; this never calls a mailer.
    return this.transaction(async tx => {
      let summary = { imported: 0, skipped: 0, audits: 0 };
      for (const [code, record] of Object.entries(database.pcnRequests || {})) {
        assertCode(code);
        if (record.id && record.id !== code) throw new Error(`Import code mismatch: ${code}`);
        const raw = JSON.stringify(record);
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const key = `${source}:${code}`;
        const prior = await tx.request().input('key', sql.NVarChar(256), key)
          .query('SELECT SourceHash FROM pcn.MigrationSourceRecords WITH (UPDLOCK,HOLDLOCK) WHERE SourceKey=@key');
        if (prior.recordset.length) {
          if (prior.recordset[0].SourceHash !== hash) throw new Error(`Imported source changed: ${code}`);
          summary = { ...summary, skipped: summary.skipped + 1 };
          continue;
        }
        const exists = await tx.request().input('code', sql.NVarChar(32), code).query('SELECT PcnId FROM pcn.PcnRequests WITH (UPDLOCK,HOLDLOCK) WHERE PcnCode=@code');
        if (exists.recordset.length) throw new Error(`Import would overwrite existing PCN: ${code}`);
        const parent = await this.writeParent(tx, { ...record, id: code });
        await this.writeChildren(tx, parent.PcnId, record);
        await this.raiseCounter(tx, code);
        await tx.request().input('key', sql.NVarChar(256), key).input('hash', sql.Char(64), hash).input('json', sql.NVarChar(sql.MAX), raw)
          .query('INSERT pcn.MigrationSourceRecords(SourceKey,SourceHash,SourceJson) VALUES(@key,@hash,@json)');
        summary = { ...summary, imported: summary.imported + 1 };
      }
      for (const [index, event] of (database.auditLogs || []).entries()) {
        const original = { ...event, id: event.id || crypto.createHash('sha256').update(`${source}:audit:${index}:${JSON.stringify(event)}`).digest('hex') };
        await this.audit(tx, event.pcnId, event.action, event.actor || 'legacy', event.metadata, original);
        await this.raiseCounter(tx, event.pcnId);
        summary = { ...summary, audits: summary.audits + 1 };
      }
      for (const [year, sequence] of Object.entries(database.counters?.pcn_years || database.counters || {})) {
        if (!/^\d{4}$/.test(year) || !Number.isInteger(Number(sequence)) || Number(sequence) < 0 || Number(sequence) > 9999) throw new Error('Invalid imported yearly counter');
        await this.raiseCounter(tx, `PCN-${year}-${String(sequence).padStart(4, '0')}`);
      }
      if (database.notificationSettings) {
        const raw = JSON.stringify(database.notificationSettings);
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const key = `${source}:notification-settings`;
        const prior = await tx.request().input('key', sql.NVarChar(256), key)
          .query('SELECT SourceHash FROM pcn.MigrationSourceRecords WITH (UPDLOCK,HOLDLOCK) WHERE SourceKey=@key');
        if (prior.recordset.length) {
          if (prior.recordset[0].SourceHash !== hash) throw new Error('Imported notification settings source changed');
        } else {
          const existing = await tx.request().query('SELECT SettingsJson FROM pcn.NotificationSettings WITH (UPDLOCK,HOLDLOCK) WHERE Id=1');
          if (existing.recordset.length && existing.recordset[0].SettingsJson !== raw) throw new Error('Imported notification settings conflict with existing SQL routing');
          if (!existing.recordset.length) await this.writeSettings(tx, database.notificationSettings);
          await tx.request().input('key', sql.NVarChar(256), key).input('hash', sql.Char(64), hash).input('json', sql.NVarChar(sql.MAX), raw)
            .query('INSERT pcn.MigrationSourceRecords(SourceKey,SourceHash,SourceJson) VALUES(@key,@hash,@json)');
        }
      }
      return summary;
    });
  }
}

function actorName(actor) { return typeof actor === 'string' ? actor : String(actor?.id || actor?.username || 'system'); }
function assertCode(code) { if (!/^PCN-\d{4}-\d{4}$/.test(code)) throw new ApiError(400, 'Invalid PCN code'); }
function typeFor(column) {
  if (column === 'OwnerUserId') return sql.UniqueIdentifier;
  if (column === 'MasterDataVersionId') return sql.Int;
  if (['CreatedAt', 'UpdatedAt', 'SubmittedAt'].includes(column)) return sql.DateTime2(3);
  return sql.NVarChar(sql.MAX);
}
function sqlValue(column, value) {
  if (value === undefined || value === null) return null;
  if (['CreatedAt', 'UpdatedAt', 'SubmittedAt'].includes(column)) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid machine timestamp: ${column}`);
    return parsed;
  }
  return value;
}
const textType = sql.NVarChar(sql.MAX);
const eventColumns = [['LegacyId', sql.NVarChar(128), 'id'], ['Role', sql.NVarChar(80), 'role'], ['Comment', textType, 'comment'], ['CreatedAt', sql.DateTime2(3), 'createdAt']];
const childColumns = {
  changeRows: [['Risk', sql.NVarChar(10), 'risk'], ['OptionText', textType, 'optionText'], ['Text', textType, 'text'], ['CurrentCondition', textType, 'currentCondition'], ['NewCondition', textType, 'newCondition']],
  documents: [['Name', textType, 'name'], ['Required', sql.Bit, 'required'], ['Uploaded', sql.Bit, 'uploaded']],
  route: [['OwnerSnapshot', textType, 'value']],
  comments: eventColumns,
  approvals: [...eventColumns, ['Decision', sql.NVarChar(40), 'decision']]
};
function childValue(value, column, field) {
  const input = column === 'OptionText' ? value?.optionText ?? value?.originalText : value?.[field];
  if (input === undefined || input === null) return null;
  if (column === 'Required' || column === 'Uploaded') {
    if (input === true || input === 'true') return true;
    if (input === false || input === 'false') return false;
    return null;
  }
  if (column === 'CreatedAt') {
    const parsed = new Date(input);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return ['string', 'number', 'boolean'].includes(typeof input) ? String(input) : null;
}

module.exports = { SqlPcnRepository, emptySettings };
