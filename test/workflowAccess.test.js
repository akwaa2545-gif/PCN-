const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRecordAccess, assertReviewUpdate, assertWritablePayload, assertStatusPermission, applySignatureIdentity } = require('../src/workflowAccess');

const supplier = { id: 4, roles: ['Supplier'] };
const qa = { id: 5, roles: ['QA'], department: 'qaTet', signingStep: 'checked' };

test('new terminal transitions require the whole route even when historical final signatures are complete', () => {
  const actor = { ...qa, signingStep: 'approved' };
  const done = { prepared: true, checked: true, approved: true };
  const review = { signoff: { gscTet: done, prodEngTet: done, qaTet: done }, tapbu: { need: true, gsc: done, qa: done }, qateFinal: { signoff: done, approve: true }, supplierSignoff: Object.fromEntries(Object.keys(done).map(action => [action, { checked: true }])) };
  for (const status of ['approved', 'rejected', 'closed']) {
    const judgment = { ...review.qateFinal, approve: status !== 'rejected', reject: status === 'rejected' };
    for (const partial of [
      { ...review, signoff: { ...review.signoff, gscTet: { approved: true } } },
      { ...review, signoff: { gscTet: done, qaTet: done } },
      { ...review, tapbu: { need: true, gsc: done, qa: { prepared: true } } }
    ]) {
      const historical = { ...partial, qateFinal: judgment };
      assert.doesNotThrow(() => assertReviewUpdate(historical, structuredClone(historical), { roles: ['admin'] }, 'RL2'));
      assert.throws(() => assertStatusPermission({ status: 'qualification', riskLevel: 'RL2', internalReview: historical }, status, actor), { statusCode: 400 });
    }
    assert.doesNotThrow(() => assertStatusPermission({ status: 'qualification', riskLevel: 'RL2', internalReview: { ...review, qateFinal: judgment } }, status, actor));
  }
  const noTapbu = { signoff: review.signoff, qateFinal: review.qateFinal };
  assert.doesNotThrow(() => assertStatusPermission({ status: 'qualification', riskLevel: 'RL0', internalReview: noTapbu }, 'approved', actor));
  assert.doesNotThrow(() => assertStatusPermission({ status: 'qualification', riskLevel: 'RL2', internalReview: { ...noTapbu, tapbu: { noNeed: true } } }, 'approved', actor));
  assert.doesNotThrow(() => assertStatusPermission({ status: 'approved', riskLevel: 'RL2', internalReview: { qateFinal: review.qateFinal } }, 'approved', actor));
});

test('new signatures require all earlier steps and all preceding departments', () => {
  const admin = { roles: ['admin'] };
  const done = { prepared: true, checked: true, approved: true };
  assert.doesNotThrow(() => assertReviewUpdate({}, { signoff: { gscTet: { prepared: true } } }, admin, 'RL0'));
  assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { approved: true } } }, admin, 'RL0'), { statusCode: 400 });
  assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { checked: true, approved: true } } }, admin, 'RL0'), { statusCode: 400 });
  const before = { signoff: { prodEngTet: done } };
  const after = { ...before, signoff: { ...before.signoff, qaTet: { prepared: true } } };
  assert.throws(() => assertReviewUpdate(before, after, admin, 'RL0'), { statusCode: 400 });
});

test('historical signatures retain identity while missing new prerequisites are completed', () => {
  const admin = { roles: ['admin'] };
  const approved = { approved: true, approvedName: 'Historical approver', approvedDate: '2026-10-01' };
  const before = { signoff: { gscTet: approved } };
  assert.doesNotThrow(() => assertReviewUpdate(before, structuredClone(before), admin, 'RL0'));
  const prepared = { signoff: { gscTet: { ...approved, prepared: true } } };
  assert.doesNotThrow(() => assertReviewUpdate(before, prepared, admin, 'RL0'));
  const checked = { signoff: { gscTet: { ...prepared.signoff.gscTet, checked: true } } };
  assert.doesNotThrow(() => assertReviewUpdate(prepared, checked, admin, 'RL0'));
  assert.throws(() => assertReviewUpdate(checked, { signoff: { gscTet: { ...checked.signoff.gscTet, prepared: false } } }, admin, 'RL0'), { statusCode: 400 });
  assert.throws(() => assertReviewUpdate(before, { signoff: { gscTet: { ...approved, checked: true } } }, admin, 'RL0'), { statusCode: 400 });
});

