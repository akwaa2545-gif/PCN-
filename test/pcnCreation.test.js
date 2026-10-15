const test = require('node:test');
const assert = require('node:assert/strict');
const { PcnCreationService } = require('../src/pcnCreation');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, unsignedPayload } = require('./helpers/apiHarness');
const user = { id: 'owner', roles: ['admin'], isActive: true, displayName: 'Owner' };
const other = { ...user, id: 'other' };
const key = '50000000-0000-4000-8000-000000000001';
function setup() {
  const repository = memoryRepository();
  const service = new PcnService(repository, () => new Date('2026-10-15T00:00:00Z'));
  const creation = new PcnCreationService({ service, repository,
    documents: { async listForRecords(ids) { return new Map(await Promise.all(ids.map(async id => [id, { parentVersion: (await repository.findById(id)).version, attachments: [] }]))); } },
    authRepository: { async listUsers() { return []; } }, mailConfigurationStatus: () => 'not_configured', scannerConfigured: false });
  return { repository, service, creation };
}
const create = creation => creation.create({ clientDraftKey: key, document: unsignedPayload }, 'owner', user);

test('creation saves an unsigned draft and retries reuse its canonical record', async () => {
  const { creation, repository } = setup();
  const first = await create(creation);
  assert.equal(first.record.status, 'draft'); assert.equal(first.reused, false);
  assert.equal(first.record.submittedAt, null);
  assert.equal(Object.hasOwn(first.record, 'creationReused'), false);
  const retry = await create(creation);
  assert.equal(retry.reused, true); assert.equal(retry.record.id, first.record.id);
  assert.equal((await repository.getRevisions(first.record.id)).length, 1);
});

test('creation rejects workflow, signature, history and mail payload injection', async () => {
  const { creation } = setup();
  for (const document of [{ ...unsignedPayload, status: 'submitted' }, { ...unsignedPayload, documentControl: {} },
    { ...unsignedPayload, internalReview: { signoff: { gscTet: { prepared: true } } } },
    { ...unsignedPayload, mailRoutingState: {} }, { ...unsignedPayload, approvals: [] }]) {
    await assert.rejects(creation.create({ clientDraftKey: key, document }, 'owner', user), { statusCode: 400 });
  }
  await assert.rejects(creation.create({ clientDraftKey: 'invalid', document: unsignedPayload }, 'owner', user), { statusCode: 400 });
});

test('draft access and autosave are owner-only even for another administrator', async () => {
  const { creation } = setup(); const { record } = await create(creation);
  await assert.rejects(creation.get(record.id, other), { statusCode: 404 });
  await assert.rejects(creation.update(record.id, { version: record.version, document: { supplierName: 'Changed' } }, 'other', other), { statusCode: 404 });
  assert.equal((await creation.list(other)).length, 0);
  const updated = await creation.update(record.id, { version: record.version, document: { supplierName: 'Changed' } }, 'owner', user);
  assert.equal(updated.record.supplierName, 'Changed');
  await assert.rejects(creation.update(record.id, { version: record.version, document: { supplierName: 'Stale' } }, 'owner', user), { statusCode: 409 });
});

test('draft-only mutation checks the locked current status and signatures', async () => {
  const { service, repository } = setup();
  const draft = await service.create({ ...unsignedPayload, status: 'draft' }, 'owner', user);
  await repository.seedHistoricalReview(draft.id, { signoff: { gscTet: { prepared: true } } });
  const signed = await repository.findById(draft.id);
  await assert.rejects(service.update(draft.id, { version: signed.version, reason: 'Autosave' }, 'owner', user, { draftOnly: true }), { statusCode: 409 });
  const current = await repository.findById(draft.id);
  assert.equal(current.reason, unsignedPayload.reason);
});

test('preflight uses saved canonical version, readiness and prospective submitted action', async () => {
  const { creation } = setup(); const { record } = await create(creation);
  const result = await creation.preflight(record.id, { version: record.version }, user);
  assert.equal(result.version, record.version); assert.equal(result.checks.ready, true);
  assert.equal(result.nextAction.signingStep, 'prepared');
  assert.deepEqual(result.notification, { configurationStatus: 'not_configured', recipientConfigured: false });
  assert.doesNotMatch(JSON.stringify(result), /@|mailRoutingState|signatureBindings/);
  await assert.rejects(creation.preflight(record.id, { version: '000000000000ffff' }, user), { statusCode: 409 });
});

test('template copies allowlisted document content and never signatures, metadata or attachment claims', async () => {
  const { creation, repository } = setup(); const { record } = await create(creation);
  await repository.seedHistoricalReview(record.id, { docs: { greenProcurement: true }, materialCodeDescription: 'safe code', signoff: { gscTet: { prepared: true, preparedName: 'Signer' } } });
  const template = await creation.template(record.id, user);
  assert.equal(template.supplierName, unsignedPayload.supplierName);
  assert.deepEqual(template.internalReview, { docs: { greenProcurement: true }, materialCodeDescription: 'safe code' });
  for (const field of ['id','version','ownerUserId','createdAt','documentControl','documents','approvals','status']) assert.equal(Object.hasOwn(template, field), false);
  const supplier = { ...user, roles: ['supplier'] };
  assert.equal(Object.hasOwn(await creation.template(record.id, supplier), 'internalReview'), false);
});

test('test documents retain an immutable server-owned mark through drafts, retries, list and templates', async () => {
  const { creation } = setup();
  const saved = await creation.create({ clientDraftKey: key, testDocument: true, document: unsignedPayload }, 'owner', user);
  assert.equal(saved.record.isTestDocument, true);
  const replay = await create(creation);
  assert.equal(replay.record.isTestDocument, true); assert.equal(replay.reused, true);
  assert.equal((await creation.list(user))[0].isTestDocument, true);
  assert.equal((await creation.template(saved.record.id, user)).isTestDocument, true);
  const updated = await creation.update(saved.record.id, { version: saved.record.version, document: { reason: 'Edit a test' } }, 'owner', user);
  assert.equal(updated.record.isTestDocument, true);
  await assert.rejects(creation.update(saved.record.id, { version: updated.record.version, document: { isTestDocument: false } }, 'owner', user), { statusCode: 400 });
  await assert.rejects(creation.create({ clientDraftKey: key, testDocument: 'yes', document: unsignedPayload }, 'owner', user), { statusCode: 400 });
  await assert.rejects(creation.create({ clientDraftKey: key, document: { ...unsignedPayload, isTestDocument: true } }, 'owner', user), { statusCode: 400 });
});
