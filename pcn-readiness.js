(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PCN_READINESS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const documentRequirements = Object.freeze([
    { key: 'hazardousReport', label: "Supplier's Hazardous substance tested Report" },
    { key: 'greenProcurement', label: 'Green Procurement declaration' },
    { key: 'qmsEmsCertificate', label: 'Certificate of QMS / EMS' },
    { key: 'supplierDocument', label: "Supplier's document (Specify)" },
    { key: 'otherRequirement', label: 'Other requirement (Specify)' }
  ].map(item => Object.freeze({ ...item, field: `internalReview.docs.${item.key}` })));
  const at = (value, field) => field.split('.').reduce((item, key) => item?.[key], value);
  const textPresent = value => typeof value === 'string' && value.trim().length > 0;

  function buildChecks(record = {}, attachments = []) {
    const fields = [
      ['supplierName', 'Supplier name'], ['materialName', 'Material / chemical name'],
      ['selectedChange', 'Change description'], ['reason', 'Reason for change'],
      ['currentCondition', 'Current condition'], ['newCondition', 'New condition'],
      ['desiredStart', 'Target start date or lot']
    ];
    const core = fields.map(([key, label]) => ({ key, label, field: key,
      complete: textPresent(record[key]) || (['currentCondition', 'newCondition'].includes(key)
        && Array.isArray(record.changeRows) && record.changeRows.length > 0
        && record.changeRows.every(row => textPresent(row[key]))), blocking: true }));
    const sample = [{key:'sampleSubmitted',label:'Sample submission choice',field:'sampleSubmitted',
      complete:['yes','no'].includes(record.sampleSubmitted),blocking:true},
    ...(record.sampleSubmitted === 'yes' ? [{key:'sampleSubmittedDate',label:'Sample submission date',
      field:'sampleSubmittedDate',complete:textPresent(record.sampleSubmittedDate),blocking:false}] : [])];
    const required = documentRequirements.filter(item => at(record, item.field) === true).map(item => ({
      ...item, requirementName: item.key, attachment: true, blocking: true,
      complete: attachments.some(file => !file.deletedAt && !file.DeletedAt && file.isDeleted !== true
        && (file.scanStatus || file.ScanStatus) === 'clean'
        && [item.key,item.label].includes(file.requirementName || file.RequirementName))
    }));
    const items = [...core, ...sample, ...required];
    return { items, ready: items.every(item => !item.blocking || item.complete) };
  }
  return Object.freeze({ documentRequirements, buildChecks });
});
