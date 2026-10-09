const test = require('node:test');
const assert = require('node:assert/strict');
const { recoveryKey, canRecoverControl, captureControls, applyControls, exportStamp, recoveredRows } = require('../document-bridge');

const control = (id, value, extra = {}) => ({id, value, type:'text', tagName:'INPUT', dataset:{}, ...extra});
test('recovery excludes disabled, signing and identity controls but keeps document edits', () => {
  const controls = [control('reason','Changed'), control('',true,{type:'checkbox',checked:true,dataset:{internalField:'signoff.gscTet.approved'}}),
    control('',true,{type:'checkbox',checked:true,dataset:{internalField:'supplierSignoff.checked.checked'}}),
    control('', 'Signer',{dataset:{internalField:'signoff.gscTet.approvedName'}}), control('materialName','Locked',{disabled:true}),
    control('',true,{type:'checkbox',checked:true,dataset:{internalField:'docs.hazardousReport'}})];
  assert.deepEqual(captureControls(controls), [{key:'id:reason',type:'text',value:'Changed'}, {key:'review:docs.hazardousReport',type:'checkbox',value:true}]);
  assert.equal(canRecoverControl(control('hidden','value',{type:'hidden'})),false);
});
test('recovery matches stable dynamic keys and rechecks current permission', () => {
  const row = control('', 'Original',{tagName:'TEXTAREA',type:'textarea',dataset:{recoveryKey:'rawMaterial:option:currentCondition'}});
  const signed = control('',false,{type:'checkbox',checked:false,dataset:{internalField:'qateFinal.signoff.prepared'}});
  const locked = control('materialName','Original',{disabled:true});
  const getControls = () => [row,signed,locked];
  applyControls([{key:recoveryKey(row),type:'textarea',value:'Recovered'}, {key:'review:qateFinal.signoff.prepared',type:'checkbox',value:true},
    {key:'id:materialName',type:'text',value:'Forged'}],getControls);
  assert.equal(row.value,'Recovered'); assert.equal(signed.checked,false); assert.equal(locked.value,'Original');
});
test('export distinguishes saved approval, draft and unsaved previews', () => {
  const record={id:'PCN-2026-0001',status:'approved',documentControl:{contentRevision:3}};
  assert.deepEqual(exportStamp(record,false),{id:record.id,revision:'3',status:'APPROVED',watermark:''});
  assert.equal(exportStamp({...record,status:'submitted'},false).watermark,'DRAFT');
  assert.equal(exportStamp(record,true).watermark,'UNSAVED PREVIEW');
  assert.equal(exportStamp({},false).revision,'Not recorded');
});

test('recovery imports edited row descriptions and conditions into the document model', () => {
  const controls=[control('', 'Changed description',{dataset:{recoveryKey:'rawMaterial:Original option:text'}}),
    control('', 'Current recovered',{dataset:{recoveryKey:'rawMaterial:Original option:currentCondition'}}),
    control('', 'New recovered',{dataset:{recoveryKey:'rawMaterial:Original option:newCondition'}})];
  const rows=[{optionText:'Original option',text:'Original option',currentCondition:'Old',newCondition:'Old new',risk:'RL2'}];
  assert.deepEqual(recoveredRows(rows,'rawMaterial',controls),[{optionText:'Original option',text:'Changed description',currentCondition:'Current recovered',newCondition:'New recovered',risk:'RL2'}]);
});
