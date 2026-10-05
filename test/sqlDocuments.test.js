const test = require('node:test');
const assert = require('node:assert/strict');
const { SqlDocuments } = require('../src/sqlDocuments');

const code = 'PCN-2026-0001';
const id = '00000000-0000-0000-0000-000000000001';
const version = '0000000000000001';
const nextVersion = '0000000000000002';
const user = { id, roles: ['supplier'] };
const context = { user, actor: `user:${id}`, version };
const parent = { PcnId: 1, OwnerUserId: id, Status: 'draft', RowVersion: Buffer.from(version, 'hex') };
const file = { fileName: 'report.pdf', contentType: 'application/pdf', base64: Buffer.from('%PDF-1.7\ncontent').toString('base64') };

function pool(results = []) {
  const calls = [];
  const request = () => {
    const inputs = {};
    return { input(name, type, value) { inputs[name] = value; return this; }, async query(statement) {
      calls.push({ statement, inputs });
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result || { recordset: [], rowsAffected: [1] };
    } };
  };
  return { calls, request, transaction() { return { request,
    async begin() { calls.push('begin'); }, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); } }; } };
}
const rows = value => ({ recordset: [value] });
const uploadResults = (p = parent, usage = { FileCount: 0, TotalBytes: 0 }) => [rows(p), rows(usage), {}, rows({ RowVersion: Buffer.from(nextVersion, 'hex') }), {}];

test('document insert locks its parent, stores quarantined bytes, audits and returns committed version', async () => {
  const db = pool(uploadResults());
  const result = await new SqlDocuments(db).save(code, file, context);
  assert.equal(result.version, nextVersion);
  assert.equal(result.scanStatus, 'pendingScan');
  const queries = db.calls.filter(call => typeof call === 'object');
  assert.match(queries[0].statement, /UPDLOCK, HOLDLOCK/);
  assert.match(queries[0].statement, /DeletedAt IS NULL/);
  assert.equal(queries[0].inputs.pcnCode, code);
  assert.deepEqual(queries[2].inputs.bytes, Buffer.from(file.base64, 'base64'));
  assert.match(queries[3].statement, /UpdatedAt=SYSUTCDATETIME\(\)/);
  assert.match(queries[4].statement, /INSERT pcn.AuditLogs/);
  assert.equal(queries[4].inputs.actor, `user:${id}`);
  assert.equal(queries[4].inputs.action, 'document_added');
  assert.equal(db.calls.at(-1), 'commit');
});

test('document mutations reject missing or stale versions before writing any file', async () => {
  const db = pool([rows(parent), rows(parent)]);
  const docs = new SqlDocuments(db);
  await assert.rejects(docs.save(code, file, { ...context, version: undefined }), { statusCode: 400 });
  await assert.rejects(docs.save(code, file, { ...context, version: nextVersion }), { statusCode: 409 });
  await assert.rejects(docs.delete(code, id, { ...context, version: nextVersion }), { statusCode: 409 });
  assert.equal(db.calls.filter(call => call.statement?.includes('INSERT pcn.PcnDocumentFiles')).length, 0);
  assert.equal(db.calls.at(-1), 'rollback');
});

test('locked parent ownership and stage controls prevent edits after a concurrent workflow change', async () => {
  for (const status of ['approved', 'rejected', 'closed']) {
    for (const method of ['save', 'delete']) {
      const db = pool([rows({ ...parent, Status: status })]);
      const docs = new SqlDocuments(db);
      await assert.rejects(docs[method](code, method === 'save' ? file : id,
        { ...context, user: { id, roles: ['admin'] } }), { statusCode: 403 });
      assert.equal(db.calls.at(-1), 'rollback');
    }
  }
  for (const [p, expected] of [[{ ...parent, Status: 'submitted' }, 403], [{ ...parent, OwnerUserId: 'another-owner' }, 404], [null, 404]]) {
    const db = pool([{ recordset: p ? [p] : [] }]);
    await assert.rejects(new SqlDocuments(db).save(code, file, context), { statusCode: expected });
    assert.equal(db.calls.at(-1), 'rollback');
  }
});

