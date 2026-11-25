const { ApiError } = require('./apiError');
const baseline = require('./masterData');
const baselineDefinition = () => structuredClone(Object.fromEntries(['formDefinitions', 'commonDocuments', 'workflowBase', 'statusDefinitions', 'adminItems'].map(key => [key, baseline[key]])));

const formKeys = Object.freeze(['rawMaterial', 'packaging']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function exact(value, keys, label) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new ApiError(400, `Invalid ${label}`);
  }
}
function validateChangeCategories(input) {
  exact(input, ['versionId', 'reason', 'forms'], 'Content of Changes settings');
  if (!Number.isSafeInteger(input.versionId) || input.versionId < 1) throw new ApiError(400, 'Reload the current master data before saving');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 1200) throw new ApiError(400, 'Enter a reason of 1–1200 characters');
  exact(input.forms, formKeys, 'change forms');
  const forms = Object.fromEntries(formKeys.map(key => {
    const rows = input.forms[key];
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) throw new ApiError(400, 'Each form needs 1–100 change options');
    const seen = new Set();
    const options = rows.map(row => {
      exact(row, ['text', 'risk', 'enabled'], 'change option');
      if (typeof row.text !== 'string' || !row.text.trim() || row.text.trim().length > 500) throw new ApiError(400, 'Change wording must contain 1–500 characters');
      if (!['RL0', 'RL1', 'RL2', 'RL3'].includes(row.risk) || typeof row.enabled !== 'boolean') throw new ApiError(400, 'Choose a valid risk level and enabled setting');
      const text = row.text.trim(), identity = text.toLowerCase();
      if (seen.has(identity)) throw new ApiError(400, 'Each change option must have unique wording within its form');
      seen.add(identity);
      return { text, risk: row.risk, enabled: row.enabled };
    });
    if (!options.some(row => row.enabled)) throw new ApiError(400, 'Keep at least one enabled change option in each form');
    return [key, options];
  }));
  return { versionId: input.versionId, reason: input.reason.trim(), forms };
}
function categorySettings(master) {
  return { versionId: master.versionId, forms: Object.fromEntries(formKeys.map(key => [key,
    master.formDefinitions[key].riskOptions.map(row => ({ text: row.text, risk: row.risk, enabled: row.enabled !== false }))])) };
}
function publicMaster(master, { includeDisabled = false } = {}) {
  const { changeCategoriesPublication: omitted, ...definition } = structuredClone(Object.fromEntries(Object.entries(master).filter(([, value]) => typeof value !== 'function')));
  return { ...definition, formDefinitions: Object.fromEntries(Object.entries(definition.formDefinitions).map(([key, form]) =>
    [key, { ...form, riskOptions: form.riskOptions.filter(option => includeDisabled || option.enabled !== false) }])) };
}
async function recordMaster(repository, record) {
  if (record.masterDataVersionId == null) return baselineDefinition();
  const master = await repository.getMasterData(record.masterDataVersionId);
  if (master.versionId !== record.masterDataVersionId) throw new ApiError(503, 'The saved master data version is unavailable');
  return master;
}
function buildDefinition(current, input, publication) {
  const { versionId: omitted, ...definition } = structuredClone(current);
  return { ...definition, formDefinitions: Object.fromEntries(Object.entries(definition.formDefinitions).map(([key, form]) =>
    [key, formKeys.includes(key) ? { ...form, riskOptions: structuredClone(input.forms[key]) } : form])),
  changeCategoriesPublication: { ...publication, reason: input.reason } };
}

module.exports = { formKeys, validateChangeCategories, categorySettings, publicMaster, recordMaster, buildDefinition, baselineDefinition };
