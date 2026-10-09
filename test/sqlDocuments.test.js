const test = require('node:test');
const assert = require('node:assert/strict');
const { SqlDocuments } = require('../src/sqlDocuments');

const code = 'PCN-2026-0001';
const id = '00000000-0000-0000-0000-000000000001';
const version = '0000000000000001';
const nextVersion = '0000000000000002';
const user = { id, roles: ['supplier'], version, sessionSecurityStamp: id };
const context = { user, actor: `user:${id}`, version };
const parent = { PcnId: 1, PcnCode: code, OwnerUserId: id, Status: 'draft', RowVersion: Buffer.from(version, 'hex'), LegacyExtrasJson: '{}' };
const file = { fileName: 'report.pdf', contentType: 'application/pdf', base64: Buffer.from('%PDF-1.7\ncontent').toString('base64') };

function pool(results = [], review = {}, attachments = [], currentUser = { IsActive: true, SecurityStamp: id, AccessVersion: Buffer.from(version, 'hex') }) {
  const calls = [];
  const request = () => {
    const inputs = {};
    return { input(name, type, value) { inputs[name] = value; return this; }, async query(statement) {
      calls.push({ statement, inputs });
      if (statement.includes('sys.sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
      if (statement.startsWith('SELECT IsActive,SecurityStamp,AccessVersion')) return { recordset: currentUser ? [currentUser] : [] };
      if (statement.startsWith('SELECT ReviewJson')) return { recordsets: [[{ ReviewJson: JSON.stringify(review) }], [], [], [], [], []] };
      if (statement.includes('FROM pcn.PcnRevisions')) return { recordset: [{ Revision: 1 }] };
      if (statement.includes('INSERT pcn.PcnRevisions')) return {};
      if (statement.includes('ORDER BY UploadedAt,Id')) return { recordset: attachments };
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
  const parentQuery = queries.find(query => query.statement.includes('FROM pcn.PcnRequests'));
  assert.match(parentQuery.statement, /UPDLOCK, HOLDLOCK/);
  assert.match(parentQuery.statement, /DeletedAt IS NULL/);
  assert.equal(parentQuery.inputs.pcnCode, code);
  const insert = queries.find(query => query.statement.includes('INSERT pcn.PcnDocumentFiles'));
  assert.deepEqual(insert.inputs.bytes, Buffer.from(file.base64, 'base64'));
  assert.match(queries.find(query => query.statement.startsWith('UPDATE pcn.PcnRequests')).statement, /UpdatedAt/);
  const audit = queries.find(query => query.statement.includes('INSERT pcn.AuditLogs'));
  assert.equal(audit.inputs.actor, `user:${id}`);
  assert.equal(audit.inputs.action, 'document_added');
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
        { ...context, user: { ...user, roles: ['admin'] } }), { statusCode: 403 });
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
  assert.match(queries.find(query => query.statement.startsWith('UPDATE pcn.PcnDocumentFiles')).statement, /Id=@id AND PcnCode=@pcnCode/);
  assert.equal(queries.find(query => query.statement.includes('INSERT pcn.AuditLogs')).inputs.action, 'document_deleted');
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
    { ...context, user: { ...user, roles: ['admin'] } })).contentType, input.contentType);
});

test('downloads require clean scan status and missing files are explicit', async () => {
  const clean = { Id: id, ScanStatus: 'clean', Bytes: Buffer.from('safe') };
  const docs = new SqlDocuments(pool([rows(clean), rows({ ScanStatus: 'pendingScan' }), { recordset: [] }]));
  assert.equal(await docs.get(code, id), clean);
  await assert.rejects(docs.get(code, id), { statusCode: 423 });
  await assert.rejects(docs.get(code, id), { statusCode: 404 });
});

test('uploads bind trusted identity and revision metadata to the locked PCN and append history atomically', async () => {
  const db = pool(uploadResults({ ...parent, LegacyExtrasJson: JSON.stringify({ documentControl: { contentRevision: 4, attachmentGeneration: 2 } }) }), { docs: { hazardousReport: true } });
  const result = await new SqlDocuments(db).save(code, { ...file, requirementName: 'hazardousReport', uploadedBy: 'Forged', contentRevision: 99 },
    { ...context, user: { ...user, displayName: 'Real Employee' } });
  assert.equal(result.uploadedBy, 'Real Employee');
  assert.equal(result.contentRevision, 5);
  assert.equal(result.requirementName, 'hazardousReport');
  assert.ok(Number.isFinite(Date.parse(result.uploadedAt)));
  const insert = db.calls.find(call => call.statement?.includes('INSERT pcn.PcnDocumentFiles'));
  assert.equal(insert.inputs.uploadedBy, 'Real Employee');
  assert.equal(insert.inputs.contentRevision, 5);
  assert.equal(insert.inputs.requirementName, 'hazardousReport');
  const history = db.calls.find(call => call.statement?.includes('INSERT pcn.PcnRevisions'));
  const snapshot = JSON.parse(history.inputs.snapshot);
  assert.equal(snapshot.documentControl.contentRevision, 5);
  assert.equal(snapshot.documentControl.attachmentGeneration, 3);
  assert.equal(snapshot.documentAttachments[0].id, result.id);
  assert.equal(snapshot.documentAttachments[0].uploadedBy, 'Real Employee');
  assert.equal(db.calls.at(-1), 'commit');
});

