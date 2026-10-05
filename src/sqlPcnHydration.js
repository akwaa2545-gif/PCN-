const scalarFields = {
  status: 'Status', changeForm: 'ChangeForm', riskLevel: 'RiskLevel', selectedChange: 'SelectedChange',
  supplierName: 'SupplierName', manufacturerName: 'ManufacturerName', materialName: 'MaterialName',
  desiredStart: 'DesiredStartText', sampleSubmitted: 'SampleSubmitted', currentCondition: 'CurrentCondition',
  newCondition: 'NewCondition', reason: 'Reason', identification: 'Identification', sampleLocation: 'SampleLocation',
  priceLevel: 'PriceLevel', sourceTemplate: 'SourceTemplate', changeType: 'ChangeType',
  createdAt: 'CreatedAt', updatedAt: 'UpdatedAt', submittedAt: 'SubmittedAt', ownerUserId: 'OwnerUserId',
  masterDataVersionId: 'MasterDataVersionId'
};
const childTables = { changeRows: 'PcnChangeRows', documents: 'PcnDocuments', route: 'PcnRouteSteps', comments: 'PcnComments', approvals: 'PcnApprovals' };
function versionHex(value) {
  return Buffer.isBuffer(value) ? value.toString('hex') : String(value || '').replace(/^0x/i, '').toLowerCase();
}
function splitRecord(record) {
  const known = new Set(['id', 'version', 'internalReview', ...Object.keys(scalarFields), ...Object.keys(childTables)]);
  const extras = Object.fromEntries(Object.entries(record).filter(([key]) => !known.has(key)));
  const parent = Object.fromEntries(Object.entries(scalarFields).filter(([key]) => key in record).map(([key, column]) => [column, record[key]]));
  const presentFields = Object.keys(record).filter(key => key !== 'version');
  const nullFields = ['internalReview', ...Object.keys(childTables)].filter(key => record[key] === null).map(key => `null:${key}`);
  return { parent: { ...parent, LegacyExtrasJson: JSON.stringify(extras), PresentFieldsJson: JSON.stringify([...presentFields, ...nullFields]) },
    review: structuredClone(record.internalReview ?? {}),
    children: Object.fromEntries(Object.keys(childTables).map(key => [key, structuredClone(record[key] || [])])) };
}
function hydratePcn(parent, review = {}, children = {}) {
  const present = parent.PresentFieldsJson ? new Set(JSON.parse(parent.PresentFieldsJson)) : null;
  const scalars = Object.fromEntries(Object.entries(scalarFields).filter(([key, column]) => (!present || present.has(key)) && column in parent)
    .map(([key, column]) => [key, parent[column] instanceof Date ? parent[column].toISOString() : parent[column]]));
  return { ...JSON.parse(parent.LegacyExtrasJson || '{}'), ...scalars, id: parent.PcnCode,
    ...(!present || present.has('internalReview') ? { internalReview: present?.has('null:internalReview') ? null : review } : {}),
    ...Object.fromEntries(Object.keys(childTables).filter(key => !present || present.has(key)).map(key => [key, present?.has(`null:${key}`) ? null : children[key] || []])),
    version: versionHex(parent.RowVersion) };
}
module.exports = { scalarFields, childTables, splitRecord, hydratePcn, versionHex };
