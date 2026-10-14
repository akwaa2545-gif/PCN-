const sql = require('mssql');
const { fieldChanges, snapshot } = require('./documentControl');
const { ApiError } = require('./apiError');
const { versionHex } = require('./sqlPcnHydration');

class SqlRevisions {
  async statusTimings(source, codes) {
    if (!Array.isArray(codes) || codes.some(code => typeof code !== 'string' || !/^PCN-\d{4}-\d{4}$/.test(code))) {
      throw new ApiError(400, 'Invalid PCN ids');
    }
    const uniqueCodes = [...new Set(codes)];
    let entries = [];
    for (let offset = 0; offset < uniqueCodes.length; offset += 400) {
      const batch = uniqueCodes.slice(offset, offset + 400);
      const parameters = batch.map((_, index) => `@code${index}`).join(',');
      const request = batch.reduce((current, code, index) => current.input(`code${index}`, sql.NVarChar(32), code), source.request());
      const result = await request.query(`WITH history AS (
        SELECT PcnCode,Revision,Status,CreatedAt,IsBaseline,LAG(Status) OVER(PARTITION BY PcnCode ORDER BY Revision) AS PreviousStatus
        FROM pcn.PcnRevisions WHERE PcnCode IN (${parameters})
      ) SELECT p.PcnCode,p.RowVersion,p.Status,t.CreatedAt AS Since FROM pcn.PcnRequests p
        OUTER APPLY (SELECT TOP (1) h.CreatedAt FROM history h WHERE h.PcnCode=p.PcnCode AND h.Status=p.Status
          AND h.IsBaseline=0 AND (h.PreviousStatus<>h.Status OR h.Revision=1)
          AND NOT EXISTS (SELECT 1 FROM history newer WHERE newer.PcnCode=h.PcnCode AND newer.Revision>h.Revision AND newer.Status<>p.Status)
          ORDER BY h.Revision DESC) t
        WHERE p.DeletedAt IS NULL AND p.PcnCode IN (${parameters})`);
      entries = [...entries, ...result.recordset.map(row => [row.PcnCode, { parentVersion: versionHex(row.RowVersion), status: row.Status,
        since: row.Since instanceof Date ? row.Since.toISOString() : row.Since || null }])];
    }
    return new Map(entries);
  }
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
