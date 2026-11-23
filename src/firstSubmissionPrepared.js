const { canSign } = require('./signingPermissions');
const { hasSignatures } = require('./documentControl');

// This projection is also used by read-only preflight. Identity and content
// bindings are recorded only by the service's normal signature save path.
function firstSubmissionPrepared(before, proposed, user) {
  if (proposed.status !== 'submitted' || (before && (before.status !== 'draft'
    || before.submittedAt || before.documentControl?.revisionStartedAt
    || before.documentControl?.revisionStartedBy || before.documentControl?.revisionReason
    || hasSignatures(before))) || !user?.id
    || !canSign(user, 'gscTet', 'prepared')
    || proposed.internalReview?.signoff?.gscTet?.prepared === true) return proposed;
  const review = proposed.internalReview || {};
  return { ...proposed, internalReview:{ ...review, signoff:{ ...review.signoff,
    gscTet:{ ...review.signoff?.gscTet, prepared:true } } } };
}

module.exports = { firstSubmissionPrepared };
