const { ApiError } = require('./apiError');
const { actions, stageDepartments, signaturePath, canSign } = require('./signingPermissions');

const writable = new Set(['status','changeForm','riskLevel','selectedChange','supplierName','manufacturerName','materialName','desiredStart','sampleSubmitted','sampleSubmittedDate','currentCondition','newCondition','changeRows','reason','identification','sampleLocation','priceLevel','internalReview','version']);
const rolesOf = user => (user?.roles || []).map(role => String(role).replace(/[^a-z]/gi, '').toLowerCase());
const hasRole = (user, ...roles) => roles.some(role => rolesOf(user).includes(role.replace(/[^a-z]/gi, '').toLowerCase()));
const isInternal = user => hasRole(user, 'admin', 'reviewer', 'gsc', 'productionengineering', 'qa', 'tapbu');

function assertRecordAccess(record, user) {
  if (!record || (!isInternal(user) && (!record.ownerUserId || String(record.ownerUserId) !== String(user?.id)))) {
    throw new ApiError(404, 'PCN not found');
  }
}

function assertWritablePayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'PCN body must be an object');
  for (const key of Object.keys(input)) {
    if (!writable.has(key)) throw new ApiError(400, `Field cannot be written: ${key}`);
  }
}

function flatten(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, entry]) => flatten(entry, prefix ? `${prefix}.${key}` : key));
}
const at = (value, path) => path.split('.').reduce((obj, key) => obj?.[key], value);
const isEmpty = value => value === false || value === '' || value === null || value === undefined;
const routeGroups = risk => ['signoff.gscTet','signoff.prodEngTet','signoff.qaTet',...(risk === 'RL0' ? [] : ['tapbu.gsc','tapbu.qa']),'qateFinal.signoff'];
const complete = (review, group) => ['approved','checked','prepared'].every(action => at(review, `${group}.${action}`) === true);

function canEditReview(user, path) {
  const signature = signaturePath(path);
  if (signature) return canSign(user, signature.department, signature.action);
  const stage = Object.keys(stageDepartments).find(value => path === value || path.startsWith(`${value}.`));
  if (stage && path !== `${stage}.comment`) return false;
  if (path.startsWith('qateFinal.')) return canSign(user, 'qaTet', 'prepared');
  if (hasRole(user, 'admin', 'reviewer')) return true;
  if (path.startsWith('supplierSignoff.')) return hasRole(user, 'supplier');
  if (/^signoff\.gscTet\./.test(path) || /^(materialCodeDescription|docs\.|tapbu\.(need|noNeed|comment))/.test(path)) return hasRole(user, 'gsc');
  if (/^signoff\.prodEngTet\./.test(path)) return hasRole(user, 'productionengineering');
  if (/^(decision\.|qateFinal\.|signoff\.qaTet\.)/.test(path)) return hasRole(user, 'qa');
  if (/^tapbu\.(gsc|qa)\./.test(path)) return hasRole(user, 'tapbu');
  return false;
}

