const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMailRouting } = require('../src/mailRouting');
const { applyUserMailRouting, filterPendingRecipients, assertCurrentUser, lockUserMailRouting, readUserMailAssignments } = require('../src/userMailRouting');
const { NotificationWorker } = require('../src/notificationWorker');
const { NotificationService } = require('../src/notificationService');
const { SqlPcnRepository } = require('../src/sqlPcnRepository');

const user = { id: '11111111-1111-1111-1111-111111111111', employeeCode: '2205529', isActive: true,
  identityProvider: 'employee-code', roles: ['gsc'], department: 'gscTet', signingStep: 'approved',
  email: 'Person@example.test', mailDirectoryId: 'directory-1', mailVerifiedAt: new Date(),
  mailProfile: { id: 'directory-1', email: 'Person@example.test', displayName: 'Employee Name' } };
const settings = { schemaVersion: 2, groups: [{ key: 'department.gscTet.approved', emails: 'manual@example.test', recipients: [] }] };

test('verified one-step assignments add managed contacts without changing manual version or stored lists', () => {
  const before = normalizeMailRouting(settings);
  const result = applyUserMailRouting(settings, [user]);
  const group = normalizeMailRouting(result).groups[0];
  assert.equal(group.emails, 'manual@example.test');
  assert.equal(group.effectiveEmails, 'manual@example.test; Person@example.test');
  assert.equal(group.automaticRecipients[0].userId, user.id);
  assert.equal(normalizeMailRouting(result).version, before.version);
  assert.notEqual(normalizeMailRouting(result).routingVersion, before.routingVersion);
  assert.equal(JSON.stringify(result), JSON.stringify(settings));
  assert.equal(normalizeMailRouting(result).groups[1].automaticRecipients.length, 0);
});

test('disabled, unverified, wrong-role and retired identities are excluded; manual duplicate survives revocation', () => {
  for (const patch of [{ isActive: false }, { mailVerifiedAt: null }, { identityProvider: 'retired-windows' }, { roles: ['supplier'] }, { department: 'it' }, { mailDirectoryId: '' }]) {
    assert.equal(normalizeMailRouting(applyUserMailRouting(settings, [{ ...user, ...patch }])).groups[0].automaticRecipients.length, 0);
  }
  const duplicate = { ...settings, groups: [{ ...settings.groups[0], emails: 'person@example.test' }] };
  assert.equal(normalizeMailRouting(applyUserMailRouting(duplicate, [user])).groups[0].effectiveEmails, 'person@example.test');
  assert.equal(normalizeMailRouting(applyUserMailRouting(duplicate, [])).groups[0].effectiveEmails, 'person@example.test');
});

test('pending snapshot drops revoked automatic contacts and preserves manual addresses without adding new contacts', () => {
  const payload = { to: 'manual@example.test; Person@example.test', subject: 'test', routingSnapshot: {
    groupKey: 'department.gscTet.approved', manualEmails: 'manual@example.test', automaticRecipients: [{ userId: user.id, email: user.email, department: user.department, signingStep: user.signingStep, directoryId: user.mailDirectoryId }] } };
  assert.equal(filterPendingRecipients(payload, [user]).to, payload.to);
  assert.equal(filterPendingRecipients(payload, [{ ...user, signingStep: 'checked' }]).to, 'manual@example.test');
  assert.equal(filterPendingRecipients({ ...payload, routingSnapshot: { ...payload.routingSnapshot, manualEmails: '' } }, []).to, '');
  assert.equal(filterPendingRecipients({ to: 'old@example.test' }, []).to, 'old@example.test');
});

test('worker cancels a revoked managed-only pending job inside the claim transaction without mailing', async () => {
  const calls = [];
  const payload = { to: user.email, routingSnapshot: { groupKey: 'department.gscTet.approved', manualEmails: '',
    automaticRecipients: [{ userId: user.id, email: user.email, department: user.department, signingStep: user.signingStep, directoryId: user.mailDirectoryId }] } };
  const tx = { begin: async () => calls.push('begin'), commit: async () => calls.push('commit'), rollback: async () => calls.push('rollback'),
    request() { const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; }, async query(query) {
      calls.push({ query, inputs });
      if (query.includes('SELECT TOP(1)') && query.includes('NotificationJobs')) return { recordset: [{ Id: 'job', PayloadJson: JSON.stringify(payload) }] };
      return { recordset: [] };
    } }; } };
  let mailCalls = 0;
  const pool = { transaction: () => tx, request: tx.request };
  const worker = new NotificationWorker(pool, { integrationService: { sendMail: async () => { mailCalls++; } } });
  assert.equal((await worker.runOnce()).status, 'cancelled');
  assert.equal(mailCalls, 0);
  assert(calls.some(call => call.query?.includes("Status=N'cancelled'")));
  assert.equal(calls.at(-1), 'commit');
});

