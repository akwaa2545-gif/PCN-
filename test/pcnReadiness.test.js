const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const shared = require('../pcn-readiness');
const server = require('../src/documentChecks');

test('browser and server readiness share identical policies and output', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../pcn-readiness'), 'utf8'), context);
  for (const record of [{}, { supplierName: 'Supplier', sampleSubmitted: 'yes', changeRows: [{currentCondition:'Old',newCondition:'New'}],
    internalReview: { docs: { hazardousReport: true, greenProcurement: true } } }]) {
    const files = [{ RequirementName:'hazardousReport', ScanStatus:'clean' }];
    assert.deepEqual(shared.buildChecks(record,files),server.buildChecks(record,files));
    assert.deepEqual(JSON.parse(JSON.stringify(context.PCN_READINESS.buildChecks(record,files))),shared.buildChecks(record,files));
  }
  assert.equal(shared.documentRequirements.length,5);
  assert.equal(Object.isFrozen(shared.documentRequirements),true);
});

test('readiness preserves required clean file checks and advisory sample date', () => {
  const record = {supplierName:'S',materialName:'M',selectedChange:'C',reason:'R',currentCondition:'O',newCondition:'N',desiredStart:'Lot',sampleSubmitted:'yes',internalReview:{docs:{greenProcurement:true}}};
  for (const file of [{scanStatus:'pending'}, {scanStatus:'clean',isDeleted:true}, {scanStatus:'clean',DeletedAt:'now'}]) {
    assert.equal(shared.buildChecks(record,[{requirementName:'greenProcurement',...file}]).ready,false);
  }
  const result = shared.buildChecks(record,[{requirementName:'greenProcurement',scanStatus:'clean'}]);
  assert.equal(result.ready,true);
  assert.equal(result.items.find(item => item.key==='sampleSubmittedDate').blocking,false);
  assert.equal(shared.buildChecks({}).items.length,8);
});