function assertReviewUpdate(before = {}, after = {}, user, risk) {
  for (const path of ['signoff', 'tapbu', 'qateFinal', ...Object.keys(stageDepartments)]) {
    const value = at(after, path);
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new ApiError(400, 'Signoff sections must be objects');
    }
  }
  for (const [stage, department] of Object.entries(stageDepartments)) {
    for (const action of actions) {
      for (const suffix of ['', 'Name', 'Date']) {
        const previous = at(before, `${stage}.${action}${suffix}`);
        const value = at(after, `${stage}.${action}${suffix}`);
        if (JSON.stringify(previous) !== JSON.stringify(value) && !(isEmpty(previous) && isEmpty(value)) && !canSign(user, department, action)) {
          throw new ApiError(403, 'This signature requires the assigned department and signing step');
        }
      }
    }
  }
  for (const [path, value] of flatten(after)) {
    const previous = at(before, path);
    if (path === 'pcnCode' || JSON.stringify(previous) === JSON.stringify(value) || (previous === undefined && isEmpty(value))) continue;
    if (!canEditReview(user, path)) throw new ApiError(403, 'This review field requires an authorized department');
    const signature = signaturePath(path);
    if (signature && signature.field === signature.action && typeof value !== 'boolean') throw new ApiError(400, 'Signoff checks must be boolean');
    if (['qateFinal.approve', 'qateFinal.reject'].includes(path) && typeof value !== 'boolean') throw new ApiError(400, 'Final judgment checks must be boolean');
  }
  if (after.tapbu?.need && after.tapbu?.noNeed) throw new ApiError(400, 'TaPBU requirement choices conflict');
  if (risk === 'RL0' && after.tapbu?.need) throw new ApiError(400, 'RL0 does not require TaPBU approval');
  if (after.qateFinal?.approve && after.qateFinal?.reject) throw new ApiError(400, 'Final judgment choices conflict');
  if (after.decision?.rejected && (after.decision?.agreed || after.decision?.agreedAfterQualification)) throw new ApiError(400, 'Review decision choices conflict');
  const groups = routeGroups(risk);
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const flags = ['approved','checked','prepared'];
    for (let action = 0; action < flags.length; action++) {
      if (at(after, `${group}.${flags[action]}`) !== true) continue;
      if (action > 0 && at(after, `${group}.${flags[action - 1]}`) !== true) throw new ApiError(400, 'Complete signoff prerequisites first');
      if (index > 0 && !complete(after, groups[index - 1])) throw new ApiError(400, 'Complete the preceding approval group first');
      if (group.startsWith('tapbu.') && !after.tapbu?.need) throw new ApiError(400, 'TaPBU requirement must be selected before signoff');
    }
  }
  if (risk === 'RL0' && ['tapbu.gsc','tapbu.qa'].some(group => ['approved','checked','prepared'].some(action => at(after, `${group}.${action}`)))) throw new ApiError(400, 'RL0 cannot include TaPBU signoffs');
}

function assertStatusPermission(record, nextStatus, user) {
  if (nextStatus === record.status) return;
  if (!isInternal(user)) {
    if (hasRole(user, 'supplier') && ['draft','supplier_action'].includes(record.status) && nextStatus === 'submitted') return;
    throw new ApiError(403, 'This workflow action requires an internal reviewer');
  }
  if (['approved','rejected','closed'].includes(nextStatus)) {
    if (!canSign(user, 'qaTet', 'prepared')) throw new ApiError(403, 'Final judgment requires the QA/TET Prepared assignment');
    if (!complete(record.internalReview || {}, 'qateFinal.signoff')) throw new ApiError(400, 'Complete final signoffs before final judgment');
    if (nextStatus === 'approved' && !record.internalReview?.qateFinal?.approve) throw new ApiError(400, 'Record the approval judgment first');
    if (nextStatus === 'rejected' && !record.internalReview?.qateFinal?.reject) throw new ApiError(400, 'Record the rejection judgment first');
    if (nextStatus === 'closed' && !record.internalReview?.qateFinal?.approve && !record.internalReview?.qateFinal?.reject) throw new ApiError(400, 'Record the final judgment before closure');
  }
}

function applySignatureIdentity(before, after, user, now) {
  const review = structuredClone(after);
  for (const stage of Object.keys(stageDepartments)) {
    const current = at(review, stage);
    if (!current || typeof current !== 'object') continue;
    for (const action of actions) {
      const previous = at(before, `${stage}.${action}`);
      if (current[action] !== previous && typeof current[action] === 'boolean') {
        current[`${action}Name`] = current[action] ? String(user.displayName || user.username || user.employeeCode || '').slice(0, 200) : '';
        current[`${action}Date`] = current[action] ? now.slice(0, 10) : '';
      } else if (['Name', 'Date'].some(suffix => {
        const oldValue = at(before, `${stage}.${action}${suffix}`);
        const value = current[`${action}${suffix}`];
        return value !== oldValue && (!isEmpty(value) || !isEmpty(oldValue));
      })) {
        throw new ApiError(400, 'Signer identity and date are recorded when signing');
      }
    }
  }
  return review;
}

module.exports = { assertRecordAccess, assertWritablePayload, assertReviewUpdate, assertStatusPermission, applySignatureIdentity, hasRole, isInternal, routeGroups, complete };
