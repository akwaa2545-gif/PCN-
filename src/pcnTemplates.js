const { ApiError } = require('./apiError');
const { hasRole } = require('./workflowAccess');
const contentFields = Object.freeze(['changeForm','riskLevel','selectedChange','supplierName','manufacturerName','materialName','desiredStart','sampleSubmitted','sampleSubmittedDate','currentCondition','newCondition','changeRows','reason','identification','sampleLocation','priceLevel']);
const requirementFields = Object.freeze(['hazardousReport','greenProcurement','qmsEmsCertificate','supplierDocument','supplierDocumentNote','otherRequirement','otherRequirementNote']);
const canSetRequirements = user => hasRole(user, 'admin', 'reviewer', 'gsc');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function draftContent(input, user) {
  if (!object(input)) throw new ApiError(400, 'Draft document must be an object');
  if (Object.keys(input).some(key => !contentFields.includes(key) && key !== 'internalReview')) throw new ApiError(400, 'Draft document contains a protected field');
  if (input.internalReview !== undefined) {
    const review = input.internalReview;
    if (!object(review) || Object.keys(review).some(key => !['docs','materialCodeDescription'].includes(key))) throw new ApiError(400, 'Draft document cannot change review or signature fields');
    if (!canSetRequirements(user)) throw new ApiError(403, 'Document requirements require an authorized department');
    if (review.docs !== undefined && (!object(review.docs) || Object.keys(review.docs).some(key => !requirementFields.includes(key)))) throw new ApiError(400, 'Unknown document requirement');
  }
  return structuredClone(input);
}

function templateContent(record, user) {
  const result = Object.fromEntries(contentFields.filter(key => Object.hasOwn(record, key)).map(key => [key,
    key === 'changeRows' ? (record.changeRows || []).map(row => Object.fromEntries(['risk','optionText','text','currentCondition','newCondition'].filter(field => Object.hasOwn(row, field)).map(field => [field, structuredClone(row[field])]))) : structuredClone(record[key])]));
  if (canSetRequirements(user)) {
    const review = record.internalReview || {};
    const docs = Object.fromEntries(requirementFields.filter(key => Object.hasOwn(review.docs || {}, key)).map(key => [key, structuredClone(review.docs[key])]));
    result.internalReview = { ...(Object.keys(docs).length ? { docs } : {}),
      ...(typeof review.materialCodeDescription === 'string' ? { materialCodeDescription: review.materialCodeDescription } : {}) };
  }
  return { ...result, ...(record.isTestDocument === true ? { isTestDocument: true } : {}) };
}

module.exports = { contentFields, canSetRequirements, draftContent, templateContent };
