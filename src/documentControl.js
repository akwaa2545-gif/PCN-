const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { ApiError } = require('./apiError');
const { actions, stageDepartments } = require('./signingPermissions');

const contentFields = ['changeForm', 'riskLevel', 'selectedChange', 'supplierName', 'manufacturerName', 'materialName', 'desiredStart', 'sampleSubmitted', 'sampleSubmittedDate', 'currentCondition', 'newCondition', 'changeRows', 'reason', 'identification', 'sampleLocation', 'priceLevel'];
const signaturePaths = [...actions.map(action => `supplierSignoff.${action}`), ...Object.keys(stageDepartments).flatMap(stage => actions.map(action => `${stage}.${action}`))];
const at = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const signatureChecked = (review, path) => (path.startsWith('supplierSignoff.') ? at(review, `${path}.checked`) : at(review, path)) === true;
const hasSignatures = record => signaturePaths.some(path => signatureChecked(record?.internalReview, path));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

function contentHash(record) {
  const defaults = { changeRows: [], sampleSubmitted: 'pending', priceLevel: 'no-change' };
  const content = Object.fromEntries(contentFields.map(key => [key, record?.[key] ?? defaults[key] ?? '']));
  content.materialCodeDescription = record?.internalReview?.materialCodeDescription || '';
  // Only the attachment content generation participates; routine review work does not invalidate prior stages.
  content.attachmentGeneration = record?.documentControl?.attachmentGeneration || 0;
  return crypto.createHash('sha256').update(JSON.stringify(stable(content))).digest('hex');
}

function clearSignatures(review = {}) {
  const next = structuredClone(review);
  for (const action of actions) {
    if (next.supplierSignoff?.[action]) next.supplierSignoff[action] = { ...next.supplierSignoff[action], checked: false, name: '', date: '' };
  }
  for (const stage of Object.keys(stageDepartments)) {
    const group = at(next, stage);
    if (!group) continue;
    for (const action of actions) Object.assign(group, { [action]: false, [`${action}Name`]: '', [`${action}Date`]: '' });
  }
  if (next.qateFinal) next.qateFinal = { ...next.qateFinal, approve: false, reject: false };
  return next;
}

function applyDocumentControl(current, proposed, user, now, options = {}) {
  const previousHash = current ? contentHash(current) : null;
  const candidateHash = contentHash(proposed);
  const changed = Boolean(current && previousHash !== candidateHash);
  const signed = hasSignatures(current);
  const newlySigned = signaturePaths.some(path => !signatureChecked(current?.internalReview, path) && signatureChecked(proposed.internalReview, path));
  if (!options.startRevision && changed && signed) {
    if (!['draft', 'supplier_action'].includes(current.status)) throw new ApiError(409, 'Start a new revision before changing signed document content');
    if (newlySigned) throw new ApiError(409, 'Save content changes before signing the new revision');
  }
  const reset = options.startRevision || (changed && signed);
  const review = reset ? clearSignatures(proposed.internalReview) : proposed.internalReview || {};
  const contentRevision = (current?.documentControl?.contentRevision || 1) + (current && (changed || options.startRevision) ? 1 : 0);
  const bindings = Object.fromEntries(signaturePaths.filter(path => signatureChecked(review, path)).map(path => {
    const previous = current?.documentControl?.signatureBindings?.[path];
    if (signatureChecked(current?.internalReview, path)) return [path, previous || { state: 'unknown' }];
    return [path, user?.id ? { userId: String(user.id), displayName: String(user.displayName || user.username || user.employeeCode || '').slice(0, 200), signedAt: now, contentRevision, contentHash: candidateHash } : { state: 'unknown' }];
  }));
  return { ...proposed, internalReview: review, documentControl: {
    ...(current?.documentControl || {}), attachmentGeneration: proposed.documentControl?.attachmentGeneration || 0,
    contentRevision, contentHash: candidateHash, signatureBindings: bindings,
    ...(options.startRevision ? { revisionReason: options.reason, revisionStartedAt: now, revisionStartedBy: String(user?.id || '') } : {})
  } };
}

function snapshot(record) {
  const { notification, ...saved } = record;
  return structuredClone(saved);
}

function fieldChanges(before, after, prefix = '') {
  if (isDeepStrictEqual(before, after)) return [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (object(before) || object(after)) {
    const keys = [...new Set([...Object.keys(object(before) ? before : {}), ...Object.keys(object(after) ? after : {})])].sort();
    return keys.flatMap(key => fieldChanges(before?.[key], after?.[key], prefix ? `${prefix}.${key}` : key));
  }
  return [{ path: prefix, before: before === undefined ? null : structuredClone(before), after: after === undefined ? null : structuredClone(after) }];
}

module.exports = { contentHash, applyDocumentControl, clearSignatures, fieldChanges, snapshot, hasSignatures };
