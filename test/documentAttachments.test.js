const test = require('node:test');
const assert = require('node:assert/strict');
const { SqlDocuments } = require('../src/sqlDocuments');

const code = 'PCN-2026-0001';
const id = '00000000-0000-0000-0000-000000000001';

function readPool(recordset) {
  const calls = [];
  return { calls, request() {
    const inputs = {};
    return { input(name, type, value) { inputs[name] = value; return this; }, async query(statement) {
      calls.push({ inputs, statement });
      return { recordset };
    } };
  } };
}

test('attachment listing exposes metadata without bytes and excludes deleted files', async () => {
  const uploadedAt = new Date('2026-10-09T01:00:00Z');
  const db = readPool([{ Id: id, FileName: 'report.pdf', ContentType: 'application/pdf', SizeBytes: 12,
    ScanStatus: 'pendingScan', UploadedBy: 'Employee Name', UploadedAt: uploadedAt, ContentRevision: 3,
    RequirementName: 'hazardousReport' }]);
  assert.deepEqual(await new SqlDocuments(db).list(code), [{ id, fileName: 'report.pdf',
    contentType: 'application/pdf', sizeBytes: 12, scanStatus: 'pendingScan', uploadedBy: 'Employee Name',
    uploadedAt: uploadedAt.toISOString(), contentRevision: 3, requirementName: 'hazardousReport' }]);
  assert.match(db.calls[0].statement, /DeletedAt IS NULL/);
  assert.doesNotMatch(db.calls[0].statement, /\bBytes\b/);
  assert.equal(db.calls[0].inputs.pcnCode, code);
});

test('legacy attachment metadata is explicit and listing validates the PCN identifier', async () => {
  const db = readPool([{ Id: id, FileName: 'old.pdf', SizeBytes: 1, ScanStatus: 'clean' }]);
  const docs = new SqlDocuments(db);
  const [metadata] = await docs.list(code);
  assert.equal(metadata.uploadedBy, null);
  assert.equal(metadata.uploadedAt, null);
  assert.equal(metadata.contentRevision, 1);
  assert.equal(metadata.requirementName, null);
  await assert.rejects(docs.list('malformed'), { statusCode: 400 });
  assert.equal(db.calls.length, 1);
});

test('download retains quarantine checks and filters deleted attachments', async () => {
  const db = readPool([{ Id: id, ScanStatus: 'pendingScan' }]);
  await assert.rejects(new SqlDocuments(db).get(code, id), { statusCode: 423 });
  assert.match(db.calls[0].statement, /DeletedAt IS NULL/);
});
