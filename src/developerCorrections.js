const { isDeepStrictEqual } = require('node:util');
const { ApiError } = require('./apiError');
const { isDeveloperAssignment, actions, stageDepartments, departments } = require('./signingPermissions');
const { assertRecordAccess } = require('./workflowAccess');
const { contentHash } = require('./documentControl');
const { applyReviewTiming } = require('./reviewTiming');
const { isCode, departmentForStage } = require('../pcn-types');

const editableFields = Object.freeze(['selectedChange', 'supplierName', 'manufacturerName', 'materialName',
  'desiredStart', 'sampleSubmitted', 'sampleSubmittedDate', 'currentCondition', 'newCondition', 'changeRows',
  'reason', 'identification', 'sampleLocation', 'priceLevel']);
const orderedPaths = Object.freeze([...Object.keys(stageDepartments).flatMap(stage => actions.map(action => `${stage}.${action}`)),
  ...actions.map(action => `supplierSignoff.${action}`)]);
const terminal = status => ['approved', 'rejected', 'closed'].includes(status);
const at = (value, path) => path.split('.').reduce((item, key) => item?.[key], value);
const checked = (record, path) => at(record.internalReview, path.startsWith('supplierSignoff.') ? `${path}.checked` : path) === true;
const select = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]));
class Unchanged extends Error { constructor(record) { super('No content changes'); this.record = record; } }

