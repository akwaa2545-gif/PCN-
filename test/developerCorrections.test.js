const test = require('node:test');
const assert = require('node:assert/strict');
const { PcnService } = require('../src/pcnService');
const { contentHash } = require('../src/documentControl');
const { memoryRepository, unsignedPayload, startApi, fakeAuthService } = require('./helpers/apiHarness');
const { loadCorrection, bulkCorrect, unsign } = require('../src/developerCorrections');

const developer = Object.freeze({ id: 'dev-id', isActive: true, roles: ['developer'], department: 'developer', signingStep: null, displayName: 'Developer fixture' });
const done = { prepared: true, checked: true, approved: true, preparedName: 'Original signer', preparedDate: '2026-11-20' };
async function fixture(type = 'ta', status = 'submitted') {
  const repository = memoryRepository();
  const service = new PcnService(repository, () => new Date('2026-11-24T08:00:00Z'));
  let record = await service.create({ ...unsignedPayload, documentType: type, status: 'draft' }, 'fixture', developer);
  record = await repository.update(record.id, current => ({ ...current, status, internalReview: {
    ...current.internalReview, signoff: { gscTet: { ...done }, prodEngTet: { ...done }, qaTet: { ...done } },
    tapbu: { noNeed: true }, qateFinal: { approve: true, signoff: { ...done } },
    supplierSignoff: { prepared: { checked: true, name: 'Header signer', date: '2026-11-20' }, checked: { checked: true, name: 'Header checker', date: '2026-11-20' }, approved: { checked: true, name: 'Header approver', date: '2026-11-20' } }
  }, documentControl: { ...current.documentControl, signatureBindings: { 'signoff.gscTet.prepared': { userId: 'original-id', contentHash: contentHash(current), signedAt: '2026-11-20T00:00:00Z', contentRevision: 1 } } } }), 'fixture', record.version);
  return { service, repository, record };
}
const batch = (record, changes) => ({ reason: 'Correct transcription', items: [{ id: record.id, version: record.version, changes }] });

test('TA and SC corrections preserve signatures, their original binding, status and content revision while auditing changes', async () => {
  for (const type of ['ta', 'sc']) {
    const context = await fixture(type, 'closed'), before = context.record;
    const result = await bulkCorrect(context, developer, batch(before, { reason: 'Corrected content' }));
    assert.equal(result.results[0].success, true);
    const after = await context.repository.findById(before.id);
    assert.equal(after.status, 'closed'); assert.equal(after.documentType, type);
    assert.deepEqual(after.internalReview, before.internalReview);
    assert.deepEqual(after.documentControl.signatureBindings, before.documentControl.signatureBindings);
    assert.equal(after.documentControl.contentRevision, before.documentControl.contentRevision);
    assert.notEqual(after.documentControl.contentHash, before.documentControl.contentHash);
    assert.equal(after.documentControl.lastDeveloperCorrection.reason, 'Correct transcription');
    const history = await context.repository.getRevisions(before.id);
    assert.ok(history[0].changes.some(row => row.path === 'reason' && row.before === before.reason && row.after === 'Corrected content'));
    assert.ok(history[0].changes.some(row => row.path === 'documentControl.lastDeveloperCorrection.reason'));
    assert.ok(after.documentControl.lastDeveloperCorrection.retainedSignatures.includes('signoff.gscTet.prepared'));
  }
});

test('correction editor projects only safe content and exact unsign impact', async () => {
  const context = await fixture('sc', 'closed');
  const editor = await loadCorrection(context, developer, context.record.id);
  assert.equal(editor.record.version, context.record.version);
  assert.equal(Object.hasOwn(editor.record, 'ownerUserId'), false);
  assert.equal(Object.hasOwn(editor.record, 'internalReview'), false);
  const target = editor.signatures.find(row => row.path === 'signoff.prodEngTet.checked');
  assert.equal(target.reopens, true);
  assert.ok(target.clears.includes('signoff.prodEngTet.checked'));
  assert.ok(target.clears.includes('supplierSignoff.approved'));
  assert.equal(target.clears.includes('signoff.prodEngTet.prepared'), false);
});

