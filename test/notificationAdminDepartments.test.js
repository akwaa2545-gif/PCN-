const test = require('node:test');
const assert = require('node:assert/strict');
const { notificationDepartmentKeys, notificationRecipient, filterPendingUpdates } = require('../src/notificationUpdates');
const { NotificationService } = require('../src/notificationService');
const { NotificationWorker } = require('../src/notificationWorker');

const base = { id: 'PCN-2026-0001', version: '0000000000000001', ownerUserId: 'owner', status: 'gsc_review', riskLevel: 'RL0',
  mailRoutingPolicyVersion: 2, internalReview: {} };
const signed = { prepared: true, checked: true, approved: true };
const admin = (id, department, patch = {}) => ({ id, department, roles: ['admin'], isActive: true, identityProvider: 'employee-code',
  email: `${id}@example.test`, mailVerifiedAt: '2026-10-01', mailDirectoryId: id,
  mailProfile: { id, email: `${id}@example.test` }, ...patch });
const snapshot = user => ({ userId: user.id, email: user.email, directoryId: user.mailDirectoryId,
  ...(user.roles.includes('admin') ? { department: user.department } : {}) });
const payload = (users, departmentKeys = ['gscTet']) => ({ to: users.map(user => user.email).join('; '), subject: 'PCN updated',
  message: 'safe', senderName: 'PCN', notificationKind: 'pcn_update', updateSnapshot: {
    pcnId: base.id, audiencePolicyVersion: 1, departmentKeys, recipients: users.map(snapshot) } });

test('explicit review changes select only their departments, including comments, resets and final judgment', () => {
  const cases = [
    [{}, { signoff: { gscTet: signed } }, ['gscTet']],
    [{ signoff: { gscTet: signed } }, {}, ['gscTet']],
    [{}, { signoff: { prodEngTet: { comment: 'review' } } }, ['prodEngTet']],
    [{}, { signoff: { qaTet: { prepared: true } }, qateFinal: { comment: 'judgment' } }, ['qaTet']],
    [{}, { tapbu: { gsc: { comment: 'review' } } }, ['gscTapbu']],
    [{}, { tapbu: { qa: signed } }, ['qaTapbu']],
    [{}, { docs: { greenProcurement: true }, materialCodeDescription: 'part' }, ['gscTet']],
    [{}, { tapbu: { need: true, comment: 'required' } }, ['gscTet']],
    [{}, { decision: { approved: true } }, ['qaTet']],
    [{}, { supplierNotification: { prepared: true } }, ['gscTet']],
    [{}, { signoff: { prodEngTet: signed, qaTet: signed } }, ['prodEngTet', 'qaTet']]
  ];
  for (const [before, after, departments] of cases) {
    assert.deepEqual(notificationDepartmentKeys({ ...base, internalReview: before }, { ...base, internalReview: after }), departments);
  }
  const before = { ...base, internalReview: { signoff: { gscTet: { prepared: true, checked: true } } } };
  const after = { ...before, internalReview: { signoff: { gscTet: signed } } };
  assert.deepEqual(notificationDepartmentKeys(before, after), ['gscTet'], 'handoff does not turn GSC change into Prod.Eng update');
});

test('generic edits use union of before and after active departments; blank defaults and terminal unknown fail closed', () => {
  assert.deepEqual(notificationDepartmentKeys(null, { ...base, status: 'submitted' }), ['gscTet']);
  const qa = { ...base, internalReview: { signoff: { gscTet: signed, prodEngTet: signed } } };
  assert.deepEqual(notificationDepartmentKeys(qa, { ...qa, materialName: 'changed' }), ['qaTet']);
  assert.deepEqual(notificationDepartmentKeys(qa, { ...qa, status: 'closed' }), ['qaTet']);
  assert.deepEqual(notificationDepartmentKeys({ ...base, status: 'closed' }, { ...base, status: 'closed', materialName: 'changed' }), []);
  assert.deepEqual(notificationDepartmentKeys(qa, { ...qa, internalReview: { ...qa.internalReview, docs: { greenProcurement: false },
    signoff: { ...qa.internalReview.signoff, qaTet: { comment: '' } } } }), ['qaTet']);
  const done = { ...base, status: 'approved', internalReview: { signoff: { gscTet: signed, prodEngTet: signed, qaTet: signed }, qateFinal: { signoff: signed } } };
  assert.deepEqual(notificationDepartmentKeys(done, { ...done, materialName: 'changed' }), ['gscTet']);
});

test('only actual Administrators require a known matching department, even when they own the PCN', () => {
  assert(notificationRecipient(admin('gsc', 'gscTet'), base, ['gscTet']));
  for (const department of ['qaTet', null, 'developer', 'unknown', undefined]) {
    assert.equal(notificationRecipient(admin('owner', department), base, ['gscTet']), null);
  }
  assert.equal(notificationRecipient(admin('gsc', 'gscTet'), base), null);
  assert.equal(notificationRecipient(admin('gsc', 'gscTet', { roles: ['ADMIN'] }), base, ['qaTet']), null);
  assert(notificationRecipient(admin('dev', 'developer', { roles: ['developer'], signingStep: null }), base, []));
  assert(notificationRecipient(admin('review', null, { roles: ['reviewer'] }), base, []));
});

