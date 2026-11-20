const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveNextMailTarget, normalizeMailRouting } = require('../src/mailRouting');
const { notificationDepartmentKeys, notificationRecipient } = require('../src/notificationUpdates');
const { applyReviewTiming, prodEngDeadline } = require('../src/reviewTiming');
const { defaultWorkflowSettings, readWorkflowSettings, validateWorkflowSettings } = require('../src/workflowSettings');
const { SqlWorkflowSettings } = require('../src/sqlWorkflowSettings');
const { NotificationService } = require('../src/notificationService');

const done = { prepared: true, checked: true, approved: true };
const start = '2026-11-19T02:00:00.000Z';
const active = type => ({ id: type === 'ta' ? 'T-19112601' : 'S-19112601', documentType: type, status: 'technical_review', riskLevel: 'RL0',
  internalReview: { signoff: { gscTet: done, prodEngTet: {} } }, reviewTiming: { prodEngTet: { startedAt: start } } });
const legacyDays = { gscTet: null, prodEngTet: 7, qaTet: 3, gscTapbu: null, qaTapbu: null, qaFinal: null };

test('TA and SC PE steps select only their own configured recipient group', () => {
  for (const type of ['ta', 'sc']) {
    const department = type === 'ta' ? 'prodEngTa' : 'prodEngSc';
    const target = resolveNextMailTarget(active(type));
    assert.equal(target.stageKey, 'signoff.prodEngTet');
    assert.equal(target.departmentKey, department);
    assert.equal(target.groupKey, `department.${department}.prepared`);
    assert.match(target.label, type === 'ta' ? /TA/ : /SC/);
  }
  const routing = normalizeMailRouting({ schemaVersion: 2, groups: [{ key: 'department.prodEngTet.prepared', emails: 'legacy@example.test' }] });
  assert.equal(routing.groups.find(group => group.key === 'department.prodEngTa.prepared').effectiveEmails, '');
  assert.equal(routing.groups.find(group => group.key === 'department.prodEngSc.prepared').effectiveEmails, '');
  assert.equal(resolveNextMailTarget({ ...active('ta'), id: 'PCN-2026-0001', documentType: undefined }).departmentKey, 'prodEngTet');
});

test('PE update administrator scope follows the record team rather than the signature storage key', () => {
  for (const type of ['ta', 'sc']) {
    const before = active(type);
    const after = { ...before, internalReview: { signoff: { ...before.internalReview.signoff, prodEngTet: { prepared: true } } } };
    const scope = notificationDepartmentKeys(before, after);
    const department = type === 'ta' ? 'prodEngTa' : 'prodEngSc';
    assert.deepEqual(scope, [department]);
    const admin = { id: 'a', roles: ['admin'], isActive: true, identityProvider: 'employee-code', department,
      email: 'a@example.test', mailDirectoryId: 'a', mailVerifiedAt: start, mailProfile: { id: 'a', email: 'a@example.test' } };
    assert(notificationRecipient(admin, after, scope));
    assert.equal(notificationRecipient({ ...admin, department: type === 'ta' ? 'prodEngSc' : 'prodEngTa' }, after, scope), null);
  }
});

test('typed PE limits stay independent and preserve the original PE handoff clock', () => {
  const settings = defaultWorkflowSettings();
  settings.pendingDays = { ...settings.pendingDays, prodEngTet: 9, prodEngTa: 1, prodEngSc: 5 };
  for (const type of ['ta', 'sc']) {
    const before = active(type);
    const saved = applyReviewTiming(before, { ...before, reason: 'Ordinary edit' }, '2026-11-20T03:00:00.000Z');
    assert.deepEqual(saved.reviewTiming, { prodEngTet: { startedAt: start } });
    const deadline = prodEngDeadline(saved, new Date('2026-11-21T02:00:00Z'), settings);
    assert.equal(deadline.department, type === 'ta' ? 'prodEngTa' : 'prodEngSc');
    assert.equal(deadline.dueAt, type === 'ta' ? '2026-11-20T02:00:00.000Z' : '2026-11-24T02:00:00.000Z');
  }
});

test('stored legacy settings inherit both PE allowances but six-key saves cannot overwrite them', async () => {
  for (const days of [7, null]) {
    const legacy = { schemaVersion: 1, version: 3, pendingDays: { ...legacyDays, prodEngTet: days }, updatedAt: null, updatedBy: null };
    const settings = await readWorkflowSettings({ getWorkflowSettings: async () => legacy });
    assert.equal(settings.pendingDays.prodEngTa, days);
    assert.equal(settings.pendingDays.prodEngSc, days);
    assert.throws(() => validateWorkflowSettings({ schemaVersion: 1, version: 3, pendingDays: legacy.pendingDays }), { statusCode: 400 });
  }
  const adapter = new SqlWorkflowSettings({ request: () => ({ query: async () => ({ recordset: [{ SettingsJson: JSON.stringify({ schemaVersion: 1, pendingDays: legacyDays }), Version: 2 }] }) }) });
  const settings = await adapter.get();
  assert.equal(settings.pendingDays.prodEngTa, 7);
  assert.equal(settings.pendingDays.prodEngSc, 7);
});

test('typed saved records pass notification identity checks and cannot use legacy workflow mail', async () => {
  const service = new NotificationService(null, { publicOrigin: 'http://localhost' });
  const record = { ...active('ta'), version: '0000000000000001' };
  assert.doesNotThrow(() => service.assertSavedVersion(record));
  assert.equal(service.pcnLink(record.id), 'http://localhost/form.html?id=T-19112601');
  assert.deepEqual(await service.workflow(record), { queued: false, reason: 'handled_on_save' });
});
