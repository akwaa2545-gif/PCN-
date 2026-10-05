const crypto = require('node:crypto');
const sql = require('mssql');
const { ApiError } = require('./apiError');
const { assertRecordAccess, isInternal } = require('./workflowAccess');
const { versionHex } = require('./sqlPcnHydration');

const maxBytes = 10 * 1024 * 1024;
const types = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'text/plain': '.txt' };
function assertCode(code) { if (!/^PCN-\d{4}-\d{4}$/.test(code)) throw new ApiError(400, 'Invalid PCN id'); }
function assertId(id) { if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new ApiError(400, 'Invalid document id'); }
function validateFile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'Document body must be an object');
  const { fileName, contentType, base64 } = input;
  if (typeof fileName !== 'string' || !fileName || fileName.length > 255 || /[\\/\x00-\x1f]/.test(fileName)) throw new ApiError(400, 'Invalid file name');
  if (typeof contentType !== 'string' || !Object.hasOwn(types, contentType) || !fileName.toLowerCase().endsWith(types[contentType]) && !(contentType === 'image/jpeg' && fileName.toLowerCase().endsWith('.jpeg'))) throw new ApiError(400, 'Unsupported file type');
  if (typeof base64 !== 'string' || !base64.length || base64.length > Math.ceil(maxBytes / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new ApiError(400, 'Invalid or oversized document data');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) throw new ApiError(400, 'Invalid document encoding');
  if (!bytes.length || bytes.length > maxBytes) throw new ApiError(413, 'Document exceeds 10 MiB');
  const valid = contentType === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-'
    : contentType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : contentType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : !bytes.includes(0) && Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
  if (!valid) throw new ApiError(400, 'File signature does not match the selected type');
  return { bytes, fileName, contentType };
}

class SqlDocuments {
  constructor(pool) { this.pool = pool; }
  async save(pcnCode, input, context) {
    assertCode(pcnCode);
    const file = validateFile(input);
    const id = crypto.randomUUID();
    return this.mutate(pcnCode, context, async tx => {
      const usage = (await tx.request().input('pcnCode', sql.NVarChar(32), pcnCode)
        .query('SELECT COUNT(*) AS FileCount,COALESCE(SUM(CAST(SizeBytes AS bigint)),0) AS TotalBytes FROM pcn.PcnDocumentFiles WHERE PcnCode=@pcnCode')).recordset[0];
      if (usage.FileCount >= 20 || Number(usage.TotalBytes) + file.bytes.length > 50 * 1024 * 1024) {
        throw new ApiError(413, 'PCN attachments are limited to 20 files and 50 MiB in total');
      }
      await tx.request().input('id', sql.UniqueIdentifier, id).input('pcnCode', sql.NVarChar(32), pcnCode)
        .input('name', sql.NVarChar(255), file.fileName).input('type', sql.NVarChar(100), file.contentType)
        .input('bytes', sql.VarBinary(sql.MAX), file.bytes).input('size', sql.Int, file.bytes.length)
        .query(`INSERT pcn.PcnDocumentFiles(Id,PcnCode,FileName,ContentType,Bytes,SizeBytes,ScanStatus)
          VALUES(@id,@pcnCode,@name,@type,@bytes,@size,N'pendingScan');`);
      return { id, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.bytes.length, scanStatus: 'pendingScan' };
    }, 'document_added');
  }
  async get(pcnCode, id) {
    assertCode(pcnCode); assertId(id);
    const result = await this.pool.request().input('id', sql.UniqueIdentifier, id).input('pcnCode', sql.NVarChar(32), pcnCode)
      .query('SELECT Id,FileName,ContentType,Bytes,SizeBytes,ScanStatus FROM pcn.PcnDocumentFiles WHERE Id=@id AND PcnCode=@pcnCode');
    const file = result.recordset[0];
    if (!file) throw new ApiError(404, 'Document not found');
    if (file.ScanStatus !== 'clean') throw new ApiError(423, 'Document download requires a trusted malware scan');
    return file;
  }
  async delete(pcnCode, id, context) {
    assertCode(pcnCode); assertId(id);
    return this.mutate(pcnCode, context, async tx => {
      const result = await tx.request().input('id', sql.UniqueIdentifier, id).input('pcnCode', sql.NVarChar(32), pcnCode)
        .query('DELETE pcn.PcnDocumentFiles WHERE Id=@id AND PcnCode=@pcnCode');
      if (!result.rowsAffected[0]) throw new ApiError(404, 'Document not found');
      return { id };
    }, 'document_deleted');
  }

  async mutate(pcnCode, context, work, action) {
    if (typeof context?.version !== 'string' || !/^[a-fA-F0-9]{16}$/.test(context.version)) {
      throw new ApiError(400, 'The current PCN version is required');
    }
    const tx = this.pool.transaction();
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      const parent = (await tx.request().input('pcnCode', sql.NVarChar(32), pcnCode)
        .query('SELECT PcnId,OwnerUserId,Status,RowVersion FROM pcn.PcnRequests WITH (UPDLOCK, HOLDLOCK) WHERE PcnCode=@pcnCode AND DeletedAt IS NULL')).recordset[0];
      assertRecordAccess(parent ? { ownerUserId: parent.OwnerUserId } : null, context.user);
      if (versionHex(parent.RowVersion) !== context.version.toLowerCase()) throw new ApiError(409, 'PCN changed since it was loaded; reload before saving');
      if (['approved','rejected','closed'].includes(parent.Status) || !isInternal(context.user) && !['draft','supplier_action'].includes(parent.Status)) {
        throw new ApiError(403, 'Document edits are not allowed at this stage');
      }
      const document = await work(tx);
      const changed = (await tx.request().input('pcnId', sql.BigInt, parent.PcnId)
        .query('UPDATE pcn.PcnRequests SET UpdatedAt=SYSUTCDATETIME() OUTPUT inserted.RowVersion WHERE PcnId=@pcnId')).recordset[0];
      await tx.request().input('auditId', sql.NVarChar(128), crypto.randomUUID()).input('pcnCode', sql.NVarChar(128), pcnCode)
        .input('action', sql.NVarChar(80), action).input('actor', sql.NVarChar(256), `user:${context.user.id}`)
        .input('metadata', sql.NVarChar(sql.MAX), JSON.stringify({ documentId: document.id, fileName: document.fileName, sizeBytes: document.sizeBytes }))
        .query('INSERT pcn.AuditLogs(Id,PcnCode,Action,Actor,MetadataJson,CreatedAt) VALUES(@auditId,@pcnCode,@action,@actor,@metadata,SYSUTCDATETIME())');
      await tx.commit();
      return { ...document, version: versionHex(changed.RowVersion) };
    } catch (error) {
      try { await tx.rollback(); } catch { /* Preserve the original error after automatic SQL rollback. */ }
      throw error;
    }
  }
}

module.exports = { SqlDocuments };
