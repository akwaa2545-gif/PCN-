const crypto = require('node:crypto');
const sql = require('mssql');
const { ApiError } = require('./apiError');
const { assertRecordAccess, isInternal } = require('./workflowAccess');
const { versionHex } = require('./sqlPcnHydration');
const { SqlPcnRepository } = require('./sqlPcnRepository');
const { SqlRevisions } = require('./sqlRevisions');
const { applyDocumentControl, hasSignatures } = require('./documentControl');
const { documentRequirements } = require('./documentRequirements');
const { lockUserMailRouting, assertCurrentUser } = require('./userMailRouting');

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
  constructor(pool, { scanner = null } = {}) {
    if (scanner !== null && typeof scanner?.scan !== 'function') throw new Error('Invalid trusted attachment scanner');
    this.pool = pool; this.scanner = scanner; this.repository = new SqlPcnRepository(pool); this.revisions = new SqlRevisions();
  }
  async list(pcnCode) {
    assertCode(pcnCode);
    return this.listFrom(this.pool, pcnCode);
  }
  async listFrom(source, pcnCode) {
    const result = await source.request().input('pcnCode', sql.NVarChar(32), pcnCode)
      .query(`SELECT Id,FileName,ContentType,SizeBytes,ScanStatus,UploadedBy,UploadedAt,ContentRevision,RequirementName
        FROM pcn.PcnDocumentFiles WHERE PcnCode=@pcnCode AND DeletedAt IS NULL ORDER BY UploadedAt,Id`);
    return result.recordset.map(documentMetadata);
  }
  async save(pcnCode, input, context) {
    assertCode(pcnCode);
    const file = validateFile(input);
    let scanStatus = 'pendingScan';
    if (this.scanner) {
      try {
        if (await this.scanner.scan(file.bytes) !== 'clean') throw new Error('Attachment scanner did not clear the file');
        scanStatus = 'clean';
      } catch {
        throw new ApiError(503, 'Attachment could not be cleared by malware scanning; upload was rejected');
      }
    }
    const id = crypto.randomUUID();
    return this.mutate(pcnCode, context, async (tx, current, attachments, contentRevision, now) => {
      const requirementName = validateRequirement(input.requirementName, current);
      const uploadedBy = String(context.user.displayName || context.user.username || context.user.employeeCode || `user:${context.user.id}`).slice(0, 256);
      const usage = (await tx.request().input('pcnCode', sql.NVarChar(32), pcnCode)
        .query('SELECT COUNT(*) AS FileCount,COALESCE(SUM(CAST(SizeBytes AS bigint)),0) AS TotalBytes FROM pcn.PcnDocumentFiles WHERE PcnCode=@pcnCode AND DeletedAt IS NULL')).recordset[0];
      if (usage.FileCount >= 20 || Number(usage.TotalBytes) + file.bytes.length > 50 * 1024 * 1024) {
        throw new ApiError(413, 'PCN attachments are limited to 20 files and 50 MiB in total');
      }
      await tx.request().input('id', sql.UniqueIdentifier, id).input('pcnCode', sql.NVarChar(32), pcnCode)
        .input('name', sql.NVarChar(255), file.fileName).input('type', sql.NVarChar(100), file.contentType)
        .input('bytes', sql.VarBinary(sql.MAX), file.bytes).input('size', sql.Int, file.bytes.length)
        .input('uploadedBy', sql.NVarChar(256), uploadedBy).input('uploadedAt', sql.DateTime2(3), new Date(now))
        .input('contentRevision', sql.Int, contentRevision).input('requirementName', sql.NVarChar(sql.MAX), requirementName)
        .input('scanStatus', sql.NVarChar(32), scanStatus)
        .query(`INSERT pcn.PcnDocumentFiles(Id,PcnCode,FileName,ContentType,Bytes,SizeBytes,ScanStatus,UploadedBy,UploadedAt,ContentRevision,RequirementName)
          VALUES(@id,@pcnCode,@name,@type,@bytes,@size,@scanStatus,@uploadedBy,@uploadedAt,@contentRevision,@requirementName);`);
      const document = { id, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.bytes.length,
        scanStatus, uploadedBy, uploadedAt: now, contentRevision, requirementName };
      return { document, attachments: [...attachments, document] };
    }, 'document_added');
  }
  async get(pcnCode, id) {
    assertCode(pcnCode); assertId(id);
    const result = await this.pool.request().input('id', sql.UniqueIdentifier, id).input('pcnCode', sql.NVarChar(32), pcnCode)
        .query('SELECT Id,FileName,ContentType,Bytes,SizeBytes,ScanStatus FROM pcn.PcnDocumentFiles WHERE Id=@id AND PcnCode=@pcnCode AND DeletedAt IS NULL');
    const file = result.recordset[0];
    if (!file) throw new ApiError(404, 'Document not found');
    if (file.ScanStatus !== 'clean') throw new ApiError(423, 'Document download requires a trusted malware scan');
    return file;
  }
  async delete(pcnCode, id, context) {
    assertCode(pcnCode); assertId(id);
    return this.mutate(pcnCode, context, async (tx, current, attachments) => {
      const result = await tx.request().input('id', sql.UniqueIdentifier, id).input('pcnCode', sql.NVarChar(32), pcnCode)
        .query('UPDATE pcn.PcnDocumentFiles SET DeletedAt=SYSUTCDATETIME() WHERE Id=@id AND PcnCode=@pcnCode AND DeletedAt IS NULL');
      if (!result.rowsAffected[0]) throw new ApiError(404, 'Document not found');
      return { document: { id }, attachment: attachments.find(file => file.id === id), attachments: attachments.filter(file => file.id !== id) };
    }, 'document_deleted');
  }

  async mutate(pcnCode, context, work, action) {
    if (typeof context?.version !== 'string' || !/^[a-fA-F0-9]{16}$/.test(context.version)) {
      throw new ApiError(400, 'The current PCN version is required');
    }
    const tx = this.pool.transaction();
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      await lockUserMailRouting(tx);
      await assertCurrentUser(tx, context.user);
      const parent = (await tx.request().input('pcnCode', sql.NVarChar(32), pcnCode)
        .query('SELECT * FROM pcn.PcnRequests WITH (UPDLOCK, HOLDLOCK) WHERE PcnCode=@pcnCode AND DeletedAt IS NULL')).recordset[0];
      assertRecordAccess(parent ? { ownerUserId: parent.OwnerUserId } : null, context.user);
      if (versionHex(parent.RowVersion) !== context.version.toLowerCase()) throw new ApiError(409, 'PCN changed since it was loaded; reload before saving');
      if (['approved','rejected','closed'].includes(parent.Status) || !isInternal(context.user) && !['draft','supplier_action'].includes(parent.Status)) {
        throw new ApiError(403, 'Document edits are not allowed at this stage');
      }
      const aggregate = await this.repository.readAggregate(tx, parent);
      if (hasSignatures(aggregate)) throw new ApiError(409, 'Start a new revision before changing signed document attachments');
      const attachments = await this.listFrom(tx, pcnCode);
      const current = { ...aggregate, documentAttachments: attachments };
      const now = new Date().toISOString();
      const proposed = { ...current, updatedAt: now, documentControl: { ...(current.documentControl || {}),
        attachmentGeneration: (current.documentControl?.attachmentGeneration || 0) + 1 } };
      const controlled = applyDocumentControl(current, proposed, context.user, now);
      const mutation = await work(tx, current, attachments, controlled.documentControl.contentRevision, now);
      const next = { ...controlled, documentAttachments: mutation.attachments };
      const changed = await this.repository.writeParent(tx, next, parent.PcnId);
      const document = mutation.document;
      await tx.request().input('auditId', sql.NVarChar(128), crypto.randomUUID()).input('pcnCode', sql.NVarChar(128), pcnCode)
        .input('action', sql.NVarChar(80), action).input('actor', sql.NVarChar(256), `user:${context.user.id}`)
        .input('metadata', sql.NVarChar(sql.MAX), JSON.stringify({ ...(mutation.attachment || document), documentId: document.id,
          contentRevision: next.documentControl.contentRevision }))
        .query('INSERT pcn.AuditLogs(Id,PcnCode,Action,Actor,MetadataJson,CreatedAt) VALUES(@auditId,@pcnCode,@action,@actor,@metadata,SYSUTCDATETIME())');
      await this.revisions.append(tx, pcnCode, current, { ...next, version: versionHex(changed.RowVersion) }, context.user);
      await tx.commit();
      return { ...document, version: versionHex(changed.RowVersion) };
    } catch (error) {
      try { await tx.rollback(); } catch { /* Preserve the original error after automatic SQL rollback. */ }
      throw error;
    }
  }
}

function validateRequirement(value, record) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ApiError(400, 'Select a requested document category');
  const requirement = documentRequirements.find(item => item.key === value || item.label === value);
  if (!requirement || record.internalReview?.docs?.[requirement.key] !== true) {
    throw new ApiError(400, 'This document category is not requested for the PCN');
  }
  return requirement.key;
}

function documentMetadata(row) {
  return { id: row.Id, fileName: row.FileName, contentType: row.ContentType, sizeBytes: row.SizeBytes,
    scanStatus: row.ScanStatus, uploadedBy: row.UploadedBy || null,
    uploadedAt: row.UploadedAt instanceof Date ? row.UploadedAt.toISOString() : row.UploadedAt || null,
    contentRevision: row.ContentRevision || 1, requirementName: row.RequirementName || null };
}

module.exports = { SqlDocuments };
