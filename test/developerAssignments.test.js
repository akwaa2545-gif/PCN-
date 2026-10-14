const test = require('node:test');
const assert = require('node:assert/strict');
const {
  employeeRoles,
  employeeDepartments,
  validateEmployeeAccount,
  validateUserAssignment
} = require('../src/employeeAccounts');

const developerAccount = Object.freeze({
  employeeCode: '2512501',
  displayName: 'Developer employee',
  department: 'developer',
  roles: Object.freeze(['developer']),
  signingStep: null
});
const validators = [validateEmployeeAccount, validateUserAssignment];
const isBadRequest = error => error?.statusCode === 400;

test('employee assignment catalogs include Developer role and department', () => {
  assert.ok(employeeRoles.includes('developer'));
  assert.deepEqual(employeeDepartments.find(entry => entry.key === 'developer'), {
    key: 'developer', label: 'Developer'
  });
});

test('Developer role and department form a valid non-signing assignment', () => {
  for (const validate of validators) {
    assert.doesNotThrow(() => validate(developerAccount));
    assert.doesNotThrow(() => validate({ ...developerAccount, signingStep: undefined }));
  }
});

test('Developer assignments reject every signing step', () => {
  for (const validate of validators) {
    for (const signingStep of ['approved', 'checked', 'prepared', '', 'unknown']) {
      assert.throws(() => validate({ ...developerAccount, signingStep }), isBadRequest);
    }
  }
});

test('Developer role and department cannot be assigned independently or mixed with other roles', () => {
  const mismatches = [
    { department: 'it', roles: ['developer'] },
    { department: 'gscTet', roles: ['developer'] },
    { department: 'developer', roles: ['admin'] },
    { department: 'developer', roles: ['reviewer'] },
    { department: 'developer', roles: ['developer', 'admin'] },
    { department: 'developer', roles: ['developer', 'supplier'] },
    { department: 'developer', roles: [] },
    { department: 'developer', roles: null },
    { department: 'developer', roles: 'developer' }
  ];
  for (const validate of validators) {
    for (const assignment of mismatches) {
      assert.throws(() => validate({ ...developerAccount, ...assignment }), isBadRequest);
    }
  }
});

test('existing non-signing IT and signing GSC assignments remain valid', () => {
  const assignments = [
    { department: 'it', roles: ['admin'], signingStep: null },
    { department: 'gscTet', roles: ['gsc'], signingStep: 'checked' }
  ];
  for (const validate of validators) {
    for (const assignment of assignments) {
      assert.doesNotThrow(() => validate({ ...developerAccount, ...assignment }));
    }
  }
});
