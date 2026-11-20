const { actions } = require('./signingPermissions');
const { statusDefinitions } = require('./masterData');
const { routeGroups, complete } = require('./workflowAccess');

const activeStatuses = new Set(statusDefinitions.filter(definition => !definition.terminal
  && !['draft', 'supplier_action'].includes(definition.status)).map(definition => definition.status));

function isEligibleForClosure(record) {
  if (!activeStatuses.has(record?.status)) return false;
  const review = record.internalReview || {};
  return routeGroups(record.riskLevel, review).every(group => complete(review, group))
    && actions.every(action => review.supplierSignoff?.[action]?.checked === true);
}

function applyAutomaticClosure(_current, candidate) {
  return isEligibleForClosure(candidate)
    ? { ...candidate, status: 'closed' } : candidate;
}

module.exports = { isEligibleForClosure, applyAutomaticClosure };