test('content-of-change corrections keep the same category and selected row identity', async () => {
  const context = await fixture(); const r = context.record;
  const changes = { changeRows: r.changeRows.map(row => ({ ...row, text: 'Clarified category wording' })) };
  const result = await bulkCorrect(context, developer, batch(r, changes));
  assert.equal(result.results[0].success, true);
  const after = await context.repository.findById(r.id);
  assert.equal(after.selectedChange, 'Clarified category wording');
  assert.equal(after.changeRows[0].optionText, r.changeRows[0].optionText);
  assert.equal(after.riskLevel, r.riskLevel);
});

test('strict correction schema rejects identities, workflow, unsafe values and category substitution without writes', async () => {
  const context = await fixture(); const r = context.record;
  for (const changes of [{ documentType: 'sc' }, { riskLevel: 'RL0' }, { changeForm: 'packaging' }, { status: 'draft' }, { internalReview: {} }, { reason: {} }, { changeRows: [] }, { selectedChange: 'Another category' }]) {
    const beforeHistory = await context.repository.getRevisions(r.id);
    try {
      const response = await bulkCorrect(context, developer, batch(r, changes));
      assert.equal(response.results[0].success, false, JSON.stringify(changes));
    } catch (error) { assert.equal(error.statusCode, 400); }
    assert.deepEqual(await context.repository.findById(r.id), r);
    assert.deepEqual(await context.repository.getRevisions(r.id), beforeHistory);
  }
  for (const body of [{ ...batch(r, { reason: 'x' }), extra: true }, { reason: '', items: batch(r, {}).items }, { reason: 'x', items: [] }, { reason: 'x', items: Array(21).fill(batch(r, {}).items[0]) }, { reason: 'x', items: [batch(r, {}).items[0], batch(r, {}).items[0]] }]) {
    await assert.rejects(bulkCorrect(context, developer, body), { statusCode: 400 });
  }
});

test('bulk results separate stale, missing and successful PCNs and no-ops do not write history', async () => {
  const context = await fixture(); const r = context.record;
  const history = await context.repository.getRevisions(r.id);
  const unchanged = await bulkCorrect(context, developer, batch(r, { reason: r.reason }));
  assert.equal(unchanged.results[0].changed, false);
  assert.deepEqual(await context.repository.getRevisions(r.id), history);
  const result = await bulkCorrect(context, developer, { reason: 'Correction', items: [
    { id: 'PCN-2026-9999', version: r.version, changes: { reason: 'Missing' } },
    { id: r.id, version: '0000000000000000', changes: { reason: 'Stale' } }
  ] });
  assert.deepEqual(result.results.map(row => row.status), [404, 409]);
});

test('only exclusive active Developer may use correction and unsign operations', async () => {
  const context = await fixture();
  for (const user of [null, { ...developer, roles: ['admin'] }, { ...developer, roles: ['developer', 'admin'] }, { ...developer, isActive: false }, { ...developer, department: 'it' }, { ...developer, signingStep: 'prepared' }]) {
    await assert.rejects(loadCorrection(context, user, context.record.id), { statusCode: 403 });
    await assert.rejects(bulkCorrect(context, user, batch(context.record, { reason: 'Denied' })), { statusCode: 403 });
    await assert.rejects(unsign(context, user, context.record.id, { version: context.record.version, reason: 'Denied', path: 'signoff.gscTet.prepared' }), { statusCode: 403 });
  }
});

test('unsign clears selected and dependent evidence, preserves earlier signatures, reopens closed PCN and audits reason', async () => {
  const context = await fixture('sc', 'closed'); const r = context.record;
  const result = await unsign(context, developer, r.id, { version: r.version, reason: 'Wrong checker', path: 'signoff.prodEngTet.checked' });
  assert.equal(result.reopened, true); assert.equal(result.status, 'submitted');
  const after = await context.repository.findById(r.id);
  assert.deepEqual(after.internalReview.signoff.gscTet, r.internalReview.signoff.gscTet);
  assert.equal(after.internalReview.signoff.prodEngTet.prepared, true);
  assert.equal(after.internalReview.signoff.prodEngTet.checked, false);
  assert.equal(after.internalReview.signoff.qaTet.prepared, false);
  assert.equal(after.internalReview.supplierSignoff.approved.checked, false);
  assert.equal(after.internalReview.supplierSignoff.approved.name, '');
  assert.equal(after.internalReview.qateFinal.approve, false);
  assert.equal(after.documentControl.contentRevision, r.documentControl.contentRevision);
  assert.deepEqual(after.documentControl.signatureBindings['signoff.gscTet.prepared'], r.documentControl.signatureBindings['signoff.gscTet.prepared']);
  assert.equal(after.documentControl.lastDeveloperCorrection.kind, 'unsign');
  assert.equal(after.documentControl.lastDeveloperCorrection.reason, 'Wrong checker');
  assert.equal(after.reviewTiming.prodEngTet?.startedAt, '2026-11-24T08:00:00.000Z');
});