test('required-document association is validated against actual selected requests before file write', async () => {
  for (const requirementName of ['hazardousReport', 'unknown', '__proto__', {}, 'constructor']) {
    const db = pool([rows(parent)], { docs: { hazardousReport: false } });
    await assert.rejects(new SqlDocuments(db).save(code, { ...file, requirementName }, context), { statusCode: 400 });
    assert.equal(db.calls.filter(call => call.statement?.includes('INSERT pcn.PcnDocumentFiles')).length, 0);
  }
});

test('selected request labels become canonical categories and removal snapshots retain the other files', async () => {
  const { documentRequirements } = require('../src/documentRequirements');
  const upload = pool(uploadResults(), { docs: { hazardousReport: true } });
  const added = await new SqlDocuments(upload).save(code, { ...file, requirementName: documentRequirements[0].label }, context);
  assert.equal(added.requirementName, 'hazardousReport');
  const retainedId = '00000000-0000-0000-0000-000000000002';
  const attachments = [{ Id: id, FileName: 'remove.pdf', ContentRevision: 1 }, { Id: retainedId, FileName: 'keep.pdf', ContentRevision: 1 }];
  const remove = pool([rows(parent), { rowsAffected: [1] }, rows({ RowVersion: Buffer.from(nextVersion, 'hex') }), {}], {}, attachments);
  await new SqlDocuments(remove).delete(code, id, context);
  const history = remove.calls.find(call => call.statement?.includes('INSERT pcn.PcnRevisions'));
  assert.deepEqual(JSON.parse(history.inputs.snapshot).documentAttachments.map(document => document.id), [retainedId]);
  const audit = remove.calls.find(call => call.statement?.includes('INSERT pcn.AuditLogs'));
  assert.equal(JSON.parse(audit.inputs.metadata).fileName, 'remove.pdf');
  assert.equal(JSON.parse(audit.inputs.metadata).contentRevision, 2);
});

test('any persisted supplier or internal signature blocks attachment changes until a revision is opened', async () => {
  for (const review of [{ supplierSignoff: { approved: { checked: true } } }, { signoff: { gscTet: { checked: true } } }]) {
    for (const status of ['draft', 'supplier_action', 'submitted']) {
      for (const method of ['save', 'delete']) {
        const db = pool([rows({ ...parent, Status: status })], review);
        await assert.rejects(new SqlDocuments(db)[method](code, method === 'save' ? file : id,
          { ...context, user: { ...user, roles: ['admin'] } }), { statusCode: 409 });
        assert.equal(db.calls.filter(call => call.statement?.includes('INSERT pcn.PcnDocumentFiles')).length, 0);
        assert.equal(db.calls.at(-1), 'rollback');
      }
    }
  }
});

test('removal retains attachment bytes and excludes removed files from active quotas and downloads', async () => {
  const db = pool([rows(parent), { rowsAffected: [1] }, rows({ RowVersion: Buffer.from(nextVersion, 'hex') }), {}]);
  await new SqlDocuments(db).delete(code, id, context);
  const mutation = db.calls.find(call => call.statement?.includes('PcnDocumentFiles') && call.statement.includes('Id=@id'));
  assert.match(mutation.statement, /UPDATE pcn.PcnDocumentFiles SET DeletedAt=SYSUTCDATETIME\(\)/);
  assert.match(mutation.statement, /DeletedAt IS NULL/);
  assert.doesNotMatch(mutation.statement, /DELETE pcn.PcnDocumentFiles/);
  const upload = pool(uploadResults());
  await new SqlDocuments(upload).save(code, file, context);
  assert.match(upload.calls.find(call => call.statement?.includes('COUNT(*)')).statement, /DeletedAt IS NULL/);
});

test('revision-history failure rolls back attachment and PCN writes together', async () => {
  const db = pool(uploadResults());
  const originalTransaction = db.transaction.bind(db);
  db.transaction = () => {
    const tx = originalTransaction();
    const originalRequest = tx.request;
    tx.request = () => {
      const request = originalRequest();
      const originalQuery = request.query;
      request.query = async statement => {
        if (statement.includes('INSERT pcn.PcnRevisions')) throw new Error('history failed');
        return originalQuery(statement);
      };
      return request;
    };
    return tx;
  };
  await assert.rejects(new SqlDocuments(db).save(code, file, context), /history failed/);
  assert.equal(db.calls.at(-1), 'rollback');
});

test('attachment writes revalidate the actor under the shared user lock before locking the document', async () => {
  for (const persisted of [null, { IsActive: false, SecurityStamp: id, AccessVersion: Buffer.from(version, 'hex') },
    { IsActive: true, SecurityStamp: 'revoked-stamp', AccessVersion: Buffer.from(version, 'hex') },
    { IsActive: true, SecurityStamp: id, AccessVersion: Buffer.from(nextVersion, 'hex') }]) {
    for (const method of ['save', 'delete']) {
      const db = pool(uploadResults(), {}, [], persisted);
      await assert.rejects(new SqlDocuments(db)[method](code, method === 'save' ? file : id, context), { statusCode: 401 });
      assert.equal(db.calls.some(call => call.statement?.includes('FROM pcn.PcnRequests')), false);
      assert.equal(db.calls.some(call => call.statement?.includes('INSERT pcn.PcnDocumentFiles')), false);
      assert.equal(db.calls.at(-1), 'rollback');
    }
  }
  const db = pool(uploadResults());
  await new SqlDocuments(db).save(code, file, context);
  const queries = db.calls.filter(call => call.statement);
  assert.match(queries[0].statement, /sys.sp_getapplock/);
  assert.equal(queries[0].inputs.mode, 'Shared');
  assert.match(queries[1].statement, /SELECT IsActive,SecurityStamp,AccessVersion/);
  assert.match(queries[2].statement, /FROM pcn.PcnRequests/);
});
