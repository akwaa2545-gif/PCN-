const test = require('node:test');
const assert = require('node:assert/strict');
const { canSign, signaturePath, validateSigningAssignment } = require('../src/signingPermissions');
const { assertReviewUpdate, assertWritablePayload } = require('../src/workflowAccess');
const { validateEmployeeIdentity } = require('../src/employeeAccounts');
const { buildAction } = require('../src/documentChecks');
const { buildWorkflowSummary } = require('../src/workflowSummary');
const { buildWorkflow, buildWorkflowProgress } = require('../src/masterData');
const { buildRecordOverview } = require('../src/recordOverview');
const { startApi, fakeAuthService, unsignedPayload } = require('./helpers/apiHarness');

const done = { prepared: true, checked: true, approved: true };
const pe = (department, signingStep = 'prepared', roles = ['productionengineering']) => ({
  id: department, displayName: department, department, signingStep, roles, isActive: true
});
const record = (documentType = 'ta') => ({ id: documentType === 'ta' ? 'T-19112601' : 'S-19112601',
  documentType, status: 'technical_review', riskLevel: 'RL0', internalReview: { signoff: { gscTet: done } } });

test('TA and SC signing assignments are separate valid PE departments', () => {
  for (const department of ['prodEngTa', 'prodEngSc']) {
    assert.doesNotThrow(() => validateSigningAssignment(pe(department)));
    assert.doesNotThrow(() => validateEmployeeIdentity({ employeeCode: '1234567', department }));
    assert.equal(canSign(pe(department), department, 'prepared'), true);
    assert.equal(canSign(pe(department), department, 'checked'), false);
    assert.equal(canSign({ ...pe(department), isActive: false }, department, 'prepared'), false);
  }
  assert.equal(signaturePath('signoff.prodEngTet.prepared', record('ta')).department, 'prodEngTa');
  assert.equal(signaturePath('signoff.prodEngTet.checkedName', record('sc')).department, 'prodEngSc');
  assert.equal(signaturePath('signoff.prodEngTet.prepared').department, 'prodEngTet');
});

test('PE signatures, names and comments cannot cross document type or legacy assignments', () => {
  for (const [type, department] of [['ta', 'prodEngTa'], ['sc', 'prodEngSc']]) {
    const before = record(type).internalReview;
    const signed = { signoff: { ...before.signoff, prodEngTet: { prepared: true } } };
    assert.doesNotThrow(() => assertReviewUpdate(before, signed, pe(department), 'RL0', record(type)));
    for (const other of ['prodEngTet', 'prodEngTa', 'prodEngSc'].filter(key => key !== department)) {
      assert.throws(() => assertReviewUpdate(before, signed, pe(other), 'RL0', record(type)), { statusCode: 403 });
      assert.throws(() => assertReviewUpdate(signed, { signoff: { ...signed.signoff,
        prodEngTet: { prepared: true, preparedName: 'Other signer' } } }, pe(other), 'RL0', record(type)), { statusCode: 403 });
      for (const roles of [['productionengineering'], ['reviewer']]) {
        assert.throws(() => assertReviewUpdate(before, { signoff: { ...before.signoff,
          prodEngTet: { comment: 'Other team note' } } }, pe(other, 'prepared', roles), 'RL0', record(type)), { statusCode: 403 });
      }
    }
    assert.doesNotThrow(() => assertReviewUpdate(before, { signoff: { ...before.signoff,
      prodEngTet: { comment: 'Own team note' } } }, pe(department), 'RL0', record(type)));
    assert.throws(() => assertReviewUpdate({}, { signoff: { prodEngTet: { prepared: true } } }, pe(department), 'RL0', record(type)), { statusCode: 400 });
  }
  const legacy = { ...record(), id: 'PCN-2026-0001', documentType: undefined };
  assert.throws(() => assertReviewUpdate(legacy.internalReview,
    { signoff: { gscTet: done, prodEngTet: { prepared: true } } }, pe('prodEngTa'), 'RL0', legacy), { statusCode: 403 });
});

test('administrators and valid Developers retain typed workflow authority without bypassing prerequisites', () => {
  for (const user of [{ roles: ['admin'], isActive: true },
    { roles: ['developer'], department: 'developer', signingStep: null, isActive: true }]) {
    const before = record().internalReview;
    assert.doesNotThrow(() => assertReviewUpdate(before,
      { signoff: { gscTet: done, prodEngTet: { prepared: true } } }, user, 'RL0', record()));
    assert.throws(() => assertReviewUpdate({}, { signoff: { prodEngTet: { prepared: true } } }, user, 'RL0', record()), { statusCode: 400 });
  }
  assert.doesNotThrow(() => assertWritablePayload({ documentType: 'ta', reason: 'Changed' }));
});

