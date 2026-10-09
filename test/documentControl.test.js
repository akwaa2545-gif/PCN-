const test = require('node:test');
const assert = require('node:assert/strict');
const { contentHash, applyDocumentControl, clearSignatures, fieldChanges } = require('../src/documentControl');
const actor = { id: 'employee-1', displayName: 'Example Person' };
const now = '2026-10-09T10:00:00.000Z';
const base = { supplierName: 'Supplier', reason: 'Material change', status: 'draft', internalReview: {} };

test('direct submitted creation cannot bypass completion while incomplete draft remains allowed', async () => {
  const { PcnService }=require('../src/pcnService');
  const { memoryRepository,unsignedPayload }=require('./helpers/apiHarness');
  const service=new PcnService(memoryRepository());
  await assert.rejects(service.create({...unsignedPayload,status:'submitted',reason:''}),/Complete required document/);
  const draft=await service.create({...unsignedPayload,status:'draft',reason:'',supplierName:'',materialName:''});
  assert.equal(draft.status,'draft');
});

test('material code changes affect the document content digest', () => {
  assert.notEqual(contentHash({...base,internalReview:{materialCodeDescription:'Part A'}}),contentHash({...base,internalReview:{materialCodeDescription:'Part B'}}));
});

test('digest ignores routine review, workflow dates and signatures but includes supplier content', () => {
  assert.equal(contentHash(base), contentHash({ ...base, status: 'submitted', updatedAt: now, notification: {}, internalReview: { signoff: { gscTet: { approved: true, approvedName: 'Signer', approvedDate: '2026-10-09' } }, pcnCode: 'PCN-2026-0001' } }));
  assert.equal(contentHash(base), contentHash({ ...base, internalReview: { decision: { comment: 'Needs testing' } } }));
  assert.notEqual(contentHash(base), contentHash({ ...base, reason: 'New specification' }));
});
test('new signature binds canonical actor and unchanged signature keeps original binding', () => {
  const created = applyDocumentControl(null, base, actor, now);
  const signed = applyDocumentControl(created, { ...created, internalReview: { signoff: { gscTet: { approved: true } } } }, actor, now);
  const binding = signed.documentControl.signatureBindings['signoff.gscTet.approved'];
  assert.equal(binding.userId, actor.id);
  assert.equal(binding.contentRevision, 1);
  const unchanged = applyDocumentControl(signed, { ...signed, status: 'submitted' }, { id: 'other' }, now);
  assert.deepEqual(unchanged.documentControl.signatureBindings['signoff.gscTet.approved'], binding);
});
test('historical signers without binding are explicitly unknown', () => {
  const legacy = { ...base, internalReview: { supplierSignoff: { approved: { checked: true, name: 'Historic' } } } };
  const next = applyDocumentControl(legacy, legacy, actor, now);
  assert.deepEqual(next.documentControl.signatureBindings['supplierSignoff.approved'], { state: 'unknown' });
});
test('signed review content cannot change without controlled revision', () => {
  const signed = { ...base, status: 'in_review', internalReview: { signoff: { gscTet: { approved: true } } } };
  assert.throws(() => applyDocumentControl(signed, { ...signed, reason: 'Changed' }, actor, now), /Start a new revision/);
});
test('draft content edit advances revision and invalidates signatures; content plus new signatures rejected', () => {
  const signed = applyDocumentControl(null, { ...base, internalReview: { signoff: { gscTet: { approved: true, approvedName: 'Person', approvedDate: '2026-10-09' } } } }, actor, now);
  const revised = applyDocumentControl(signed, { ...signed, reason: 'Updated' }, actor, now);
  assert.equal(revised.documentControl.contentRevision, 2);
  assert.equal(revised.internalReview.signoff.gscTet.approved, false);
  assert.equal(revised.internalReview.signoff.gscTet.approvedName, '');
  assert.throws(() => applyDocumentControl(signed, { ...signed, reason: 'Updated', internalReview: { supplierSignoff: { prepared: { checked: true } } } }, actor, now), /Save content changes before signing/);
});
test('controlled reset clears every supplier/internal signature and final decision without losing comments', () => {
  const cleared = clearSignatures({ supplierSignoff: { prepared: { checked: true, name: 'A', date: 'x' } }, signoff: { qaTet: { approved: true, approvedName: 'B', approvedDate: 'x', comment: 'Preserve' } }, qateFinal: { approve: true, reject: false, comment: 'Report' } });
  assert.equal(cleared.supplierSignoff.prepared.checked, false);
  assert.equal(cleared.signoff.qaTet.comment, 'Preserve');
  assert.equal(cleared.qateFinal.approve, false);
});
test('field diffs preserve deleted values and snapshots do not share mutable references', () => {
  const changes = fieldChanges({ reason: 'Old', review: { note: 'Removed' } }, { reason: 'New' });
  assert.deepEqual(changes, [{ path: 'reason', before: 'Old', after: 'New' }, { path: 'review.note', before: 'Removed', after: null }]);
});