function requireDeveloper(user) {
  if (!user || user.isActive !== true || !isDeveloperAssignment(user) || user.roles.length !== 1
    || typeof user.roles[0] !== 'string' || user.roles[0].toLowerCase() !== 'developer') {
    throw new ApiError(403, 'Developer access required');
  }
}
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new ApiError(400, `Invalid ${label}`);
  }
}
function id(value) { if (!isCode(value)) throw new ApiError(400, 'Invalid PCN id'); }
function version(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{16}$/.test(value)) throw new ApiError(400, 'Current PCN version is required');
}
function reason(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 1200) throw new ApiError(400, 'Enter a correction reason of 1–1200 characters');
  return value.trim();
}
function validateChanges(value) {
  object(value, editableFields, 'correction fields');
  if (!Object.keys(value).length) throw new ApiError(400, 'Choose at least one content field to correct');
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'changeRows' && typeof entry !== 'string') throw new ApiError(400, `Invalid ${key}`);
  }
  if (Object.hasOwn(value, 'changeRows')) {
    if (!Array.isArray(value.changeRows) || value.changeRows.length > 100) throw new ApiError(400, 'Invalid change rows');
    for (const row of value.changeRows) {
      object(row, ['risk', 'optionText', 'originalText', 'text', 'currentCondition', 'newCondition'], 'change row');
      if (Object.values(row).some(entry => typeof entry !== 'string')) throw new ApiError(400, 'Change row values must be text');
    }
  }
}
function pathLabel(record, path) {
  const action = path.split('.').at(-1);
  const stage = path.slice(0, -(action.length + 1));
  const department = stage === 'supplierSignoff' ? 'Document header' :
    departments.find(item => item.key === departmentForStage(record, stage))?.label || stage;
  return `${department}${stage === 'qateFinal.signoff' ? ' Final judgment' : ''} — ${action[0].toUpperCase()}${action.slice(1)}`;
}
function signatureOptions(record) {
  return orderedPaths.filter(path => checked(record, path)).map(path => ({ path, label: pathLabel(record, path),
    clears: orderedPaths.slice(orderedPaths.indexOf(path)).filter(candidate => checked(record, candidate)), reopens: terminal(record.status) }));
}
function correctionNotice(record) {
  const retainedSignatures = (record.documentControl?.correctedSignatures || []).filter(path => {
    const binding = record.documentControl?.signatureBindings?.[path];
    return checked(record, path) && (!binding?.contentHash || binding.contentHash !== contentHash(record));
  });
  return retainedSignatures.length ? { ...select(record.documentControl.lastDeveloperCorrection || {}, ['reason', 'actor', 'time', 'kind']), retainedSignatures } : null;
}
async function loadCorrection(context, user, code) {
  requireDeveloper(user); id(code);
  const record = await context.service.getById(code, user);
  return { record: select(record, ['id', 'version', 'status', 'documentType', 'changeForm', 'riskLevel', ...editableFields]),
    signatures: signatureOptions(record), correctionNotice: correctionNotice(record) };
}
async function correctedContent(service, current, changes, transactionContext) {
  const definitions = service.resolveRecordMaster ? (await service.resolveRecordMaster(current, transactionContext)).formDefinitions : undefined;
  const original = service.normalizeInput(current, definitions);
  const selectedIndex = original.changeRows.findIndex(row => row.risk === current.riskLevel && row.text === current.selectedChange);
  const supplied = { ...changes };
  if (selectedIndex >= 0) {
    const rows = structuredClone(changes.changeRows || original.changeRows);
    for (const field of ['currentCondition', 'newCondition']) {
      if (changes.changeRows && Object.hasOwn(changes, field)
        && String(rows[selectedIndex]?.[field] || '').trim() !== changes[field].trim()) {
        throw new ApiError(400, 'The selected change row and shared condition must match');
      }
      if (Object.hasOwn(changes, field) && rows[selectedIndex]) rows[selectedIndex][field] = changes[field];
      else if (changes.changeRows) supplied[field] = rows[selectedIndex]?.[field] || '';
    }
    if (changes.changeRows || ['currentCondition', 'newCondition'].some(field => Object.hasOwn(changes, field))) supplied.changeRows = rows;
  }
  if (changes.changeRows && selectedIndex >= 0 && !Object.hasOwn(changes, 'selectedChange')) supplied.selectedChange = changes.changeRows[selectedIndex]?.text;
  const normalized = service.normalizeInput({ ...current, ...supplied }, definitions);
  if (normalized.changeRows.length !== original.changeRows.length || normalized.changeRows.some((row, index) =>
    row.optionText !== original.changeRows[index].optionText || row.risk !== original.changeRows[index].risk)) {
    throw new ApiError(400, 'Corrections must keep the existing change categories and risk levels');
  }
  if (selectedIndex >= 0 && normalized.selectedChange !== normalized.changeRows[selectedIndex]?.text
    || selectedIndex < 0 && normalized.selectedChange !== original.selectedChange) {
    throw new ApiError(400, 'Corrections must keep the existing selected change category');
  }
  return { ...current, ...select(normalized, Object.keys(supplied)) };
}
const metadata = (user, why, now, kind, retainedSignatures) => ({ reason: why, actor: `user:${user.id}`, time: now, kind, retainedSignatures });
async function correctOne(context, user, entry, why) {
  try {
    const saved = await context.service.repository.update(entry.id, async (current, transactionContext) => {
      requireDeveloper(user); assertRecordAccess(current, user);
      const next = await correctedContent(context.service, current, entry.changes, transactionContext);
      if (isDeepStrictEqual(next, current)) throw new Unchanged(current);
      const now = context.service.clock().toISOString();
      const retained = orderedPaths.filter(path => checked(current, path));
      return { ...next, updatedAt: now, documentControl: { ...current.documentControl,
        contentRevision: current.documentControl?.contentRevision || 1, contentHash: contentHash(next),
        correctedSignatures: retained,
        lastDeveloperCorrection: metadata(user, why, now, 'correction', retained) } };
    }, `user:${user.id}`, entry.version, user);
    if (!saved) throw new ApiError(404, 'PCN not found');
    return { id: entry.id, success: true, version: saved.version, changed: true };
  } catch (error) {
    if (error instanceof Unchanged) return { id: entry.id, success: true, version: error.record.version, changed: false };
    if (error instanceof ApiError && [400, 401, 403, 404, 409].includes(error.statusCode)) {
      return { id: entry.id, success: false, status: error.statusCode, error: error.message };
    }
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'UNKNOWN';
    console.error(JSON.stringify({ event: 'developer_correction_failed', pcnId: entry.id, code }));
    return { id: entry.id, success: false, status: 500,
      error: 'Correction could not be saved. Reload this document before retrying.' };
  }
}
async function bulkCorrect(context, user, input) {
  requireDeveloper(user); object(input, ['reason', 'items'], 'bulk correction request');
  const why = reason(input.reason);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) throw new ApiError(400, 'Select 1–20 PCNs');
  const ids = new Set();
  for (const entry of input.items) {
    object(entry, ['id', 'version', 'changes'], 'PCN correction'); id(entry.id); version(entry.version); validateChanges(entry.changes);
    if (ids.has(entry.id)) throw new ApiError(400, 'Select each PCN only once');
    ids.add(entry.id);
  }
  const results = [];
  for (const entry of input.items) results.push(await correctOne(context, user, entry, why));
  return { results };
}
function clearPaths(review, paths) {
  const next = structuredClone(review);
  for (const path of paths) {
    const action = path.split('.').at(-1), group = at(next, path.slice(0, -(action.length + 1)));
    if (path.startsWith('supplierSignoff.')) group[action] = { ...group[action], checked: false, name: '', date: '' };
    else Object.assign(group, { [action]: false, [`${action}Name`]: '', [`${action}Date`]: '' });
  }
  if (paths.some(path => !path.startsWith('supplierSignoff.')) && next.qateFinal) Object.assign(next.qateFinal, { approve: false, reject: false });
  return next;
}
async function unsign(context, user, code, input) {
  requireDeveloper(user); id(code); object(input, ['version', 'reason', 'path'], 'signature removal request');
  version(input.version); const why = reason(input.reason);
  if (!orderedPaths.includes(input.path)) throw new ApiError(400, 'Choose a valid signature');
  let cleared, reopened;
  const saved = await context.service.repository.update(code, current => {
    requireDeveloper(user); assertRecordAccess(current, user);
    const option = signatureOptions(current).find(item => item.path === input.path);
    if (!option) throw new ApiError(409, 'That signature is no longer signed; reload the PCN');
    cleared = option.clears; reopened = option.reopens;
    const now = context.service.clock().toISOString();
    const retained = (current.documentControl?.correctedSignatures || []).filter(path => !cleared.includes(path));
    return applyReviewTiming(current, { ...current, updatedAt: now, status: reopened ? 'submitted' : current.status,
      internalReview: clearPaths(current.internalReview, cleared), documentControl: { ...current.documentControl,
        signatureBindings: Object.fromEntries(Object.entries(current.documentControl?.signatureBindings || {}).filter(([path]) => !cleared.includes(path))),
        correctedSignatures: retained, lastDeveloperCorrection: metadata(user, why, now, 'unsign', retained) } }, now);
  }, `user:${user.id}`, input.version, user);
  if (!saved) throw new ApiError(404, 'PCN not found');
  return { id: code, version: saved.version, status: saved.status, cleared, reopened };
}

module.exports = { requireDeveloper, editableFields, loadCorrection, bulkCorrect, unsign, correctionNotice };
