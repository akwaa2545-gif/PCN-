(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PCN_CREATE_MODEL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const textFields = ['supplierName','manufacturerName','materialName','selectedChange','reason',
    'currentCondition','newCondition','desiredStart','sampleSubmittedDate','identification','sampleLocation'];
  const requirementKeys = ['hazardousReport','greenProcurement','qmsEmsCertificate','supplierDocument','otherRequirement'];
  const noteKeys = ['supplierDocumentNote','otherRequirementNote'];
  const string = value => typeof value === 'string' ? value.trim() : '';
  const definitions = master => master?.formDefinitions || master || {};
  const emptyDocs = () => Object.fromEntries([...requirementKeys.map(key => [key,false]),...noteKeys.map(key => [key,''])]);

  function blank(master) {
    const forms = definitions(master);
    const changeForm = forms.rawMaterial ? 'rawMaterial' : Object.keys(forms)[0] || 'rawMaterial';
    return { status:'draft',changeForm,riskLevel:'RL2',...Object.fromEntries(textFields.map(key=>[key,''])),
      sampleSubmitted:'pending',priceLevel:'no-change',changeRows:[],internalReview:{materialCodeDescription:'',docs:emptyDocs()} };
  }

  function copyRows(rows) {
    return (Array.isArray(rows) ? rows : []).filter(row => row && typeof row==='object').map(row => ({
      optionText:string(row.optionText || row.originalText || row.text),risk:string(row.risk),
      text:string(row.text ?? row.optionText ?? row.originalText),
      currentCondition:string(row.currentCondition),newCondition:string(row.newCondition)
    }));
  }

  function toPayload(record = {}) {
    const review=record.internalReview || {};
    const docs={...emptyDocs(),...Object.fromEntries(requirementKeys.map(key=>[key,review.docs?.[key]===true])),
      ...Object.fromEntries(noteKeys.map(key=>[key,string(review.docs?.[key])]))};
    return {changeForm:string(record.changeForm)||'rawMaterial',riskLevel:string(record.riskLevel)||'RL2',
      ...Object.fromEntries(textFields.map(key=>[key,string(record[key])])),
      sampleSubmitted:string(record.sampleSubmitted)||'pending',priceLevel:string(record.priceLevel)||'no-change',
      changeRows:copyRows(record.changeRows),internalReview:{materialCodeDescription:string(review.materialCodeDescription),docs}};
  }

  function fromTemplate(source = {}, {canSetRequirements=false} = {}) {
    const content=toPayload(source);
    const selected=content.changeRows.find(row=>row.text===content.selectedChange || row.optionText===content.selectedChange);
    const aligned=selected?{...content,selectedChange:selected.text,riskLevel:selected.risk,
      currentCondition:selected.currentCondition,newCondition:selected.newCondition}:content;
    return {...aligned,status:'draft',...(source.isTestDocument===true?{isTestDocument:true}:{}),
      internalReview:canSetRequirements?content.internalReview:{materialCodeDescription:'',docs:emptyDocs()}};
  }

  function selectChange(record, option, changes = {}) {
    if (!option || !string(option.text) || !string(option.risk)) throw new TypeError('Choose a valid change option.');
    const rows=copyRows(record.changeRows);
    const existing=rows.find(row=>row.optionText===option.text);
    const entered=value=>typeof value==='string'?value:'';
    const row={optionText:option.text,risk:option.risk,text:entered(changes.text ?? existing?.text ?? option.text),
      currentCondition:entered(changes.currentCondition ?? existing?.currentCondition),
      newCondition:entered(changes.newCondition ?? existing?.newCondition)};
    const nextRows=existing?rows.map(item=>item.optionText===option.text?row:item):[...rows,row];
    return {...record,selectedChange:row.text,riskLevel:row.risk,currentCondition:row.currentCondition,
      newCondition:row.newCondition,changeRows:nextRows};
  }

  function changeForm(record, formId, master) {
    if (!definitions(master)[formId]) throw new TypeError('Choose a valid change form.');
    if (record.changeForm===formId) return {...record,changeRows:copyRows(record.changeRows)};
    return {...record,changeForm:formId,selectedChange:'',currentCondition:'',newCondition:'',changeRows:[]};
  }

  function sample(master) {
    const forms=definitions(master);
    const option=forms.rawMaterial?.riskOptions?.find(item=>item.risk==='RL2') || forms.rawMaterial?.riskOptions?.[0];
    if (!option) throw new TypeError('Raw material change options are unavailable.');
    return selectChange({...blank(master),changeForm:'rawMaterial',isTestDocument:true,
      supplierName:'TEST Supplier Co., Ltd.',manufacturerName:'TEST Manufacturer',materialName:'TEST Copper alloy strip',
      reason:'Evaluate the proposed material specification change using this testing document.',
      desiredStart:'TEST pilot lot 001',sampleSubmitted:'no',identification:'TEST lots are clearly marked for review.',
      sampleLocation:'TEST laboratory'},option,{currentCondition:'Current approved material specification and inspection method.',
      newCondition:'Proposed tighter material tolerance with the same intended application.'});
  }

  function fieldStage(field) {
    if (['materialCodeDescription','internalReview.materialCodeDescription'].includes(field) || field?.startsWith('internalReview.docs.')) return 'documents';
    if (['supplierName','manufacturerName','materialName','changeForm','riskLevel'].includes(field)) return 'details';
    if ([...textFields,'sampleSubmitted','priceLevel','changeRows'].includes(field)) return 'changes';
    return 'review';
  }

  function hasMeaningfulContent(document, master) {
    const value=toPayload(document);
    const empty=toPayload(blank(master));
    return JSON.stringify(value)!==JSON.stringify(empty) || document.isTestDocument===true;
  }
  return Object.freeze({blank,toPayload,fromTemplate,sample,fieldStage,selectChange,changeForm,hasMeaningfulContent});
});