test('incomplete drafts save without required submission fields while submitted records remain validated', () => {
  const { PcnService } = require('../src/pcnService');
  const service = new PcnService({});
  const input = { status: 'draft', changeForm: Object.keys(require('../src/masterData').formDefinitions)[0], riskLevel: 'RL1' };
  const normalized = service.normalizeInput(input);
  assert.equal(normalized.supplierName, '');
  assert.equal(normalized.selectedChange, '');
  assert.throws(() => service.normalizeInput({ ...input, status: 'submitted' }), /selectedChange is required/);
});

test('start revision requires admin, current CAS and reason, preserving completed document lock', async () => {
  const { PcnService } = require('../src/pcnService');
  let current = { ...base, id: 'PCN-2026-0001', version: '0000000000000001', ownerUserId: actor.id, status: 'submitted', internalReview: { supplierSignoff: { approved: { checked: true, name: 'Historic' } } } };
  let expected;
  const repository = { async update(id, updater, auditActor, version) { expected = version; current = await updater(current); return current; } };
  const service = new PcnService(repository, () => new Date(now));
  const input = { version: current.version, reason: 'Supplier corrected specification' };
  await assert.rejects(service.startRevision(current.id, input, 'user', { ...actor, roles: ['gsc'] }), { statusCode: 403 });
  await assert.rejects(service.startRevision(current.id, { reason: 'Correction' }, 'user', { ...actor, roles: ['admin'] }), { statusCode: 400 });
  const revised = await service.startRevision(current.id, input, 'user', { ...actor, roles: ['admin'] });
  assert.equal(expected, input.version);
  assert.equal(revised.status, 'supplier_action');
  assert.equal(revised.internalReview.supplierSignoff.approved.checked, false);
  assert.equal(revised.documentControl.contentRevision, 2);
  assert.equal(revised.documentControl.revisionReason, input.reason);
  current = { ...current, status: 'approved' };
  await assert.rejects(service.startRevision(current.id, input, 'user', { ...actor, roles: ['admin'] }), { statusCode: 403 });
});

test('revision metadata cannot be supplied through ordinary writable payload', () => {
  const { assertWritablePayload } = require('../src/workflowAccess');
  assert.throws(() => assertWritablePayload({ documentControl: { contentRevision: 99 } }), /Field cannot be written/);
});

test('history access follows record owner permission and snapshot detail validates sequence', async () => {
  const { PcnService } = require('../src/pcnService');
  const record = { id: 'PCN-2026-0001', ownerUserId: actor.id };
  let reads = 0;
  const service = new PcnService({ async findById() { return record; }, async getRevisions() { reads++; return [{ revision: 1 }]; }, async getRevision() { reads++; return null; } });
  await assert.rejects(service.getRevisions(record.id, { id: 'other', roles: ['supplier'] }), { statusCode: 404 });
  assert.equal(reads, 0);
  assert.deepEqual(await service.getRevisions(record.id, { ...actor, roles: ['supplier'] }), [{ revision: 1 }]);
  await assert.rejects(service.getRevision(record.id, 0, { ...actor, roles: ['supplier'] }), { statusCode: 400 });
  await assert.rejects(service.getRevision(record.id, 5, { ...actor, roles: ['supplier'] }), { statusCode: 404 });
});