test('historical gaps do not authorize removal of already completed group prerequisites', () => {
  const admin = { roles: ['admin'] };
  const before = { signoff: { gscTet: { prepared: true }, qaTet: { approved: true } } };
  assert.doesNotThrow(() => assertReviewUpdate(before, structuredClone(before), admin, 'RL0'));
  assert.throws(() => assertReviewUpdate(before, { signoff: { gscTet: { prepared: false }, qaTet: { approved: true } } }, admin, 'RL0'), { statusCode: 400 });
});

test('changing TaPBU routing cannot remove earlier evidence beneath a retained final signature', () => {
  const admin = { roles: ['admin'] };
  const done = { prepared: true, checked: true, approved: true };
  const before = { signoff: { gscTet: done, prodEngTet: done, qaTet: done }, tapbu: { need: true, gsc: done, qa: done }, qateFinal: { signoff: { approved: true } } };
  const after = { ...before, tapbu: { need: false, noNeed: true } };
  assert.throws(() => assertReviewUpdate(before, after, admin, 'RL2'), { statusCode: 400 });
  const legacy = { signoff: before.signoff, qateFinal: before.qateFinal };
  assert.doesNotThrow(() => assertReviewUpdate(legacy, { ...legacy, tapbu: { noNeed: true } }, admin, 'RL2'));
});

test('QA/TET Approved owns final judgment fields and terminal status transitions', () => {
  const approved = { ...qa, signingStep: 'approved' };
  const prepared = { ...qa, signingStep: 'prepared' };
  const done = { prepared: true, checked: true, approved: true };
  const review = { signoff: { gscTet: done, prodEngTet: done, qaTet: done }, tapbu: { noNeed: true }, qateFinal: { signoff: done, approve: true } };
  assert.doesNotThrow(() => assertReviewUpdate({ signoff: review.signoff }, { signoff: review.signoff, qateFinal: { approve: true } }, approved, 'RL0'));
  assert.throws(() => assertReviewUpdate({}, { qateFinal: { approve: true } }, prepared, 'RL0'), { statusCode: 403 });
  assert.doesNotThrow(() => assertStatusPermission({ status: 'qa_review', internalReview: review }, 'approved', approved));
  assert.throws(() => assertStatusPermission({ status: 'qa_review', internalReview: review }, 'approved', prepared), { statusCode: 403 });
});

test('explicit TaPBU no-need permits final QA while an undecided requirement remains blocked', () => {
  const done={approved:true,checked:true,prepared:true};
  const admin={id:'admin',roles:['admin'],isActive:true};
  const before={signoff:{gscTet:done,prodEngTet:done,qaTet:done},tapbu:{need:false,noNeed:true}};
  const after={...before,qateFinal:{signoff:{prepared:true}}};
  assert.doesNotThrow(()=>assertReviewUpdate(before,after,admin,'RL2'));
  assert.throws(()=>assertReviewUpdate({...before,tapbu:{need:false,noNeed:false}}, {...after,tapbu:{need:false,noNeed:false}},admin,'RL2'),/preceding approval group/);
});
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
  assert.doesNotThrow(() => assertReviewUpdate({}, { docs: { hazardousReport: false }, supplierSignoff: { prepared: { checked: false } } }, supplier, 'RL0'));
  assert.throws(() => assertReviewUpdate({}, { supplierSignoff: { prepared: { checked: true } } }, supplier, 'RL0'), { statusCode: 400 });
  assert.throws(() => assertReviewUpdate({}, { docs: { hazardousReport: true } }, supplier, 'RL0'), { statusCode: 403 });
});

