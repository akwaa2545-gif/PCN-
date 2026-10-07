const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSigningAssignment, canSign, signaturePath } = require('../src/signingPermissions');

test('one signing step requires a matching department and role', () => {
  assert.doesNotThrow(() => validateSigningAssignment({ roles: ['qa'], department: 'qaTet', signingStep: 'checked' }));
  assert.doesNotThrow(() => validateSigningAssignment({ roles: ['admin'], department: 'it', signingStep: null }));
  for (const assignment of [
    { roles: ['qa'], department: 'gscTet', signingStep: 'checked' },
    { roles: ['admin'], department: 'it', signingStep: 'approved' },
    { roles: ['supplier'], department: 'qaTet', signingStep: 'prepared' },
    { roles: ['qa'], department: 'qaTet', signingStep: ['approved', 'checked'] }
  ]) assert.throws(() => validateSigningAssignment(assignment), { statusCode: 400 });
});

test('administrator management does not imply a signing assignment', () => {
  assert.equal(canSign({ roles: ['admin'] }, 'gscTet', 'approved'), false);
  const user = { roles: ['admin'], department: 'gscTet', signingStep: 'approved' };
  assert.equal(canSign(user, 'gscTet', 'approved'), true);
  assert.equal(canSign(user, 'gscTet', 'checked'), false);
  assert.equal(canSign(user, 'qaTet', 'approved'), false);
  assert.equal(canSign({ ...user, isActive: false }, 'gscTet', 'approved'), false);
});

test('signature flags and metadata share the exact permission, including QA final', () => {
  assert.deepEqual(signaturePath('qateFinal.signoff.preparedDate'), { department: 'qaTet', action: 'prepared', stage: 'qateFinal.signoff', field: 'preparedDate' });
  assert.deepEqual(signaturePath('tapbu.qa.checked'), { department: 'qaTapbu', action: 'checked', stage: 'tapbu.qa', field: 'checked' });
  assert.equal(signaturePath('docs.drawing'), null);
});
