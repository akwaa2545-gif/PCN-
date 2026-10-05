const test = require('node:test');
const assert = require('node:assert/strict');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, validPayload } = require('./helpers/apiHarness');
const admin = {id:'admin-id',roles:['admin']};

test('completed PCNs are immutable and signed content cannot be changed during review', async () => {
  const repository = memoryRepository();
  const service = new PcnService(repository);
  let record = await service.create(validPayload, 'admin', admin);
  await assert.rejects(service.update(record.id, {version:record.version,riskLevel:'RL0'}, 'admin', admin), {statusCode:403});
  await assert.rejects(service.update(record.id, {version:record.version,materialName:'Replaced signed material'}, 'admin', admin), {statusCode:403});
  for (const status of ['approved','rejected','closed']) {
    record = await repository.update(record.id, current => ({...current,status}), 'test', record.version);
    await assert.rejects(service.update(record.id, {version:record.version,internalReview:{decision:{agreed:false}}}, 'admin', admin), {statusCode:403});
  }
});