test('unsign rejects stale, unknown, missing signatures and unsafe extra keys', async () => {
  const context = await fixture(); const r = context.record;
  for (const [input, code] of [[{ version: '0000000000000000', reason: 'Stale', path: 'signoff.gscTet.prepared' }, 409], [{ version: r.version, reason: 'Unknown', path: '__proto__.approved' }, 400], [{ version: r.version, reason: '', path: 'signoff.gscTet.prepared' }, 400], [{ version: r.version, reason: 'Extra', path: 'signoff.gscTet.prepared', status: 'draft' }, 400]]) {
    await assert.rejects(unsign(context, developer, r.id, input), { statusCode: code });
    assert.deepEqual(await context.repository.findById(r.id), r);
  }
});

test('correction and unsign APIs enforce CSRF, same-origin and Developer authorization', async t => {
  const api = await startApi(t, { authService: fakeAuthService({ additionalUsers: [{ ...developer, username: 'dev' }] }) });
  const dev = await api.login('dev'), admin = await api.login('admin');
  const created = await api.request('/api/pcns', { method: 'POST', session: admin, body: unsignedPayload });
  const r = created.body.data;
  const path = `/api/developer/pcns/${r.id}/correction`;
  assert.equal((await api.request(path, { session: dev })).status, 200);
  assert.equal((await api.request(path, { session: admin })).status, 403);
  assert.equal((await api.request('/api/developer/pcns/corrections', { method: 'POST', session: dev, csrf: null, body: batch(r, { reason: 'Denied' }) })).status, 403);
  assert.equal((await api.request('/api/developer/pcns/corrections', { method: 'POST', session: dev, csrf: 'wrong-token', body: batch(r, { reason: 'Denied' }) })).status, 403);
  assert.equal((await api.request('/api/developer/pcns/corrections', { method: 'POST', session: dev, origin: 'http://attacker.test', body: batch(r, { reason: 'Denied' }) })).status, 403);
  const changed = await api.request('/api/developer/pcns/corrections', { method: 'POST', session: dev, body: batch(r, { reason: 'Correction through API' }) });
  assert.equal(changed.status, 200, changed.text); assert.equal(changed.body.data.results[0].success, true);
  const updated = await api.repository.findById(r.id);
  for (const options of [{ csrf: null }, { csrf: 'wrong-token' }, { origin: 'http://attacker.test' }]) {
    assert.equal((await api.request(`/api/developer/pcns/${r.id}/unsign`, { method: 'POST', session: dev, ...options,
      body: { version: updated.version, reason: 'Denied', path: 'signoff.gscTet.prepared' } })).status, 403);
  }
  const removed = await api.request(`/api/developer/pcns/${r.id}/unsign`, { method: 'POST', session: dev, body: { version: updated.version, reason: 'Signing correction', path: 'signoff.gscTet.prepared' } });
  assert.equal(removed.status, 200, removed.text);
  assert.ok(removed.body.data.cleared.includes('signoff.gscTet.prepared'));
  const inspection = await api.request(`/api/developer/pcns/${r.id}/inspect`, { session: dev });
  // Existing metadata requirements remain independent of correction permissions.
  assert.equal(inspection.status, 503);
});

test('fresh submitted GSC Prepared keeps revision one and exact automatic signature evidence after correction', async () => {
  const repository = memoryRepository(), service = new PcnService(repository);
  const original = await service.create({ ...unsignedPayload, documentType: 'sc' }, 'fixture', developer);
  assert.equal(original.status, 'submitted');
  assert.equal(original.internalReview.signoff.gscTet.prepared, true);
  assert.equal(original.documentControl.contentRevision, 1);
  await bulkCorrect({ repository, service }, developer, batch(original, { supplierName: 'Corrected supplier' }));
  const changed = await repository.findById(original.id);
  assert.equal(changed.documentControl.contentRevision, 1);
  assert.deepEqual(changed.documentControl.signatureBindings, original.documentControl.signatureBindings);
  assert.equal(changed.status, 'submitted');
});

