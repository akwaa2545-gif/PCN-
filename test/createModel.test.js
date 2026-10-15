const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../create-model');
const master = require('../src/masterData');
const { buildChecks } = require('../src/documentChecks');

test('blank remains empty while sample contains normal validated draft data', () => {
  const blank = model.blank(master);
  assert.equal(blank.status,'draft');
  assert.equal(blank.supplierName,'');
  assert.equal(model.hasMeaningfulContent(blank,master),false);
  const sample = model.sample(master);
  assert.equal(sample.status,'draft');
  assert.match(sample.supplierName,/TEST/i);
  assert.equal(sample.sampleSubmitted,'no');
  assert.equal(sample.isTestDocument,true);
  assert.notEqual(blank.isTestDocument,true);
  assert.equal(model.toPayload(sample).isTestDocument,undefined);
  assert.equal(buildChecks(sample).ready,true);
  assert.equal(model.hasMeaningfulContent(sample,master),true);
  assert.ok(master.formDefinitions.rawMaterial.riskOptions.some(option => option.text===sample.selectedChange && option.risk===sample.riskLevel));
  assert.equal(Object.keys(sample).some(key=>/bypass|skip|testMode/i.test(key)),false);
});

test('payload and templates whitelist content and never carry identity, approvals or attachment evidence', () => {
  const source={...model.sample(master),id:'secret-id',ownerUserId:'owner',status:'approved',version:4,attachments:[{id:'file'}],mailRoutingState:{active:1},
    internalReview:{materialCodeDescription:'MAT01',docs:{greenProcurement:true,otherRequirementNote:'Details'},signoff:{gscTet:{approved:true}},supplierSignoff:{prepared:{checked:true}},pcnCode:'Old'}};
  const before=JSON.stringify(source);
  for (const copy of [model.toPayload(source),model.fromTemplate(source,{canSetRequirements:true})]) {
    assert.ok(copy.status===undefined || copy.status==='draft');
    for(const key of ['id','version','ownerUserId','attachments','mailRoutingState']) assert.equal(Object.hasOwn(copy,key),false);
    assert.deepEqual(Object.keys(copy.internalReview).sort(),['docs','materialCodeDescription']);
    assert.equal(copy.internalReview.docs.greenProcurement,true);
    assert.equal(copy.internalReview.pcnCode,undefined);
  }
  assert.equal(model.toPayload(source).status,undefined);
  const restricted=model.fromTemplate(source,{canSetRequirements:false});
  assert.equal(restricted.internalReview.docs.greenProcurement,false);
  assert.equal(restricted.internalReview.materialCodeDescription,'');
  assert.equal(JSON.stringify(source),before);
  assert.equal(model.fromTemplate({...source,isTestDocument:true},{canSetRequirements:false}).isTestDocument,true);
  assert.notEqual(model.fromTemplate({...source,isTestDocument:'true'},{canSetRequirements:false}).isTestDocument,true);
});

test('change selection and templates preserve populated rows by stable option identity', () => {
  const options=master.formDefinitions.rawMaterial.riskOptions;
  const first=options[0], second=options[4];
  const initial={...model.blank(master),changeRows:[{optionText:first.text,text:'Specific first change',risk:first.risk,currentCondition:'Original',newCondition:'Proposed'}]};
  const chosen=model.selectChange(initial,first);
  assert.equal(chosen.selectedChange,'Specific first change');
  assert.equal(chosen.currentCondition,'Original');
  const next=model.selectChange(chosen,second,{currentCondition:'Old second',newCondition:'New second',text:'Specific second'});
  assert.equal(next.selectedChange,'Specific second');
  assert.equal(next.riskLevel,second.risk);
  assert.equal(next.changeRows.length,2);
  const copy=model.fromTemplate(next,{canSetRequirements:true});
  assert.deepEqual(copy.changeRows,next.changeRows);
  const changed=model.changeForm(next,'packaging',master);
  assert.equal(changed.changeForm,'packaging');
  assert.equal(changed.selectedChange,'');
  assert.deepEqual(changed.changeRows,[]);
  assert.equal(next.changeForm,'rawMaterial');
});

test('field stages route exact validation keys to guided sections',()=>{
  assert.equal(model.fieldStage('supplierName'),'details');
  assert.equal(model.fieldStage('selectedChange'),'changes');
  assert.equal(model.fieldStage('reason'),'changes');
  assert.equal(model.fieldStage('internalReview.docs.greenProcurement'),'documents');
});
