const sql = require('mssql');
const { fieldChanges, snapshot } = require('./documentControl');

class SqlRevisions {
  async append(tx, code, before, after, actor) {
    const result = await tx.request().input('code', sql.NVarChar(32), code)
      .query('SELECT COALESCE(MAX(Revision),0) AS Revision FROM pcn.PcnRevisions WITH (UPDLOCK,HOLDLOCK) WHERE PcnCode=@code');
    const revision = Number(result.recordset[0]?.Revision || 0);
    if (!revision && before) await this.insert(tx, code, 1, before, 'Legacy baseline', [], true);
    await this.insert(tx, code, revision + (!revision && before ? 2 : 1), after, actor, fieldChanges(before ? snapshot(before) : {}, snapshot(after)), false);
  }

  async insert(tx, code, revision, record, actor, changes, baseline) {
    await tx.request().input('code', sql.NVarChar(32), code).input('revision', sql.Int, revision)
      .input('contentRevision', sql.Int, record.documentControl?.contentRevision || 1)
      .input('actor', sql.NVarChar(256), String(typeof actor === 'object' ? actor?.displayName || actor?.id || 'system' : actor || 'system').slice(0, 256))
      .input('status', sql.NVarChar(40), record.status || 'draft')
      .input('changes', sql.NVarChar(sql.MAX), JSON.stringify(changes))
      .input('snapshot', sql.NVarChar(sql.MAX), JSON.stringify(snapshot(record)))
      .input('baseline', sql.Bit, baseline)
      .query('INSERT pcn.PcnRevisions(PcnCode,Revision,ContentRevision,Actor,Status,ChangesJson,SnapshotJson,IsBaseline) VALUES(@code,@revision,@contentRevision,@actor,@status,@changes,@snapshot,@baseline)');
  }

  async list(source, code) {
    const result = await source.request().input('code', sql.NVarChar(32), code)
      .query('SELECT Revision,ContentRevision,Actor,CreatedAt,Status,ChangesJson,IsBaseline FROM pcn.PcnRevisions WHERE PcnCode=@code ORDER BY Revision DESC');
    return result.recordset.map(row => hydrate(row));
  }

  async get(source, code, revision) {
    const result = await source.request().input('code', sql.NVarChar(32), code).input('revision', sql.Int, revision)
      .query('SELECT Revision,ContentRevision,Actor,CreatedAt,Status,ChangesJson,SnapshotJson,IsBaseline FROM pcn.PcnRevisions WHERE PcnCode=@code AND Revision=@revision');
    return result.recordset[0] ? hydrate(result.recordset[0], true) : null;
  }
}

function hydrate(row, detail = false) {
  return { revision: row.Revision, contentRevision: row.ContentRevision, actor: row.Actor,
    createdAt: row.CreatedAt instanceof Date ? row.CreatedAt.toISOString() : row.CreatedAt,
    status: row.Status, changes: JSON.parse(row.ChangesJson), isBaseline: Boolean(row.IsBaseline),
    ...(detail ? { snapshot: JSON.parse(row.SnapshotJson) } : {}) };
}

module.exports = { SqlRevisions };