test('document quota is enforced under the same lock for count and aggregate byte limits', async () => {
  for (const usage of [{ FileCount: 20, TotalBytes: 0 }, { FileCount: 2, TotalBytes: 50 * 1024 * 1024 }]) {
    const db = pool([rows(parent), rows(usage)]);
    await assert.rejects(new SqlDocuments(db).save(code, file, context), { statusCode: 413 });
    assert.equal(db.calls.at(-1), 'rollback');
    assert.equal(db.calls.filter(call => call.statement?.includes('INSERT pcn.PcnDocumentFiles')).length, 0);
  }
});

test('delete requires a scoped file and audits removal in the transaction', async () => {
  const db = pool([rows(parent), { rowsAffected: [1] }, rows({ RowVersion: Buffer.from(nextVersion, 'hex') }), {}]);
  assert.deepEqual(await new SqlDocuments(db).delete(code, id, context), { id, version: nextVersion });
  const queries = db.calls.filter(call => typeof call === 'object');
  assert.match(queries[1].statement, /Id=@id AND PcnCode=@pcnCode/);
  assert.equal(queries[3].inputs.action, 'document_deleted');
  assert.equal(db.calls.at(-1), 'commit');
  const missing = pool([rows(parent), { rowsAffected: [0] }]);
  await assert.rejects(new SqlDocuments(missing).delete(code, id, context), { statusCode: 404 });
  assert.equal(missing.calls.at(-1), 'rollback');
});

test('an audit failure rolls back file write and parent version together', async () => {
  const results = uploadResults();
  results[4] = new Error('audit failed');
  const db = pool(results);
  await assert.rejects(new SqlDocuments(db).save(code, file, context), /audit failed/);
  assert.equal(db.calls.at(-1), 'rollback');
});

test('file validation rejects dangerous filenames, inherited types, encodings and mismatched signatures', async () => {
  const docs = new SqlDocuments(pool());
  for (const input of [null, [], { ...file, fileName: '../report.pdf' }, { ...file, contentType: '__proto__' },
    { ...file, contentType: ['application/pdf'] }, { ...file, fileName: 'constructor', contentType: 'constructor' },
    { ...file, base64: '%%%=' }, { ...file, base64: Buffer.from('invalid pdf').toString('base64') },
    { ...file, base64: 'YR==' }, { ...file, base64: '' }]) {
    await assert.rejects(docs.save(code, input, context), { statusCode: 400 });
  }
  await assert.rejects(docs.save('wrong', file, context), { statusCode: 400 });
  await assert.rejects(docs.delete(code, 'bad-id', context), { statusCode: 400 });
});

test('valid supported signatures and maximum single upload remain accepted', async () => {
  const cases = [
    { fileName: 'report.png', contentType: 'image/png', base64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') },
    { fileName: 'report.jpeg', contentType: 'image/jpeg', base64: Buffer.from('ffd8ff', 'hex').toString('base64') },
    { fileName: 'report.txt', contentType: 'text/plain', base64: Buffer.alloc(10 * 1024 * 1024, 65).toString('base64') }
  ];
  for (const input of cases) assert.equal((await new SqlDocuments(pool(uploadResults())).save(code, input,
    { ...context, user: { id, roles: ['admin'] } })).contentType, input.contentType);
});

test('downloads require clean scan status and missing files are explicit', async () => {
  const clean = { Id: id, ScanStatus: 'clean', Bytes: Buffer.from('safe') };
  const docs = new SqlDocuments(pool([rows(clean), rows({ ScanStatus: 'pendingScan' }), { recordset: [] }]));
  assert.equal(await docs.get(code, id), clean);
  await assert.rejects(docs.get(code, id), { statusCode: 423 });
  await assert.rejects(docs.get(code, id), { statusCode: 404 });
});