test('header signatures and metadata require every route signature including all final judgment steps', () => {
  const done = { prepared: true, checked: true, approved: true };
  const completeReview = { signoff: { gscTet: done, prodEngTet: done, qaTet: done }, tapbu: { need: true, gsc: done, qa: done }, qateFinal: { signoff: done } };
  const actors = [supplier, { roles: ['Admin'] }, { roles: ['Reviewer'] }, { roles: ['Developer'], department: 'developer', signingStep: null, isActive: true }];
  for (const actor of actors) {
    for (const action of ['prepared', 'checked', 'approved']) {
      for (const [field, value] of Object.entries({ checked: true, name: 'Signed employee', date: '2026-10-22' })) {
        const sign = review => ({ ...review, supplierSignoff: { [action]: { [field]: value } } });
        for (const [section, group] of [['signoff', 'gscTet'], ['signoff', 'prodEngTet'], ['signoff', 'qaTet'], ['tapbu', 'gsc'], ['tapbu', 'qa'], ['qateFinal', 'signoff']]) {
          for (const missing of ['prepared', 'checked', 'approved']) {
            const before = structuredClone(completeReview);
            before[section][group] = { ...before[section][group], [missing]: false };
            assert.throws(() => assertReviewUpdate(before, sign(before), actor, 'RL2'), { statusCode: 400 }, `${action}.${field} requires ${section}.${group}.${missing}`);
          }
        }
        assert.doesNotThrow(() => assertReviewUpdate(completeReview, sign(completeReview), actor, 'RL2'));
        const skipped = { signoff: completeReview.signoff, qateFinal: completeReview.qateFinal };
        assert.doesNotThrow(() => assertReviewUpdate(skipped, sign(skipped), actor, 'RL0'));
        const noNeed = { ...skipped, tapbu: { noNeed: true } };
        assert.doesNotThrow(() => assertReviewUpdate(noNeed, sign(noNeed), actor, 'RL2'));
        assert.throws(() => assertReviewUpdate(skipped, sign(skipped), actor, 'RL2'), { statusCode: 400 });
      }
    }
  }
  assert.throws(() => assertReviewUpdate(completeReview, { ...completeReview, supplierSignoff: { prepared: { checked: true } } }, qa, 'RL2'), { statusCode: 403 });
});

test('historical header signatures preserve gaps but protect completed prerequisites and allow authorized clearing', () => {
  const admin = { roles: ['Admin'] };
  const header = { approved: { checked: true, name: 'Historical signer', date: '2026-01-01' } };
  const before = { signoff: { gscTet: { prepared: true } }, qateFinal: { signoff: { approved: true } }, supplierSignoff: header };
  assert.doesNotThrow(() => assertReviewUpdate(before, structuredClone(before), supplier, 'RL0'));
  assert.throws(() => assertReviewUpdate(before, { ...before, supplierSignoff: { ...header, prepared: { checked: true } } }, supplier, 'RL0'), { statusCode: 400 });
  assert.throws(() => assertReviewUpdate(before, { ...before, supplierSignoff: { approved: { ...header.approved, date: '2026-10-22' } } }, supplier, 'RL0'), { statusCode: 400 });
  assert.throws(() => assertReviewUpdate(before, { ...before, signoff: { gscTet: { prepared: false } } }, admin, 'RL0'), { statusCode: 400 });
  assert.throws(() => assertReviewUpdate(before, { ...before, qateFinal: { signoff: { approved: false } } }, admin, 'RL0'), { statusCode: 400 });
  const cleared = { ...before, supplierSignoff: { approved: { checked: false, name: '', date: '' } } };
  assert.doesNotThrow(() => assertReviewUpdate(before, cleared, supplier, 'RL0'));
  assert.throws(() => assertReviewUpdate(before, cleared, qa, 'RL0'), { statusCode: 403 });
  assert.doesNotThrow(() => assertReviewUpdate({}, { supplierSignoff: { prepared: { checked: false, name: '', date: '' } } }, supplier, 'RL0'));
});

test('retained header signatures protect the old route when TaPBU is changed to no-need', () => {
  const admin = { roles: ['Admin'] };
  const done = { prepared: true, checked: true, approved: true };
  const before = { signoff: { gscTet: done, prodEngTet: done, qaTet: done }, tapbu: { need: true, gsc: done, qa: done }, supplierSignoff: { prepared: { checked: true } } };
  const skipped = { ...before, tapbu: { need: false, noNeed: true } };
  assert.throws(() => assertReviewUpdate(before, skipped, admin, 'RL2'), { statusCode: 400 });
  assert.doesNotThrow(() => assertReviewUpdate(before, { ...skipped, supplierSignoff: { prepared: { checked: false } } }, admin, 'RL2'));
  const historical = { signoff: before.signoff, supplierSignoff: before.supplierSignoff };
  assert.doesNotThrow(() => assertReviewUpdate(historical, { ...historical, tapbu: { noNeed: true } }, admin, 'RL2'));
});
test('QA cannot sign another department and cannot skip signoff prerequisites', () => {
  assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { approved: true } } }, qa, 'RL0'), { statusCode: 403 });
  assert.throws(() => assertReviewUpdate({}, { signoff: { qaTet: { checked: true } } }, qa, 'RL0'), { statusCode: 400 });
});
test('complete prior groups allow ordered review and RL0 forbids TaPBU approval', () => {
  const done = { approved: true, checked: true, prepared: true };
  const before = { signoff: { gscTet: done, prodEngTet: done, qaTet: { prepared: true } } };
  const after = { signoff: { gscTet: done, prodEngTet: done, qaTet: { prepared: true, checked: true } } };
  assert.doesNotThrow(() => assertReviewUpdate(before, after, qa, 'RL0'));
  assert.throws(() => assertReviewUpdate({}, { tapbu: { need: true } }, { roles: ['Admin'] }, 'RL0'), { statusCode: 400 });
});
test('supplier cannot advance an internal workflow stage or edit a locked submission', () => {
  assert.throws(() => assertStatusPermission({ status: 'submitted' }, 'gsc_review', supplier), { statusCode: 403 });
  assert.doesNotThrow(() => assertStatusPermission({ status: 'draft' }, 'submitted', supplier));
});