function databaseUser(entry = user) {
  return { Id: entry.id, EmployeeCode: entry.employeeCode, IsActive: entry.isActive, IdentityProvider: entry.identityProvider,
    DepartmentKey: entry.department, SigningStep: entry.signingStep, Email: entry.email, MailDirectoryId: entry.mailDirectoryId,
    MailVerifiedAt: entry.mailVerifiedAt, MailProfileJson: JSON.stringify(entry.mailProfile), RoleName: entry.roles[0] };
}
function routingTransaction(assigned = [databaseUser()], configuration = settings) {
  const calls = [];
  return { calls, begin: async () => calls.push('begin'), commit: async () => calls.push('commit'), rollback: async () => calls.push('rollback'),
    request() { const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; }, async query(query) {
      calls.push({ query, inputs });
      if (query.includes('SettingsJson')) return { recordset: [{ SettingsJson: JSON.stringify(configuration) }] };
      if (query.includes('u.MailProfileJson')) return { recordset: assigned };
      return { recordset: [] };
    } }; } };
}

test('SQL routing read keeps manual settings and verified assignments in one locked transaction', async () => {
  const tx = routingTransaction();
  const repository = new SqlPcnRepository({ transaction: () => tx });
  const result = normalizeMailRouting(await repository.getNotificationSettings());
  assert.equal(result.groups[0].effectiveEmails, 'manual@example.test; Person@example.test');
  assert.equal(tx.calls[0], 'begin');
  assert.equal(tx.calls.at(-1), 'commit');
  assert.equal(tx.calls[1].inputs.mode, 'Shared');
  assert.equal(tx.calls[1].inputs.resource, 'pcn:user-mail-routing');
  const duplicateRole = routingTransaction([databaseUser(), { ...databaseUser(), RoleName: 'reviewer' }]);
  assert.deepEqual((await readUserMailAssignments(duplicateRole))[0].roles, ['gsc', 'reviewer']);
  const corrupt = routingTransaction([{ ...databaseUser(), MailProfileJson: 'invalid json' }]);
  assert.equal(normalizeMailRouting(applyUserMailRouting(settings, await readUserMailAssignments(corrupt))).groups[0].automaticRecipients.length, 0);
});

test('saved handoff snapshots automatic identity and original mail contract separately', async () => {
  const tx = routingTransaction();
  const notifications = new NotificationService(null, { mailUrl: 'https://mail.example.test' });
  const record = { id: 'PCN-2026-0001', version: '0000000000000001', status: 'submitted', riskLevel: 'RL0', internalReview: {} };
  const prepared = await notifications.prepare(tx, null, record);
  assert.equal(prepared.plan.queued, true);
  assert.equal(prepared.plan.payload.to, 'manual@example.test; Person@example.test');
  assert.equal(prepared.plan.payload.routingSnapshot.automaticRecipients[0].directoryId, user.mailDirectoryId);
  assert.equal(prepared.plan.payload.routingSnapshot.manualEmails, 'manual@example.test');
  const audienceQueries = tx.calls.filter(call => call.query?.includes('u.MailProfileJson'));
  assert.equal(audienceQueries.length, 2);
  assert.match(audienceQueries[0].query, /u.SigningStep IS NOT NULL/);
  assert.doesNotMatch(audienceQueries[1].query, /u.SigningStep IS NOT NULL/);
});

test('revoked SQL principal cannot run an aggregate updater after authority changes', async () => {
  const actor = { id: user.id, version: '0000000000000001', sessionSecurityStamp: 'old-stamp' };
  for (const current of [{ IsActive: false }, { IsActive: true, SecurityStamp: 'new-stamp', AccessVersion: Buffer.from(actor.version, 'hex') },
    { IsActive: true, SecurityStamp: 'old-stamp', AccessVersion: Buffer.from('0000000000000002', 'hex') }]) {
    const tx = routingTransaction();
    const request = tx.request;
    tx.request = () => { const value = request(); const query = value.query;
      value.query = text => text.includes('SELECT IsActive,SecurityStamp') ? Promise.resolve({ recordset: [current] }) : query(text); return value; };
    let ran = false;
    const repository = new SqlPcnRepository({ transaction: () => tx });
    await assert.rejects(repository.update('PCN-2026-0001', () => { ran = true; }, 'user', undefined, actor), { statusCode: 401 });
    assert.equal(ran, false);
    assert.equal(tx.calls.at(-1), 'rollback');
  }
  const tx = routingTransaction();
  await assert.rejects(assertCurrentUser(tx, { id: user.id }), { statusCode: 401 });
  await assertCurrentUser(tx, undefined);
  const valid = { request: () => ({ input() { return this; }, query: async () => ({ recordset: [{ IsActive: true, SecurityStamp: 'old-stamp', AccessVersion: Buffer.from(actor.version, 'hex') }] }) }) };
  await assertCurrentUser(valid, actor);
});

