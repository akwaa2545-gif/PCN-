const test = require('node:test');
const assert = require('node:assert/strict');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, validPayload, unsignedPayload } = require('./helpers/apiHarness');
const admin = {id:'admin-id',roles:['admin']};

test('completed PCNs are immutable and signed content cannot be changed during review', async () => {
  const repository = memoryRepository();
  const service = new PcnService(repository);
  let record = await service.create(unsignedPayload, 'admin', admin);
  record = await repository.seedHistoricalReview(record.id, validPayload.internalReview);
  await assert.rejects(service.update(record.id, {version:record.version,riskLevel:'RL0'}, 'admin', admin), {statusCode:403});
  await assert.rejects(service.update(record.id, {version:record.version,materialName:'Replaced signed material'}, 'admin', admin), {statusCode:403});
  for (const status of ['approved','rejected','closed']) {
    record = await repository.update(record.id, current => ({...current,status}), 'test', record.version);
    await assert.rejects(service.update(record.id, {version:record.version,internalReview:{decision:{agreed:false}}}, 'admin', admin), {statusCode:403});
  }
});

test('ancestor replacement is rejected atomically and preserves historical signatures', async () => {
  const repository = memoryRepository();
  const service = new PcnService(repository);
  const created = await service.create(unsignedPayload, 'admin', admin);
  const signed = await repository.seedHistoricalReview(created.id, validPayload.internalReview);
  const reviewer = { id: 'reviewer-id', roles: ['reviewer'], department: 'other', signingStep: null };
  for (const review of [{ qateFinal: '' }, { signoff: false }, { tapbu: null }, { signoff: { gscTet: '' } }]) {
    await assert.rejects(service.update(signed.id, { version: signed.version, internalReview: review }, 'reviewer', reviewer), { statusCode: 400 });
    assert.deepEqual(await repository.findById(signed.id), signed);
  }
});