test('responsibility, people and timeline resolve only the matching PE team', () => {
  for (const [type, department] of [['ta', 'prodEngTa'], ['sc', 'prodEngSc']]) {
    const current = record(type);
    const users = ['prodEngTet', 'prodEngTa', 'prodEngSc'].map(key => pe(key));
    const action = buildAction(current, pe(department), users);
    assert.equal(action.department, department);
    assert.equal(action.canAct, true);
    assert.deepEqual(action.people.map(person => person.displayName), [department]);
    assert.equal(buildAction(current, pe(department === 'prodEngTa' ? 'prodEngSc' : 'prodEngTa'), users).canAct, false);
    const summary = buildWorkflowSummary(current);
    assert.equal(summary.stages[1].label, type === 'ta' ? 'Prod.Eng/TA' : 'Prod.Eng/SC');
    assert.match(summary.nextAction.label, type === 'ta' ? /Prod\.Eng\/TA/ : /Prod\.Eng\/SC/);
    const overview = buildRecordOverview(current, pe(department), users);
    assert.equal(overview.dashboard.action.department, department);
    assert.equal(overview.dashboard.progress.currentOwner, type === 'ta' ? 'Prod.Eng/TA' : 'Prod.Eng/SC');
  }
});

test('record-aware progress preserves legacy route labels and one PE stage', () => {
  assert.equal(buildWorkflow('RL2').find(step => step.key === 'technical_review').owner, 'Prod.Eng/TET');
  const typed = buildWorkflow('RL2', record('ta'));
  assert.equal(typed.filter(step => step.key === 'technical_review').length, 1);
  assert.equal(typed.find(step => step.key === 'technical_review').owner, 'Prod.Eng/TA');
  assert.equal(buildWorkflowProgress(record('sc')).currentOwner, 'Prod.Eng/SC');
});

test('HTTP saves enforce the saved TA/SC team for signatures and comments without changing denied records', async t => {
  const api = await startApi(t, { authService: fakeAuthService({ additionalUsers: [
    { ...pe('prodEngTa'), id: 'ta-pe-id', username: 'ta-pe' },
    { ...pe('prodEngSc'), id: 'sc-pe-id', username: 'sc-pe' },
    { ...pe('prodEngTet'), id: 'legacy-pe-id', username: 'legacy-pe' }
  ] }) });
  const admin = await api.login('admin');
  for (const [type, signer] of [['ta', 'ta-pe'], ['sc', 'sc-pe']]) {
    const created = await api.request('/api/pcns', { method: 'POST', session: admin,
      body: { ...unsignedPayload, documentType: type } });
    assert.equal(created.status, 201, created.text);
    const current = await api.repository.seedHistoricalReview(created.body.data.id, { signoff: { gscTet: done } });
    const revisions = await api.repository.getRevisions(current.id);
    for (const denied of ['ta-pe', 'sc-pe', 'legacy-pe'].filter(name => name !== signer)) {
      for (const value of [{ prepared: true }, { comment: 'Wrong team note' }]) {
        const response = await api.request(`/api/pcns/${current.id}`, { method: 'PATCH', session: await api.login(denied),
          body: { version: current.version, internalReview: { signoff: { prodEngTet: value } } } });
        assert.equal(response.status, 403, response.text);
        assert.deepEqual(await api.repository.findById(current.id), current);
        assert.deepEqual(await api.repository.getRevisions(current.id), revisions);
      }
    }
    const result = await api.request(`/api/pcns/${current.id}`, { method: 'PATCH', session: await api.login(signer),
      body: { version: current.version, internalReview: { signoff: { prodEngTet: { prepared: true, comment: 'Own team review' } } } } });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.data.internalReview.signoff.prodEngTet.preparedName, type === 'ta' ? 'prodEngTa' : 'prodEngSc');
    const summary = await api.request(`/api/pcns/${current.id}/workflow-summary`, { session: admin });
    assert.equal(summary.status, 200, summary.text);
    assert.equal(summary.body.data.stages[1].label, type === 'ta' ? 'Prod.Eng/TA' : 'Prod.Eng/SC');
  }
});