test('legacy PCNs use the same correction and unsign workflow without adopting a typed identity', async () => {
  const repository = memoryRepository(), service = new PcnService(repository);
  const data = service.normalizeInput({ ...unsignedPayload, documentType: undefined, status: 'draft' });
  const legacy = await repository.create({ ...data, createdAt: '2026-10-01T00:00:00Z', ownerUserId: developer.id, internalReview: { signoff: { gscTet: { prepared: true } } } }, 'fixture');
  assert.match(legacy.id, /^PCN-/);
  const context = { repository, service };
  await bulkCorrect(context, developer, batch(legacy, { supplierName: 'Legacy supplier correction' }));
  const after = await repository.findById(legacy.id);
  assert.equal(after.id, legacy.id); assert.equal(after.documentType, undefined);
  assert.equal(after.internalReview.signoff.gscTet.prepared, true);
  await unsign(context, developer, after.id, { version: after.version, reason: 'Remove historical signature', path: 'signoff.gscTet.prepared' });
  assert.equal((await repository.findById(after.id)).internalReview.signoff.gscTet.prepared, false);
});

test('transactional current-account checks still run for no-op corrections', async () => {
  const context = await fixture(); let called = false;
  context.service.repository = { async update(code, updater, actor, expectedVersion, user) {
    assert.equal(user, developer); assert.equal(expectedVersion, context.record.version); called = true;
    throw new (require('../src/apiError').ApiError)(403, 'Account access changed');
  } };
  const result = await bulkCorrect(context, developer, batch(context.record, { reason: context.record.reason }));
  assert.equal(called, true); assert.equal(result.results[0].status, 403);
});

test('unexpected middle-entry failure keeps truthful committed results and hides database error details', async t => {
  const context = await fixture();
  const second = await context.service.create({ ...unsignedPayload, documentType: 'sc', status: 'draft' }, 'fixture', developer);
  const third = await context.service.create({ ...unsignedPayload, documentType: 'ta', status: 'draft' }, 'fixture', developer);
  const original = context.repository.update.bind(context.repository);
  context.repository.update = async (id, ...args) => {
    if (id === second.id) throw Object.assign(new Error('Private database server password info'), { code: 'ECONNECTION' });
    return original(id, ...args);
  };
  const logs = []; t.mock.method(console, 'error', value => logs.push(value));
  const result = await bulkCorrect(context, developer, { reason: 'Batch transcription correction',
    items: [context.record, second, third].map(r => ({ id: r.id, version: r.version, changes: { reason: 'Corrected in batch' } })) });
  assert.deepEqual(result.results.map(row => row.success), [true, false, true]);
  assert.equal(result.results[1].status, 500);
  assert.equal(JSON.stringify(result).includes('Private'), false);
  assert.equal(logs.length, 1); assert.equal(logs[0].includes('Private'), false);
  assert.equal((await context.repository.findById(context.record.id)).reason, 'Corrected in batch');
  assert.equal((await context.repository.findById(second.id)).reason, second.reason);
  assert.equal((await context.repository.findById(third.id)).reason, 'Corrected in batch');
});

test('cleared signatures can be signed again against corrected content without relaxing ordinary edit locks', async () => {
  const context = await fixture();
  await bulkCorrect(context, developer, batch(context.record, { reason: 'Corrected wording' }));
  let record = await context.repository.findById(context.record.id);
  await assert.rejects(context.service.update(record.id, { version: record.version, reason: 'Ordinary locked edit' }, 'fixture', developer), { statusCode: 403 });
  await unsign(context, developer, record.id, { version: record.version, reason: 'Reapprove corrected wording', path: 'signoff.gscTet.prepared' });
  record = await context.repository.findById(record.id);
  assert.equal((await loadCorrection(context, developer, record.id)).correctionNotice, null);
  const signed = await context.service.update(record.id, { version: record.version, internalReview: { signoff: { gscTet: { prepared: true } } } }, 'fixture', developer);
  assert.equal(signed.internalReview.signoff.gscTet.prepared, true);
  assert.equal(signed.documentControl.signatureBindings['signoff.gscTet.prepared'].contentHash, signed.documentControl.contentHash);
});

