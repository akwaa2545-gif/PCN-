const test = require('node:test');
const assert = require('node:assert/strict');
const { actions, departments, validateSigningAssignment, canSign, signaturePath } = require('../src/signingPermissions');

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

test('active administrators can sign every known department and action without an assignment', () => {
  for (const user of [{ roles: ['admin'] }, { roles: ['Admin'], department: 'it', signingStep: null },
    { roles: ['admin'], department: 'gscTet', signingStep: 'approved' }]) {
    for (const { key } of departments) {
      for (const action of actions) assert.equal(canSign(user, key, action), true, `${key}.${action}`);
    }
    assert.equal(canSign({ ...user, isActive: false }, 'gscTet', 'approved'), false);
    assert.equal(canSign(user, 'unknown', 'approved'), false);
    assert.equal(canSign(user, 'qaTet', 'unknown'), false);
  }
  assert.equal(canSign(null, 'qaTet', 'approved'), false);
});

test('non-administrators retain exact role, department and signing step requirements', () => {
  const user = { roles: ['qa'], department: 'qaTet', signingStep: 'checked' };
  assert.equal(canSign(user, 'qaTet', 'checked'), true);
  assert.equal(canSign(user, 'qaTet', 'approved'), false);
  assert.equal(canSign(user, 'qaTapbu', 'checked'), false);
  assert.equal(canSign({ ...user, isActive: false }, 'qaTet', 'checked'), false);
  for (const roles of [['reviewer'], ['qa'], ['supplier'], ['administrator']]) {
    assert.equal(canSign({ roles }, 'qaTet', 'checked'), false);
  }
  assert.equal(canSign({ ...user, roles: ['supplier'] }, 'qaTet', 'checked'), false);
});

test('signature flags and metadata share the exact permission, including QA final', () => {
  assert.deepEqual(signaturePath('qateFinal.signoff.preparedDate'), { department: 'qaTet', action: 'prepared', stage: 'qateFinal.signoff', field: 'preparedDate' });
  assert.deepEqual(signaturePath('tapbu.qa.checked'), { department: 'qaTapbu', action: 'checked', stage: 'tapbu.qa', field: 'checked' });
  assert.equal(signaturePath('docs.drawing'), null);
});
