const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationService } = require('../src/notificationService');
const { buildWorkflowNotificationMessage, buildPcnUpdateNotificationMessage } = require('../src/notificationTemplate');

const record = { id: 'PCN-2026-0001', version: '0000000000000001', status: 'submitted', riskLevel: 'RL0',
  mailRoutingPolicyVersion: 2, supplierName: 'Supplier', materialName: 'Material', internalReview: {} };
const userRow = { Id: 'admin', EmployeeCode: '123', IsActive: true, IdentityProvider: 'employee-code', RoleName: 'admin', DepartmentKey: 'gscTet',
  Email: 'admin@example.test', MailDirectoryId: 'directory', MailVerifiedAt: '2026-10-01',
  MailProfileJson: JSON.stringify({ id: 'directory', email: 'admin@example.test' }) };
function transaction() {
  const calls = [];
  return { calls, request() {
    const inputs = {};
    return { input(name, type, value) { inputs[name] = value; return this; }, async query(query) {
      calls.push({ query, inputs });
      if (query.includes('SELECT SettingsJson')) return { recordset: [{ SettingsJson: JSON.stringify({ schemaVersion: 2,
        groups: [{ key: 'department.gscTet.prepared', emails: 'reviewer@example.test' }],
        legacyGroups: [{ key: 'signoff.prodEngTet', emails: 'reviewer@example.test' }] }) }] };
      if (query.includes('u.MailProfileJson')) return { recordset: [userRow] };
      if (query.includes('INSERT pcn.NotificationJobs')) return { recordset: [{ Id: 'job', Status: 'pending' }] };
      return { recordset: [] };
    } };
  } };
}
const service = () => new NotificationService(null, { mailUrl: 'https://mail.example.test', publicOrigin: 'https://pcn.example.test' });

test('action and information HTML show TESTING DOC only for a strict true saved marker', () => {
  for (const template of [buildWorkflowNotificationMessage, buildPcnUpdateNotificationMessage]) {
    const notice = { completedGroup: 'Prepared completed', nextGroup: 'Checked', pcnUrl: 'https://pcn.example.test/' };
    assert.match(template({ ...record, isTestDocument: true }, notice), />TESTING DOC</);
    for (const value of [undefined, false, 'true', 1]) assert.doesNotMatch(template({ ...record, isTestDocument: value }, notice), /TESTING DOC/);
  }
});

test('every queued mail variant prefixes TESTING DOC while normal subjects remain unchanged', async () => {
  for (const value of [true, false, 'true']) {
    const current = { ...record, isTestDocument: value };
    const notifications = service();
    const tx = transaction();
    const action = await notifications.prepareAction(tx, null, current, 'PCN submitted');
    const update = await notifications.prepareUpdate(tx, current, { queued: false }, 'Reason changed');
    await notifications.queueLegacy(tx, current, {}, { completedKey: 'signoff.gscTet', nextGroupKey: 'signoff.prodEngTet',
      nextLabel: 'Prod.Eng/TET', completedLabel: 'GSC/TET' });
    const legacy = JSON.parse(tx.calls.find(call => call.query.includes('INSERT pcn.NotificationJobs')).inputs.payload);
    const subjects = [action.plan.payload.subject, update.batches[0].subject, legacy.subject];
    const baseline = [`[Action Required] ${record.id} - GSC/TET Prepared`, `[PCN Update] ${record.id} - submitted`, `[PCN] ${record.id} - GSC/TET completed`];
    assert.deepEqual(subjects, baseline.map(subject => value === true ? `[TESTING DOC] ${subject}` : subject));
    for (const payload of [action.plan.payload, update.batches[0], legacy]) assert.equal(payload.message.includes('>TESTING DOC<'), value === true);
  }
});
