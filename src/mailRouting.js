const crypto = require('node:crypto');
const { routeGroups } = require('./workflowAccess');

const actions = Object.freeze(['approved', 'checked', 'prepared']);
const departments = Object.freeze([
  { key: 'gscTet', label: 'GSC/TET' }, { key: 'prodEngTet', label: 'Prod.Eng/TET' },
  { key: 'qaTet', label: 'QA/TET' }, { key: 'gscTapbu', label: 'GSC/TaPBU' }, { key: 'qaTapbu', label: 'QA/TaPBU' }
].map(Object.freeze));
const stageDepartments = Object.freeze({ 'signoff.gscTet': 'gscTet', 'signoff.prodEngTet': 'prodEngTet',
  'signoff.qaTet': 'qaTet', 'tapbu.gsc': 'gscTapbu', 'tapbu.qa': 'qaTapbu', 'qateFinal.signoff': 'qaTet' });
const mailGroups = Object.freeze([...departments.flatMap(department => actions.map(action => Object.freeze({
  key: `department.${department.key}.${action}`, label: `${department.label} ${action[0].toUpperCase()}${action.slice(1)}`,
  departmentKey: department.key, action
}))), Object.freeze({ key: 'supplierNotification', label: 'GSC/TET Supplier Notification', departmentKey: null, action: null })]);
const legacyDefinitions = Object.freeze([
  { key: 'signoff.gscTet', label: 'GSC/TET' }, { key: 'signoff.prodEngTet', label: 'Prod.Eng/TET' },
  { key: 'signoff.qaTet', label: 'QA/TET' }, { key: 'tapbu.gsc', label: 'GSC/TaPBU' },
  { key: 'tapbu.qa', label: 'QA/TaPBU' }, { key: 'qateFinal.signoff', label: 'QA/TET Final Judgment' },
  { key: 'supplierNotification', label: 'GSC/TET Supplier Notification' }
].map(Object.freeze));

function settingsVersion(settings) {
  return crypto.createHash('sha256').update(JSON.stringify(settings || {})).digest('hex');
}

function safeRecipients(recipients) {
  return (Array.isArray(recipients) ? recipients : []).filter(entry => entry && typeof entry === 'object').map(entry =>
    Object.fromEntries(Object.entries(entry).filter(([key, value]) =>
      ['id', 'email', 'mail', 'displayName', 'name', 'jobTitle', 'position', 'title', 'department', 'photo', 'photoUrl', 'picture', 'avatar'].includes(key) && typeof value === 'string'
    ).map(([key, value]) => {
      if (['photo', 'photoUrl', 'picture', 'avatar'].includes(key)) {
        const image = value.trim();
        const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(image);
        return [key, image.length <= 100 * 1024 && match && match[1].length % 4 === 0 ? image : ''];
      }
      return [key, value.slice(0, ['email', 'mail'].includes(key) ? 320 : key === 'id' ? 200 : 120)];
    })));
}

function normalizeMailRouting(value = {}) {
  const settings = value || {};
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const legacy = settings.schemaVersion === 2 ? (Array.isArray(settings.legacyGroups) ? settings.legacyGroups : []) : groups;
  return {
    schemaVersion: 2, version: settingsVersion(value),
    groups: mailGroups.map(definition => {
      const stored = groups.find(group => group?.key === definition.key);
      return { ...definition, emails: typeof stored?.emails === 'string' ? stored.emails.slice(0, 1000) : '', recipients: safeRecipients(stored?.recipients) };
    }),
    // Older department contacts cannot be assigned to a signoff step automatically.
    // Preserve their complete profile records for explicit administrator assignment.
    legacyGroups: legacyDefinitions.map(definition => {
      const stored = legacy.find(group => group?.key === definition.key);
      return { ...definition, emails: typeof stored?.emails === 'string' ? stored.emails.slice(0, 1000) : '', recipients: safeRecipients(stored?.recipients) };
    })
  };
}

function resolveNextMailTarget(record) {
  if (!record || ['draft', 'supplier_action', 'rejected', 'closed'].includes(record.status)) return null;
  const review = record.internalReview || {};
  for (const stageKey of routeGroups(record.riskLevel)) {
    const step = stageKey.split('.').reduce((entry, key) => entry?.[key], review);
    const action = actions.find(key => step?.[key] !== true);
    if (!action) continue;
    const departmentKey = stageDepartments[stageKey];
    const group = mailGroups.find(entry => entry.departmentKey === departmentKey && entry.action === action);
    return { stageKey, departmentKey, action, groupKey: group.key,
      label: stageKey === 'qateFinal.signoff' ? `QA/TET Final Judgment ${action[0].toUpperCase()}${action.slice(1)}` : group.label,
      ...(stageKey.startsWith('tapbu.') && !review.tapbu?.need ? { blockedReason: 'tapbu_requirement_not_selected' } : {}) };
  }
  return { stageKey: 'supplierNotification', departmentKey: null, action: null,
    groupKey: 'supplierNotification', label: 'GSC/TET Supplier Notification' };
}

module.exports = { actions, departments, mailGroups, legacyDefinitions, stageDepartments, settingsVersion, normalizeMailRouting, resolveNextMailTarget };