test('effective routing rejects overflow and pending email rebinding rather than truncating recipients', async () => {
  const manual = Array.from({ length: 30 }, (_, index) => `user${index}@example.test`).join('; ');
  assert.throws(() => normalizeMailRouting(applyUserMailRouting({ ...settings, groups: [{ ...settings.groups[0], emails: manual }] }, [user])), { statusCode: 400 });
  const payload = { to: user.email, routingSnapshot: { groupKey: 'department.gscTet.approved', manualEmails: '', automaticRecipients: [
    { userId: user.id, email: user.email, department: user.department, signingStep: user.signingStep, directoryId: user.mailDirectoryId }
  ] } };
  assert.equal(filterPendingRecipients(payload, [{ ...user, mailDirectoryId: 'new-id', mailProfile: { ...user.mailProfile, id: 'new-id' } }]).to, '');
  const blocked = { request: () => ({ input() { return this; }, query: async () => ({ recordset: [{ LockResult: -1 }] }) }) };
  await assert.rejects(lockUserMailRouting(blocked), { statusCode: 409 });
});

test('worker retains manual snapshot, commits claim before mailing, and excludes routing metadata from external payload', async () => {
  const tx = routingTransaction([]);
  const payload = { to: 'manual@example.test; Person@example.test', subject: 'test', message: 'message', senderName: 'PCN',
    routingSnapshot: { groupKey: 'department.gscTet.approved', manualEmails: 'manual@example.test', automaticRecipients: [
      { userId: user.id, email: user.email, department: user.department, signingStep: user.signingStep, directoryId: user.mailDirectoryId }
    ] } };
  const originalRequest = tx.request;
  tx.request = () => { const value = originalRequest(); const query = value.query;
    value.query = statement => statement.includes('SELECT TOP(1) Id,PayloadJson') ? Promise.resolve({ recordset: [{ Id: user.id, PayloadJson: JSON.stringify(payload) }] }) : query(statement); return value; };
  let delivered;
  const worker = new NotificationWorker({ transaction: () => tx, request: () => tx.request() }, { integrationService: { sendMail: async mail => {
    assert.equal(tx.calls.at(-1), 'commit'); delivered = mail;
  } } });
  assert.equal((await worker.runOnce()).status, 'sent');
  assert.deepEqual(delivered, { to: 'manual@example.test', subject: 'test', message: 'message', senderName: 'PCN' });
});

test('legacy notification transaction rejects stale actor and PCN snapshots before inserting outbox', async () => {
  const actor = { id: user.id, version: '0000000000000001', sessionSecurityStamp: 'stamp', displayName: 'Employee' };
  const record = { id: 'PCN-2026-0001', version: '0000000000000001', riskLevel: 'RL0', internalReview: {
    signoff: { gscTet: { approved: true, checked: true, prepared: true } }
  } };
  for (const outcome of ['revoked', 'stale-pcn', 'valid']) {
    const tx = routingTransaction([], { groups: [{ key: 'signoff.prodEngTet', emails: 'manual@example.test' }] });
    const request = tx.request;
    tx.request = () => { const value = request(); const query = value.query;
      value.query = async text => {
        if (text.includes('SELECT IsActive,SecurityStamp')) return { recordset: [{ IsActive: true, SecurityStamp: outcome === 'revoked' ? 'new-stamp' : 'stamp', AccessVersion: Buffer.from(actor.version, 'hex') }] };
        if (text.includes('SELECT RowVersion')) return { recordset: [{ RowVersion: Buffer.from(outcome === 'stale-pcn' ? '0000000000000002' : record.version, 'hex') }] };
        if (text.includes('INSERT pcn.NotificationJobs')) { tx.calls.push({ query: text }); return { recordset: [{ Id: user.id, Status: 'pending' }] }; }
        return query(text);
      }; return value; };
    const service = new NotificationService({ transaction: () => tx }, { mailUrl: 'https://mail.example.test' });
    const result = service.workflow(record, { completedGroupKey: 'signoff.gscTet' }, actor);
    if (outcome === 'valid') {
      assert.equal((await result).queued, true);
      assert.equal(tx.calls.at(-1), 'commit');
    } else {
      await assert.rejects(result, { statusCode: outcome === 'revoked' ? 401 : 409 });
      assert(!tx.calls.some(call => call.query?.includes('INSERT pcn.NotificationJobs')));
      assert.equal(tx.calls.at(-1), 'rollback');
    }
  }
});
