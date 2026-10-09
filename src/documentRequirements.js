const documentRequirements = Object.freeze([
  { key: 'hazardousReport', label: "Supplier's Hazardous substance tested Report" },
  { key: 'greenProcurement', label: 'Green Procurement declaration' },
  { key: 'qmsEmsCertificate', label: 'Certificate of QMS / EMS' },
  { key: 'supplierDocument', label: "Supplier's document (Specify)" },
  { key: 'otherRequirement', label: 'Other requirement (Specify)' }
].map(item => Object.freeze({ ...item, field: `internalReview.docs.${item.key}` })));

module.exports = { documentRequirements };