function transaction(users, savedPayload) {
  const calls = [];
  return { calls, begin: async () => {}, commit: async () => calls.push('commit'), rollback: async () => {}, request() {
    const inputs = {};
    return { input(name, type, value) { inputs[name] = value; return this; }, async query(query) {
      calls.push({ query, inputs });
      if (query.includes('SELECT SettingsJson')) return { recordset: [{ SettingsJson: '{"schemaVersion":2,"groups":[]}' }] };
      if (query.includes('u.MailProfileJson')) return { recordset: users.map(user => ({ Id: user.id, EmployeeCode: user.id,
        IsActive: user.isActive, IdentityProvider: user.identityProvider, DepartmentKey: user.department, SigningStep: user.signingStep,
        Email: user.email, MailDirectoryId: user.mailDirectoryId, MailVerifiedAt: user.mailVerifiedAt,
        MailProfileJson: JSON.stringify(user.mailProfile), RoleName: user.roles[0] })) };
      if (query.includes('SELECT TOP(1)')) return { recordset: [{ Id: 'job', PayloadJson: JSON.stringify(savedPayload) }] };
      if (query.includes('SELECT PcnCode,OwnerUserId')) return { recordset: [{ PcnCode: base.id, OwnerUserId: base.ownerUserId }] };
      return { recordset: [] };
    } };
  } };
}

test('general update queue saves changed scope and Administrator department, excludes out-of-scope and action audience', async () => {
  const users = [admin('gsc', 'gscTet'), admin('qa', 'qaTet'), admin('none', null),
    admin('dev', 'developer', { roles: ['developer'], signingStep: null })];
  const service = new NotificationService(null, { mailUrl: 'https://mail.example.test', publicOrigin: 'http://pcn.example.test' });
  const tx = transaction(users);
  const after = { ...base, internalReview: { signoff: { gscTet: signed } } };
  const update = await service.prepareUpdate(tx, after, { queued: false }, 'Internal review', base);
  const saved = update.batches[0].updateSnapshot;
  assert.deepEqual(saved.departmentKeys, ['gscTet']);
  assert.equal(saved.audiencePolicyVersion, 1);
  assert.deepEqual(saved.recipients.map(entry => entry.userId).sort(), ['dev', 'gsc']);
  assert.equal(saved.recipients.find(entry => entry.userId === 'gsc').department, 'gscTet');
  const dedup = await service.prepareUpdate(tx, after, { queued: true, payload: { to: 'GSC@example.test' } }, 'Internal review', base);
  assert.deepEqual(dedup.batches[0].updateSnapshot.recipients.map(entry => entry.userId), ['dev']);
  const prepared = await service.prepare(tx, base, after);
  assert.deepEqual(prepared.plan.update.batches[0].updateSnapshot.departmentKeys, ['gscTet'], 'prepare forwards prior record');
});

test('queued scope is immutable; reassignment, promotion and old scopeless Administrator entries are dropped', () => {
  const gsc = admin('gsc', 'gscTet');
  const pending = payload([gsc], ['gscTet', 'qaTet']);
  assert.equal(filterPendingUpdates(pending, [gsc], { ...base, status: 'closed' }).to, gsc.email);
  assert.equal(filterPendingUpdates(pending, [{ ...gsc, department: 'qaTet' }], base).to, '');
  const reviewer = admin('reviewer', 'gscTet', { roles: ['reviewer'] });
  assert.equal(filterPendingUpdates(payload([reviewer]), [{ ...reviewer, roles: ['admin'] }], base).to, '');
  const legacy = { ...pending, updateSnapshot: { pcnId: base.id, recipients: [snapshot(gsc), snapshot(reviewer)] } };
  assert.equal(filterPendingUpdates(legacy, [gsc, reviewer], base).to, reviewer.email);
  for (const patch of [{ audiencePolicyVersion: 999 }, { departmentKeys: ['unknown'] }, { departmentKeys: null }]) {
    assert.equal(filterPendingUpdates({ ...pending, updateSnapshot: { ...pending.updateSnapshot, ...patch } }, [gsc], base).to, '');
  }
});

test('worker drops reassigned Administrator from mixed batches, cancels empty legacy batches and sends only gateway fields', async () => {
  const gsc = admin('gsc', 'gscTet');
  const qa = admin('qa', 'qaTet');
  const reviewer = admin('reviewer', null, { roles: ['reviewer'] });
  const old = { ...payload([gsc]), updateSnapshot: { pcnId: base.id, recipients: [snapshot(gsc)] } };
  for (const [saved, users, expected] of [[payload([gsc, reviewer]), [{ ...gsc, department: 'qaTet' }, reviewer, qa], reviewer.email],
    [payload([gsc]), [gsc], gsc.email], [old, [gsc], '']]) {
    const tx = transaction(users, saved);
    let delivered;
    const worker = new NotificationWorker({ transaction: () => tx, request: () => tx.request() }, {
      integrationService: { sendMail: async mail => { assert.equal(tx.calls.at(-1), 'commit'); delivered = mail; } }
    });
    assert.equal((await worker.runOnce()).status, expected ? 'sent' : 'cancelled');
    assert.deepEqual(delivered, expected ? { to: expected, subject: saved.subject, message: saved.message, senderName: saved.senderName } : undefined);
    assert(tx.calls.some(call => call.query?.includes('sp_getapplock')));
  }
});
