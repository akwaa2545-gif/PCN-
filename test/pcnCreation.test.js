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

test('draft-only update rejects a submission that wins before the locked updater executes', async () => {
  const { creation, service, repository } = setup(); const { record } = await create(creation);
  const update = repository.update.bind(repository);
  repository.update = (id, updater, ...args) => update(id, current => updater({ ...current, status: 'submitted' }), ...args);
  await assert.rejects(creation.update(record.id, { version: record.version, document: { reason: 'Late edit' } }, 'owner', user), { statusCode: 409 });
  assert.equal((await service.getById(record.id, user)).reason, unsignedPayload.reason);
});

test('preflight rejects mismatched attachment metadata and cannot silently report readiness', async () => {
  const { creation } = setup(); const { record } = await create(creation);
  creation.documents.listForRecords = async () => new Map([[record.id, { parentVersion: '000000000000ffff', attachments: [] }]]);
  await assert.rejects(creation.preflight(record.id, { version: record.version }, user), { statusCode: 409 });
  creation.documents = null;
  await assert.rejects(creation.preflight(record.id, { version: record.version }, user), { statusCode: 503 });
});

test('draft identity remains idempotent after submission and cannot resurrect a deleted record', async () => {
  const { creation, service, repository } = setup(); const { record } = await create(creation);
  const submitted = await service.update(record.id, { version: record.version, status: 'submitted' }, 'owner', user);
  const replay = await create(creation);
  assert.equal(replay.record.id, record.id); assert.equal(replay.record.status, 'submitted'); assert.equal(replay.reused, true);
  await repository.delete(record.id, 'owner', submitted.version);
  await assert.rejects(create(creation), { statusCode: 409 });
});

test('roleless, inactive and unauthorized requirements are rejected before draft writes', async () => {
  const { creation, repository } = setup();
  for (const denied of [{ ...user, isActive: false }, { ...user, roles: [] }, { ...user, identityProvider: 'employee-code', employeeCode: '1234567', roles: [] }]) {
    await assert.rejects(creation.create({ clientDraftKey: key, document: unsignedPayload }, 'owner', denied), { statusCode: 403 });
  }
  await assert.rejects(creation.create({ clientDraftKey: key, document: { ...unsignedPayload, internalReview: { docs: { greenProcurement: true } } } }, 'owner', { ...user, roles: ['supplier'] }), { statusCode: 403 });
  assert.equal((await repository.list()).length, 0);
});

test('preflight recognizes verified assigned recipients without exposing their private addresses', async () => {
  const { applyUserMailRouting } = require('../src/userMailRouting');
  const { creation, repository } = setup(); const { record } = await create(creation);
  const preparer = { id: 'preparer', displayName: 'Prepared person', roles: ['gsc'], department: 'gscTet', signingStep: 'prepared',
    identityProvider: 'employee-code', isActive: true, email: 'prepared@example.test', mailDirectoryId: 'directory-id',
    mailVerifiedAt: '2026-10-01T00:00:00Z', mailProfile: { id: 'directory-id', email: 'prepared@example.test' } };
  repository.getNotificationSettings = async () => applyUserMailRouting({ schemaVersion: 2, groups: [] }, [preparer]);
  creation.authRepository.listUsers = async () => [preparer];
  const result = await creation.preflight(record.id, { version: record.version }, user);
  assert.equal(result.notification.recipientConfigured, true);
  assert.deepEqual(result.nextAction.people, [{ displayName: 'Prepared person' }]);
  assert.doesNotMatch(JSON.stringify(result), /@|directory-id|mailProfile/);
});

test('old receipt with no recorded action job still explains a currently blocked action after unrelated saves', async () => {
  const { creation, repository } = setup(); const { record } = await create(creation);
  await repository.update(record.id, current => ({ ...current, status: 'submitted', mailRoutingState: {
    activationId: 'different-current-activation', status: 'blocked', reason: 'no_verified_recipients' } }), 'fixture', record.version);
  const receipt = await creation.receipt(record.id, record.version, user);
  assert.equal(receipt.notification.state, 'needs_attention');
  assert.match(receipt.notification.message, /current action is blocked/i);
  assert.match(receipt.notification.message, /no action notification is recorded for the requested version/i);
  assert.equal(receipt.notification.currentActionBlocked, true);
  assert.equal(receipt.notification.requestedVersionRecorded, false);
});

test('accepted action job for a requested older version is not downgraded by a later blocked activation', async () => {
  const { creation, repository } = setup(); const { record } = await create(creation);
  await repository.update(record.id, current => ({ ...current, status: 'submitted', mailRoutingState: {
    activationId: 'later-blocked-activation', status: 'blocked' } }), 'fixture', record.version);
  repository.getNotificationStatus = async () => [{ Status: 'sent', JobCount: 1 }];
  const receipt = await creation.receipt(record.id, record.version, user);
  assert.equal(receipt.notification.state, 'accepted');
  assert.match(receipt.notification.message, /accepted by workflow/i);
  assert.doesNotMatch(receipt.notification.message, /blocked/i);
});

test('draft autosave preserves an explicitly cleared change description and every other row and condition', async () => {
  const { creation, service } = setup(); const { formDefinitions } = require('../src/masterData');
  const options = formDefinitions.rawMaterial.riskOptions.filter(option => option.risk === 'RL2');
  const rows = options.slice(0, 2).map((option, index) => ({ ...option, optionText: option.text,
    currentCondition: `Current row ${index}`, newCondition: `New row ${index}` }));
  const { record } = await creation.create({ clientDraftKey: key, document: { ...unsignedPayload, changeRows: rows } }, 'owner', user);
  const cleared = [{ ...rows[0], text: '' }, rows[1]];
  const saved = await creation.update(record.id, { version: record.version,
    document: { selectedChange: '', changeRows: cleared } }, 'owner', user);
  assert.equal(saved.record.selectedChange, ''); assert.deepEqual(saved.record.changeRows, cleared);
  const preflight = await creation.preflight(record.id, { version: saved.record.version }, user);
  assert.equal(preflight.checks.ready, false);
  assert.equal(preflight.checks.items.find(item => item.key === 'selectedChange').complete, false);
  await assert.rejects(service.update(record.id, { version: saved.record.version, status: 'submitted' }, 'owner', user), { statusCode: 400 });
  assert.equal((await service.getById(record.id, user)).status, 'draft');
  await assert.rejects(service.create({ ...unsignedPayload, changeRows: [rows[0], { ...rows[1], text: '' }], status: 'submitted' }, 'owner', user), { statusCode: 400 });
});

test('draft risk changes preserve prior populated rows while the new change selection is incomplete', async () => {
  const { creation, service } = setup(); const { record } = await create(creation);
  const saved = await creation.update(record.id, { version: record.version,
    document: { riskLevel: 'RL1', selectedChange: '' } }, 'owner', user);
  assert.equal(saved.record.riskLevel, 'RL1'); assert.equal(saved.record.selectedChange, '');
  assert.equal(saved.record.changeRows[0].risk, 'RL2');
  assert.equal(saved.record.changeRows[0].text, unsignedPayload.changeRows[0].text);
  assert.equal(saved.record.changeRows[0].currentCondition, unsignedPayload.changeRows[0].currentCondition);
  await assert.rejects(service.update(record.id, { version: saved.record.version, status: 'submitted' }, 'owner', user), { statusCode: 400 });
});