test('closure requires a recorded final judgment as well as signoffs', () => {
  const qaFinal = { ...qa, signingStep: 'approved' };
  const done={approved:true,checked:true,prepared:true};
  const record={status:'qa_review',riskLevel:'RL0',internalReview:{signoff:{gscTet:done,prodEngTet:done,qaTet:done},qateFinal:{signoff:done},supplierSignoff:Object.fromEntries(Object.keys(done).map(action=>[action,{checked:true}]))}};
  assert.throws(()=>assertStatusPermission(record,'closed',qaFinal),{statusCode:400});
  assert.doesNotThrow(()=>assertStatusPermission({...record,internalReview:{...record.internalReview,qateFinal:{...record.internalReview.qateFinal,approve:true}}},'closed',qaFinal));
});

test('reviewers cannot change signature flags or metadata without the exact assignment', () => {
  for (const roles of [['Reviewer']]) {
    for (const field of ['approved', 'approvedName', 'approvedDate']) {
      assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { [field]: field === 'approved' ? true : 'spoofed' } } }, { roles }, 'RL0'), { statusCode: 403 });
    }
  }
  const before = { signoff: { gscTet: { approved: true } } };
  assert.throws(() => assertReviewUpdate(before, { signoff: { gscTet: { approved: false } } }, { roles: ['Reviewer'] }, 'RL0'), { statusCode: 403 });
  const prerequisites = { signoff: { gscTet: { prepared: true, checked: true } } };
  assert.doesNotThrow(() => assertReviewUpdate(prerequisites, { signoff: { gscTet: { ...prerequisites.signoff.gscTet, approved: true } } }, { roles: ['gsc'], department: 'gscTet', signingStep: 'approved' }, 'RL0'));
});

test('truthy signature strings cannot satisfy signing prerequisites', () => {
  assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { approved: 'true' } } }, { roles: ['gsc'], department: 'gscTet', signingStep: 'approved' }, 'RL0'), { statusCode: 400 });
});

test('administrators can record final judgment while non-admins require QA/TET Approved', () => {
  const done = { prepared: true, checked: true, approved: true };
  const before = { signoff: { gscTet: done, prodEngTet: done, qaTet: done } };
  assert.doesNotThrow(() => assertReviewUpdate(before, { ...before, qateFinal: { approve: true } }, { roles: ['Admin'] }, 'RL0'));
  assert.throws(() => assertReviewUpdate({}, { qateFinal: { approve: true } }, qa, 'RL0'), { statusCode: 403 });
});

test('every final judgment value waits for all preceding signature steps, including administrator and developer overrides', () => {
  const actors = [
    { ...qa, signingStep: 'approved' },
    { roles: ['Admin'] },
    { roles: ['Developer'], department: 'developer', signingStep: null, isActive: true }
  ];
  const done = { prepared: true, checked: true, approved: true };
  const completeReview = { signoff: { gscTet: done, prodEngTet: done, qaTet: done }, tapbu: { need: true, gsc: done, qa: done } };
  const fields = { approve: true, reject: true, qod206Number: 'QOD-206-TEST', reason: 'Qualification finished', completedDate: '2026-10-22' };
  for (const actor of actors) {
    for (const [field, value] of Object.entries(fields)) {
      for (const [section, department] of [['signoff', 'gscTet'], ['signoff', 'prodEngTet'], ['signoff', 'qaTet'], ['tapbu', 'gsc'], ['tapbu', 'qa']]) {
        for (const action of ['prepared', 'checked', 'approved']) {
          const before = structuredClone(completeReview);
          before[section][department] = { ...before[section][department], [action]: false };
          const after = { ...before, qateFinal: { [field]: value } };
          assert.throws(() => assertReviewUpdate(before, after, actor, 'RL2'), { statusCode: 400 }, `${field} requires ${section}.${department}.${action}`);
        }
      }
      assert.doesNotThrow(() => assertReviewUpdate(completeReview, { ...completeReview, qateFinal: { [field]: value } }, actor, 'RL2'));
      const noTapbu = { signoff: completeReview.signoff };
      assert.doesNotThrow(() => assertReviewUpdate(noTapbu, { ...noTapbu, qateFinal: { [field]: value } }, actor, 'RL0'));
      const skipped = { ...noTapbu, tapbu: { noNeed: true } };
      assert.doesNotThrow(() => assertReviewUpdate(skipped, { ...skipped, qateFinal: { [field]: value } }, actor, 'RL2'));
    }
  }
});

