const test = require('node:test');
const assert = require('node:assert/strict');
const { PcnService } = require('../src/pcnService');
const masterData = require('../src/masterData');
const { memoryRepository, unsignedPayload } = require('./helpers/apiHarness');

const baseline = Object.fromEntries(Object.entries(masterData).filter(([, value]) => typeof value !== 'function'));
const admin = { id: 'admin-fixture', isActive: true, roles: ['admin'] };
function fixture() {
  const repository = memoryRepository();
  let masters = { 1: { ...structuredClone(baseline), versionId: 1 } }, active = 1;
  repository.getMasterData = async version => {
    const found = masters[version ?? active];
    if (!found) { const error = new Error('Missing snapshot'); error.statusCode = 503; throw error; }
    return structuredClone(found);
  };
  return { repository, service: new PcnService(repository),
    publish(forms) { active += 1; masters = { ...masters, [active]: { ...structuredClone(baseline), formDefinitions: forms, versionId: active } }; },
    remove(version) { const { [version]: omitted, ...remaining } = masters; masters = remaining; } };
}
function changedForms() {
  const forms = structuredClone(masterData.formDefinitions);
  forms.rawMaterial.riskOptions = [{ risk: 'RL1', text: 'Administrator-defined change', enabled: true },
    { risk: 'RL2', text: unsignedPayload.selectedChange, enabled: false }];
  return forms;
}
const newPayload = () => ({ ...unsignedPayload, riskLevel: 'RL1', selectedChange: 'Administrator-defined change',
  changeRows: [{ risk: 'RL1', optionText: 'Administrator-defined change', text: 'Administrator-defined change' }], status: 'draft' });

test('new TA and SC documents use the active editable category master and reject disabled options', async () => {
  for (const documentType of ['ta', 'sc']) {
    const { service, publish } = fixture(); publish(changedForms());
    const created = await service.create({ ...newPayload(), documentType }, 'fixture', admin);
    assert.equal(created.masterDataVersionId, 2);
    assert.equal(created.riskLevel, 'RL1');
    assert.equal(created.changeRows[0].optionText, 'Administrator-defined change');
    await assert.rejects(service.create({ ...unsignedPayload, documentType, status: 'draft' }, 'fixture', admin), { statusCode: 400 });
  }
});

test('existing drafts retain their category wording and risk after defaults change', async () => {
  const { service, publish } = fixture();
  const created = await service.create({ ...unsignedPayload, status: 'draft' }, 'fixture', admin);
  publish(changedForms());
  const changed = await service.update(created.id, { version: created.version, reason: 'Updated on original master' }, 'fixture', admin);
  assert.equal(changed.masterDataVersionId, 1);
  assert.equal(changed.selectedChange, unsignedPayload.selectedChange);
  assert.equal(changed.riskLevel, 'RL2');
  assert.equal((await service.resolveRecordMaster(changed)).versionId, 1);
});

test('an option already disabled in a draft master cannot be selected through a later draft save', async () => {
  const { service, publish } = fixture(); publish(changedForms());
  const created = await service.create(newPayload(), 'fixture', admin);
  await assert.rejects(service.update(created.id, { ...unsignedPayload, status: 'draft', version: created.version }, 'fixture', admin), { statusCode: 400 });
});

test('submitted document signing uses its original master rather than current defaults', async () => {
  const { service, publish } = fixture();
  const created = await service.create(unsignedPayload, 'fixture', admin);
  publish(changedForms());
  const signed = await service.update(created.id, { version: created.version,
    internalReview: { signoff: { gscTet: { checked: true } } } }, 'fixture', admin);
  assert.equal(signed.internalReview.signoff.gscTet.checked, true);
  assert.equal(signed.selectedChange, unsignedPayload.selectedChange);
  assert.equal(signed.riskLevel, 'RL2');
});

test('a missing pinned snapshot fails closed while unversioned legacy documents use packaged defaults', async () => {
  const { service, repository, publish, remove } = fixture();
  const created = await service.create({ ...unsignedPayload, status: 'draft' }, 'fixture', admin);
  publish(changedForms()); remove(1);
  await assert.rejects(service.update(created.id, { version: created.version, reason: 'Cannot reinterpret' }, 'fixture', admin), { statusCode: 503 });
  const legacy = await repository.create({ ...created, id: undefined, documentType: undefined, masterDataVersionId: null }, 'fixture');
  const saved = await service.update(legacy.id, { version: legacy.version, reason: 'Legacy correction' }, 'fixture', admin);
  assert.equal(saved.riskLevel, 'RL2');
  assert.equal(saved.selectedChange, unsignedPayload.selectedChange);
});

test('updates resolve pinned master through the existing transaction without checking out another SQL connection', async () => {
  const { service, repository } = fixture();
  const created = await service.create({ ...unsignedPayload, status: 'draft' }, 'fixture', admin);
  const master = await repository.getMasterData(created.masterDataVersionId);
  const update = repository.update.bind(repository), requests = [];
  repository.getMasterData = async () => { throw new Error('A second connection would block a single-connection pool'); };
  repository.update = (id, updater, ...args) => update(id, current => updater(current, {
    async getMasterData(versionId) { requests.push(versionId); return structuredClone(master); }
  }), ...args);
  const saved = await service.update(created.id, { version: created.version, reason: 'Transaction-local master read' }, 'fixture', admin);
  assert.equal(saved.reason, 'Transaction-local master read');
  assert.deepEqual(requests, [created.masterDataVersionId]);
});