test('ordinary revision and fresh signing resolve corrected-after-signing notice for reused signature paths', async () => {
  const context = await fixture();
  await bulkCorrect(context, developer, batch(context.record, { reason: 'Corrected wording' }));
  let record = await context.repository.findById(context.record.id);
  assert.ok((await loadCorrection(context, developer, record.id)).correctionNotice);
  record = await context.service.startRevision(record.id, { version: record.version, reason: 'Ordinary revised approval' }, 'fixture', developer);
  assert.equal((await loadCorrection(context, developer, record.id)).correctionNotice, null);
  record = await context.service.update(record.id, { version: record.version, status: 'submitted' }, 'fixture', developer);
  record = await context.service.update(record.id, { version: record.version, internalReview: { signoff: { gscTet: { prepared: true } } } }, 'fixture', developer);
  assert.equal(record.internalReview.signoff.gscTet.prepared, true);
  assert.equal((await loadCorrection(context, developer, record.id)).correctionNotice, null);
});

test('row and shared condition corrections stay synchronized and permit the next normal signing save', async () => {
  for (const direction of ['row', 'shared']) {
    const repository = memoryRepository(), service = new PcnService(repository);
    let record = await service.create({ ...unsignedPayload, documentType: 'sc' }, 'fixture', developer);
    const conditions = { currentCondition: 'Corrected current condition', newCondition: 'Corrected proposed condition' };
    const changes = direction === 'shared' ? conditions : { changeRows: record.changeRows.map(row => ({ ...row, ...conditions })) };
    const result = await bulkCorrect({ repository, service }, developer, batch(record, changes));
    assert.equal(result.results[0].success, true);
    record = await repository.findById(record.id);
    assert.equal(record.currentCondition, conditions.currentCondition);
    assert.equal(record.newCondition, conditions.newCondition);
    assert.equal(record.changeRows[0].currentCondition, conditions.currentCondition);
    assert.equal(record.changeRows[0].newCondition, conditions.newCondition);
    const next = await service.update(record.id, { version: record.version, ...conditions,
      internalReview: { signoff: { gscTet: { checked: true } } } }, 'fixture', developer);
    assert.equal(next.internalReview.signoff.gscTet.checked, true);
  }
});

test('conflicting row and shared conditions fail without a partial document write', async () => {
  const context = await fixture();
  const result = await bulkCorrect(context, developer, batch(context.record, {
    currentCondition: 'Conflicting shared value', changeRows: context.record.changeRows.map(row => ({ ...row, currentCondition: 'Conflicting row value' }))
  }));
  assert.equal(result.results[0].success, false); assert.equal(result.results[0].status, 400);
  assert.deepEqual(await context.repository.findById(context.record.id), context.record);
});

test('Developer transaction inspector exposes correction reason and actor alongside before/after content', async () => {
  const context = await fixture();
  await bulkCorrect(context, developer, batch(context.record, { supplierName: 'Inspected corrected supplier' }));
  context.documents = { async list() { return []; } };
  context.authService = { repository: { async listUsers() { return [developer]; } } };
  const inspected = await require('../src/developerTools').inspectDeveloperPcn(context, developer, context.record.id);
  const latest = inspected.transactions.items[0];
  assert.equal(latest.actor, developer.displayName);
  assert.ok(latest.changes.some(change => change.path === 'supplierName' && change.after === 'Inspected corrected supplier'));
  assert.ok(latest.changes.some(change => change.path === 'documentControl.lastDeveloperCorrection.reason' && change.after === 'Correct transcription'));
  assert.ok(latest.changes.some(change => change.path === 'documentControl.lastDeveloperCorrection.actor' && change.after === 'user:dev-id'));
});

test('correction master-data lookup uses its existing transaction context instead of a second pool checkout', async () => {
  const context = await fixture();
  const transactionContext = { async getMasterData() { return require('../src/masterData'); } };
  context.service.resolveRecordMaster = async (record, suppliedContext) => {
    assert.equal(suppliedContext, transactionContext);
    return suppliedContext.getMasterData(record.masterDataVersionId);
  };
  const update = context.repository.update.bind(context.repository);
  context.repository.update = (id, updater, ...args) => update(id, current => updater(current, transactionContext), ...args);
  const response = await bulkCorrect(context, developer, batch(context.record, { reason: 'Single-transaction correction' }));
  assert.equal(response.results[0].success, true);
});
