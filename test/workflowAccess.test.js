const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRecordAccess, assertReviewUpdate, assertWritablePayload, assertStatusPermission, applySignatureIdentity } = require('../src/workflowAccess');

const supplier = { id: 4, roles: ['Supplier'] };
const qa = { id: 5, roles: ['QA'], department: 'qaTet', signingStep: 'checked' };
test('supplier access requires the persisted owner identity', () => {
  assert.doesNotThrow(() => assertRecordAccess({ ownerUserId: 4 }, supplier));
  assert.throws(() => assertRecordAccess({ ownerUserId: 9 }, supplier), { statusCode: 404 });
  assert.throws(() => assertRecordAccess({ ownerUserId: null }, supplier), { statusCode: 404 });
});
test('history and identity fields cannot be overwritten through a form patch', () => {
  assert.throws(() => assertWritablePayload({ ownerUserId: 9 }), { statusCode: 400 });
  assert.throws(() => assertWritablePayload({ approvals: [] }), { statusCode: 400 });
  assert.doesNotThrow(() => assertWritablePayload({ internalReview: {}, version: '0000000000000001' }));
});
test('supplier cannot alter internal review while unchanged defaults are allowed', () => {
  assert.doesNotThrow(() => assertReviewUpdate({}, { docs: { hazardousReport: false }, supplierSignoff: { prepared: { checked: true } } }, supplier, 'RL0'));
  assert.throws(() => assertReviewUpdate({}, { docs: { hazardousReport: true } }, supplier, 'RL0'), { statusCode: 403 });
});
test('QA cannot sign another department and cannot skip signoff prerequisites', () => {
  assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { approved: true } } }, qa, 'RL0'), { statusCode: 403 });
  assert.throws(() => assertReviewUpdate({}, { signoff: { qaTet: { checked: true } } }, qa, 'RL0'), { statusCode: 400 });
});
test('complete prior groups allow ordered review and RL0 forbids TaPBU approval', () => {
  const done = { approved: true, checked: true, prepared: true };
  const before = { signoff: { gscTet: done, prodEngTet: done, qaTet: { approved: true } } };
  const after = { signoff: { gscTet: done, prodEngTet: done, qaTet: { approved: true, checked: true } } };
  assert.doesNotThrow(() => assertReviewUpdate(before, after, qa, 'RL0'));
  assert.throws(() => assertReviewUpdate({}, { tapbu: { need: true } }, { roles: ['Admin'] }, 'RL0'), { statusCode: 400 });
});
test('supplier cannot advance an internal workflow stage or edit a locked submission', () => {
  assert.throws(() => assertStatusPermission({ status: 'submitted' }, 'gsc_review', supplier), { statusCode: 403 });
  assert.doesNotThrow(() => assertStatusPermission({ status: 'draft' }, 'submitted', supplier));
});

test('closure requires a recorded final judgment as well as signoffs', () => {
  const qaFinal = { ...qa, signingStep: 'prepared' };
  const record={status:'qa_review',internalReview:{qateFinal:{signoff:{approved:true,checked:true,prepared:true}}}};
  assert.throws(()=>assertStatusPermission(record,'closed',qaFinal),{statusCode:400});
  assert.doesNotThrow(()=>assertStatusPermission({...record,internalReview:{qateFinal:{...record.internalReview.qateFinal,approve:true}}},'closed',qaFinal));
});

test('management roles cannot change signature flags or metadata without the exact assignment', () => {
  for (const roles of [['Admin'], ['Reviewer']]) {
    for (const field of ['approved', 'approvedName', 'approvedDate']) {
      assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { [field]: field === 'approved' ? true : 'spoofed' } } }, { roles }, 'RL0'), { statusCode: 403 });
    }
  }
  const before = { signoff: { gscTet: { approved: true } } };
  assert.throws(() => assertReviewUpdate(before, { signoff: { gscTet: { approved: false } } }, { roles: ['Admin'] }, 'RL0'), { statusCode: 403 });
  assert.doesNotThrow(() => assertReviewUpdate({}, before, { roles: ['gsc'], department: 'gscTet', signingStep: 'approved' }, 'RL0'));
});

test('truthy signature strings cannot satisfy signing prerequisites', () => {
  assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { approved: 'true' } } }, { roles: ['gsc'], department: 'gscTet', signingStep: 'approved' }, 'RL0'), { statusCode: 400 });
});

test('final judgment requires QA/TET Prepared even for administrators', () => {
  assert.throws(() => assertReviewUpdate({}, { qateFinal: { approve: true } }, { roles: ['Admin'] }, 'RL0'), { statusCode: 403 });
  assert.throws(() => assertReviewUpdate({}, { qateFinal: { approve: true } }, qa, 'RL0'), { statusCode: 403 });
});

test('signing records canonical identity and date without mutating submitted data', () => {
  const input = { signoff: { gscTet: { approved: true, approvedName: 'Spoofed', approvedDate: '1900-01-01' } } };
  const result = applySignatureIdentity({}, input, { displayName: 'Selected Employee' }, '2026-10-07T00:00:00.000Z');
  assert.equal(result.signoff.gscTet.approvedName, 'Selected Employee');
  assert.equal(result.signoff.gscTet.approvedDate, '2026-10-07');
  assert.equal(input.signoff.gscTet.approvedName, 'Spoofed');
  assert.throws(() => applySignatureIdentity(result, { signoff: { gscTet: { ...result.signoff.gscTet, approvedName: '' } } }, {}, '2026-10-08'), { statusCode: 400 });
  const cleared = applySignatureIdentity(result, { signoff: { gscTet: { ...result.signoff.gscTet, approved: false } } }, {}, '2026-10-08');
  assert.equal(cleared.signoff.gscTet.approvedName, '');
  assert.equal(cleared.signoff.gscTet.approvedDate, '');
});

test('review comments retain management and department access without granting signatures', () => {
  assert.doesNotThrow(() => assertReviewUpdate({}, { signoff: { gscTet: { comment: 'Review note' } } }, { roles: ['gsc'] }, 'RL0'));
  assert.doesNotThrow(() => assertReviewUpdate({}, { signoff: { prodEngTet: { comment: 'Engineering note' } } }, { roles: ['Admin'] }, 'RL0'));
  assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { comment: 'Wrong department' } } }, qa, 'RL0'), { statusCode: 403 });
});

test('replacing an ancestor cannot remove signatures without permission', () => {
  const before = { signoff: { gscTet: { approved: true, approvedName: 'Existing signer' } } };
  for (const after of [{ signoff: '' }, { signoff: false }, { signoff: { gscTet: '' } }, { qateFinal: '' }, { tapbu: '' }]) {
    assert.throws(() => assertReviewUpdate(before, after, { roles: ['Admin'] }, 'RL0'), { statusCode: 400 });
  }
  assert.throws(() => assertReviewUpdate(before, {}, { roles: ['Admin'] }, 'RL0'), { statusCode: 403 });
});
