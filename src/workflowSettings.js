const { ApiError } = require('./apiError');

const RULES = Object.freeze([
  { key: 'gscTet', stageKey: 'signoff.gscTet', department: 'gscTet', label: 'GSC/TET', defaultDays: null },
  { key: 'prodEngTet', stageKey: 'signoff.prodEngTet', department: 'prodEngTet', label: 'Prod.Eng/TET', defaultDays: 3 },
  { key: 'prodEngTa', timingKey: 'prodEngTet', stageKey: 'signoff.prodEngTet', department: 'prodEngTa', label: 'Prod.Eng/TA', defaultDays: 3 },
  { key: 'prodEngSc', timingKey: 'prodEngTet', stageKey: 'signoff.prodEngTet', department: 'prodEngSc', label: 'Prod.Eng/SC', defaultDays: 3 },
  { key: 'qaTet', stageKey: 'signoff.qaTet', department: 'qaTet', label: 'QA/TET', defaultDays: 3 },
  { key: 'gscTapbu', stageKey: 'tapbu.gsc', department: 'gscTapbu', label: 'GSC/TaPBU', defaultDays: null },
  { key: 'qaTapbu', stageKey: 'tapbu.qa', department: 'qaTapbu', label: 'QA/TaPBU', defaultDays: null },
  { key: 'qaFinal', stageKey: 'qateFinal.signoff', department: 'qaTet', label: 'QA/TET Final Judgment', defaultDays: null }
].map(Object.freeze));

function defaultWorkflowSettings() {
  return { schemaVersion: 1, version: 0, pendingDays: Object.fromEntries(RULES.map(rule => [rule.key, rule.defaultDays])), updatedAt: null, updatedBy: null };
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validateWorkflowSettings(input) {
  if (!exactKeys(input, ['schemaVersion', 'version', 'pendingDays']) || input.schemaVersion !== 1
    || !Number.isSafeInteger(input.version) || input.version < 0 || !exactKeys(input.pendingDays, RULES.map(rule => rule.key))) {
    throw new ApiError(400, 'Workflow settings require schemaVersion 1, a current version, and all eight pending-day rules; reload settings before saving');
  }
  for (const rule of RULES) {
    const days = input.pendingDays[rule.key];
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) {
      throw new ApiError(400, `${rule.label} pending days must be a whole number from 1 to 365, or null to disable`);
    }
  }
  return { schemaVersion: 1, version: input.version, pendingDays: { ...input.pendingDays } };
}

function normalizeWorkflowSettings(settings) {
  const legacyKeys = RULES.filter(rule => !['prodEngTa', 'prodEngSc'].includes(rule.key)).map(rule => rule.key);
  const pendingDays = exactKeys(settings?.pendingDays, legacyKeys)
    ? { ...settings.pendingDays, prodEngTa: settings.pendingDays.prodEngTet, prodEngSc: settings.pendingDays.prodEngTet }
    : settings?.pendingDays;
  validateWorkflowSettings({ schemaVersion: settings?.schemaVersion, version: settings?.version, pendingDays });
  return pendingDays === settings.pendingDays ? settings : { ...settings, pendingDays };
}

async function readWorkflowSettings(repository) {
  if (typeof repository?.getWorkflowSettings === 'function') return normalizeWorkflowSettings(await repository.getWorkflowSettings());
  if (repository?.isSql) throw new ApiError(503, 'Workflow settings are unavailable');
  return defaultWorkflowSettings();
}

module.exports = { RULES, defaultWorkflowSettings, validateWorkflowSettings, normalizeWorkflowSettings, readWorkflowSettings };