test('historical final judgment gaps remain readable but new judgment content requires the complete route', () => {
  const actor = { ...qa, signingStep: 'approved' };
  const before = { signoff: { gscTet: { prepared: true } }, qateFinal: { approve: true, reason: 'Historical judgment', completedDate: '2026-01-01' } };
  assert.doesNotThrow(() => assertReviewUpdate(before, structuredClone(before), actor, 'RL0'));
  assert.throws(() => assertReviewUpdate(before, { ...before, qateFinal: { ...before.qateFinal, reason: 'Changed judgment' } }, actor, 'RL0'), { statusCode: 400 });
  assert.throws(() => assertReviewUpdate(before, { ...before, signoff: { gscTet: { prepared: false } } }, { roles: ['Admin'] }, 'RL0'), { statusCode: 400 });
  assert.doesNotThrow(() => assertReviewUpdate(before, { ...before, qateFinal: { approve: false, reason: '', completedDate: '' } }, actor, 'RL0'));
  assert.throws(() => assertReviewUpdate(before, { ...before, qateFinal: { approve: false, reason: '', completedDate: '' } }, qa, 'RL0'), { statusCode: 403 });
  assert.doesNotThrow(() => assertReviewUpdate({}, { qateFinal: { approve: false, reject: false, reason: '', completedDate: '' } }, actor, 'RL0'));
});

test('retained final judgment protects completed prerequisites when the TaPBU route changes', () => {
  const actor = { roles: ['Admin'] };
  const done = { prepared: true, checked: true, approved: true };
  const before = { signoff: { gscTet: done, prodEngTet: done, qaTet: done }, tapbu: { need: true, gsc: done, qa: done }, qateFinal: { approve: true } };
  const skipped = { ...before, tapbu: { need: false, noNeed: true } };
  assert.throws(() => assertReviewUpdate(before, skipped, actor, 'RL2'), { statusCode: 400 });
  assert.doesNotThrow(() => assertReviewUpdate(before, { ...skipped, qateFinal: { approve: false } }, actor, 'RL2'));
  const legacy = { signoff: before.signoff, qateFinal: before.qateFinal };
  assert.doesNotThrow(() => assertReviewUpdate(legacy, { ...legacy, tapbu: { noNeed: true } }, actor, 'RL2'));
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
  assert.throws(() => assertReviewUpdate(before, {}, { roles: ['Reviewer'] }, 'RL0'), { statusCode: 403 });
});

test('administrator override preserves signing order, RL0 restrictions and final status prerequisites', () => {
  const admin = { roles: ['admin'], department: 'it', signingStep: null };
  assert.doesNotThrow(() => assertReviewUpdate({}, { signoff: { gscTet: { prepared: true } } }, admin, 'RL0'));
  assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { checked: true } } }, admin, 'RL0'), { statusCode: 400 });
  assert.throws(() => assertReviewUpdate({}, { signoff: { prodEngTet: { approved: true } } }, admin, 'RL0'), { statusCode: 400 });
  assert.throws(() => assertReviewUpdate({}, { tapbu: { gsc: { approved: true } } }, admin, 'RL0'), { statusCode: 400 });
  assert.throws(() => assertStatusPermission({ status: 'qa_review' }, 'approved', admin), { statusCode: 400 });
  const done = { approved: true, checked: true, prepared: true };
  const record = { status: 'qa_review', riskLevel: 'RL0', internalReview: { signoff: { gscTet: done, prodEngTet: done, qaTet: done }, qateFinal: { signoff: done }, supplierSignoff: Object.fromEntries(Object.keys(done).map(action => [action, { checked: true }])) } };
  assert.throws(() => assertStatusPermission(record, 'closed', admin), { statusCode: 400 });
  assert.doesNotThrow(() => assertStatusPermission({ ...record, internalReview: { ...record.internalReview, qateFinal: { ...record.internalReview.qateFinal, approve: true } } }, 'closed', admin));
  assert.throws(() => assertReviewUpdate({}, { signoff: { gscTet: { approved: true } } }, { ...admin, isActive: false }, 'RL0'), { statusCode: 403 });
});
