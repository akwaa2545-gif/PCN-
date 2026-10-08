const test = require('node:test');
const assert = require('node:assert/strict');
const { meaningfulUpdate, notificationRecipient, batchRecipients, filterPendingUpdates } = require('../src/notificationUpdates');
const { NotificationService } = require('../src/notificationService');
const { NotificationWorker } = require('../src/notificationWorker');
const { SqlPcnRepository } = require('../src/sqlPcnRepository');
const record = { id: 'PCN-2026-0001', status: 'gsc_review', ownerUserId: 'owner', internalReview: {} };
const user = { id: 'admin', identityProvider: 'employee-code', isActive: true, roles: ['admin'], email: 'Admin@example.test',
  mailVerifiedAt: '2026-10-07', mailDirectoryId: 'ad1', mailProfile: { id: 'ad1', email: 'admin@example.test' } };

test('meaningful updates ignore server metadata and drafts but include domain changes, resets and comments', () => {
  assert.deepEqual(meaningfulUpdate(record, { ...record, version: '2', updatedAt: 'later', mailRoutingState: { status: 'pending' } }), []);
  assert.deepEqual(meaningfulUpdate(null, { ...record, status: 'draft' }), []);
  assert.deepEqual(meaningfulUpdate(record, { ...record, status: 'draft' }), ['Status']);
  assert.deepEqual(meaningfulUpdate(record, { ...record, comments: [{ body: 'new' }], internalReview: { signoff: { gscTet: { approved: true } } } }), ['Comments', 'Internal review']);
  assert.deepEqual(meaningfulUpdate(null, { ...record, status: 'submitted' }), ['PCN submitted']);
});

test('general audience includes no-step admin and only active verified users with record access', () => {
  assert.equal(notificationRecipient(user, record).email, user.email);
  for (const patch of [{ isActive: false }, { identityProvider: 'retired' }, { mailVerifiedAt: null },
    { mailProfile: { id: 'different', email: user.email } }, { roles: ['supplier'] }]) {
    assert.equal(notificationRecipient({ ...user, ...patch }, record), null);
  }
  assert(notificationRecipient({ ...user, id: 'owner', roles: ['supplier'] }, record));
});

test('recipient batching deduplicates and sorts without dropping overflow, respecting both bounds', () => {
  const entries = Array.from({ length: 75 }, (_, i) => ({ userId: `u${i}`, email: `u${String(i).padStart(2, '0')}@example.test`, directoryId: `d${i}` }));
  const batches = batchRecipients([...entries.reverse(), { ...entries[0], email: entries[0].email.toUpperCase() }]);
  assert.equal(batches.length, 3);
  assert.equal(batches.reduce((sum, batch) => sum + batch.length, 0), 75);
  for (const batch of batches) { assert(batch.length <= 30); assert(batch.map(r => r.email).join('; ').length <= 1000); }
  const long = Array.from({ length: 20 }, (_, i) => ({ userId: `l${i}`, email: `${'x'.repeat(80)}${i}@example.test`, directoryId: `d${i}` }));
  assert.equal(batchRecipients(long).length, 2);
});

test('pending update audience drops revoked, changed identities and lost access without adding new users', () => {
  const payload = { to: user.email, updateSnapshot: { pcnId: record.id, recipients: [{ userId: user.id, email: user.email, directoryId: user.mailDirectoryId }] } };
  assert.equal(filterPendingUpdates(payload, [user], record).to, user.email);
  for (const entries of [[], [{ ...user, isActive: false }], [{ ...user, roles: ['supplier'] }], [{ ...user, mailDirectoryId: 'changed' }],
    [{ ...user, email: 'new@example.test', mailProfile: { id: user.mailDirectoryId, email: 'new@example.test' } }]]) {
    assert.equal(filterPendingUpdates(payload, entries, record).to, '');
  }
  assert.equal(filterPendingUpdates(payload, [user], null).to, '');
});

function sqlUser(entry) {
  return { Id: entry.id, EmployeeCode: '123', IsActive: entry.isActive, IdentityProvider: entry.identityProvider,
    DepartmentKey: entry.department, SigningStep: entry.signingStep, Email: entry.email, MailDirectoryId: entry.mailDirectoryId,
    MailVerifiedAt: entry.mailVerifiedAt, MailProfileJson: JSON.stringify(entry.mailProfile), RoleName: entry.roles[0] };
}
function transaction({ users = [user], settings = { schemaVersion: 2, groups: [] }, payload, current = record, failAt = 0 } = {}) {
  const calls = [];
  let writes = 0;
  return { calls, begin: async () => calls.push('begin'), commit: async () => calls.push('commit'), rollback: async () => calls.push('rollback'), request() {
    const inputs = {};
    return { input(name, type, value) { inputs[name] = value; return this; }, async query(query) {
      calls.push({ query, inputs });
      if (query.includes('SELECT SettingsJson')) return { recordset: [{ SettingsJson: JSON.stringify(settings) }] };
      if (query.includes('u.MailProfileJson')) return { recordset: users.map(sqlUser) };
      if (query.includes('SELECT TOP(1)')) return { recordset: payload ? [{ Id: 'job', PayloadJson: JSON.stringify(payload) }] : [] };
      if (query.includes('SELECT PcnCode,OwnerUserId')) return { recordset: current ? [{ PcnCode: current.id, OwnerUserId: current.ownerUserId }] : [] };
      if (query.includes('INSERT pcn.NotificationJobs')) {
        if (++writes === failAt) throw new Error('outbox insert failed');
        return { recordset: [{ Id: `job${writes}`, Status: 'pending' }] };
      }
      return { recordset: [] };
    } };
  } };
}
const service = options => new NotificationService(null, { mailUrl: 'https://mail.example.test', publicOrigin: 'https://pcn.example.test', ...options });
const base = { ...record, version: '0000000000000001', riskLevel: 'RL0', mailRoutingPolicyVersion: 2 };
const outbox = tx => tx.calls.filter(call => call.query?.includes('INSERT pcn.NotificationJobs'));

test('browser blank defaults on a sparse review do not queue a general update', async () => {
  const before = { ...base, internalReview: { pcnCode: base.id } };
  const after = { ...before, internalReview: { ...before.internalReview, materialCodeDescription: '',
    docs: { hazardousReport: false, greenProcurement: false },
    supplierSignoff: { approved: { checked: false, date: '' } }, signoff: { gscTet: {} }, optional: null } };
  assert.deepEqual(meaningfulUpdate(before, after), []);
  const tx = transaction();
  const notifications = service();
  const prepared = await notifications.prepare(tx, before, after);
  assert.equal(prepared.plan.update.queued, false);
  assert.equal(prepared.plan.update.reason, 'no_change');
  await notifications.persisted(tx, prepared.record, prepared.plan);
  assert.equal(outbox(tx).length, 0);
});

test('default normalization preserves real clears, zero, array order and array items', () => {
  for (const [before, after] of [
    [{ internalReview: { docs: { hazardousReport: true } } }, { internalReview: { docs: { hazardousReport: false } } }],
    [{ internalReview: { comment: 'before' } }, { internalReview: { comment: '' } }],
    [{ reason: 'before' }, { reason: null }], [{ quantity: 1 }, { quantity: 0 }], [{}, { quantity: 0 }],
    [{ changeRows: [{ value: 1 }, { value: 2 }] }, { changeRows: [{ value: 2 }, { value: 1 }] }],
    [{ changeRows: [{ value: 1 }] }, { changeRows: [{ value: 1 }, {}] }],
    [{ comments: [false] }, { comments: [null] }]
  ]) {
    assert(meaningfulUpdate({ ...base, ...before }, { ...base, ...after }).length > 0);
  }
  assert.deepEqual(meaningfulUpdate(base, { ...base, optional: '', internalReview: { unused: { flag: false, nested: {} } } }), []);
});

test('general update and action mail have distinct content; action recipients are excluded case-insensitively', async () => {
  const target = { ...user, id: 'gsc', roles: ['gsc'], department: 'gscTet', signingStep: 'approved', email: 'Actor@example.test',
    mailProfile: { id: user.mailDirectoryId, email: 'actor@example.test' } };
  const tx = transaction({ users: [user, target], settings: { schemaVersion: 2, groups: [{ key: 'department.gscTet.approved', emails: 'ACTOR@example.test', recipients: [] }] } });
  const notifications = service();
  const prepared = await notifications.prepare(tx, null, { ...base, status: 'submitted' });
  assert.equal(prepared.plan.queued, true);
  assert.equal(prepared.plan.update.queued, true);
  assert.equal(prepared.plan.update.batches[0].to, user.email);
  assert.match(prepared.plan.payload.subject, /^\[Action Required\]/);
  assert.match(prepared.plan.payload.message, />GSC\/TET<\/td>/);
  assert.match(prepared.plan.payload.message, />Approved<\/td>/);
  assert.doesNotMatch(prepared.plan.payload.message, />gscTet<\/td>|>approved<\/td>/);
  assert.match(prepared.plan.update.batches[0].subject, /PCN Update/);
  assert.notEqual(prepared.plan.payload.message, prepared.plan.update.batches[0].message);
  const saved = await notifications.persisted(tx, prepared.record, prepared.plan);
  assert.equal(saved.actionRequired.queued, true);
  assert.equal(saved.update.jobCount, 1);
  assert.equal(outbox(tx).length, 2);
  assert.equal(outbox(tx)[1].inputs.action, 'pcn_update');
  assert.equal(outbox(tx)[1].inputs.eventKey, `${base.id}:${base.version}:update:0`);
  assert.doesNotMatch(JSON.stringify(saved), /example.test|payload|batches|recipients/);
});

test('blocked handoff does not prevent general update or exclude eligible action users', async () => {
  const tx = transaction();
  const notifications = service();
  const prepared = await notifications.prepare(tx, null, { ...base, status: 'submitted' });
  assert.equal(prepared.plan.reason, 'recipient_not_configured');
  assert.equal(prepared.plan.update.batches[0].to, user.email);
  const saved = await notifications.persisted(tx, prepared.record, prepared.plan);
  assert.equal(saved.queued, true);
  assert.equal(saved.actionRequired.queued, false);
  assert.equal(saved.update.queued, true);
  assert.equal(outbox(tx).length, 1);
});

test('invalid action recipient configuration blocks action without suppressing general update', async () => {
  const tx = transaction({ settings: { schemaVersion: 2, groups: [{ key: 'department.gscTet.approved', emails: 'invalid address', recipients: [] }] } });
  const prepared = await service().prepare(tx, null, { ...base, status: 'submitted' });
  assert.equal(prepared.plan.reason, 'notification_configuration_invalid');
  assert.equal(prepared.record.mailRoutingState.status, 'blocked');
  assert.equal(prepared.plan.update.queued, true);
  assert.equal(prepared.plan.update.batches[0].to, user.email);
});

test('updates notify on meaningful edits without repeating action; metadata and draft saves remain silent', async () => {
  const notifications = service();
  for (const patch of [{ materialName: 'new material' }, { status: 'supplier_action' }, { internalReview: { comment: 'new' } },
    { internalReview: {} }, { status: 'closed' }, { comments: [{ text: 'new' }] }, { approvals: [{ decision: 'yes' }] }]) {
    const before = { ...base, internalReview: { comment: 'prior' } };
    const prepared = await notifications.prepare(transaction(), before, { ...before, ...patch });
    assert.equal(prepared.plan.queued, false);
    assert.equal(prepared.plan.update.queued, true);
  }
  for (const [before, after] of [[base, { ...base, updatedAt: 'later', version: '0000000000000002' }],
    [{ ...base, status: 'draft' }, { ...base, status: 'draft', materialName: 'new' }]]) {
    const prepared = await notifications.prepare(transaction(), before, after);
    assert.equal(prepared.plan.update.queued, false);
  }
});

test('missing server mail or invalid public origin blocks update; empty audience is explained', async () => {
  for (const [notifications, tx, reason] of [[service({ mailUrl: '' }), transaction(), 'mail_not_configured'],
    [service({ publicOrigin: 'file:///invalid' }), transaction(), 'notification_configuration_invalid'],
    [service(), transaction({ users: [] }), 'no_verified_recipients']]) {
    const prepared = await notifications.prepare(tx, base, { ...base, materialName: 'changed' });
    assert.equal(prepared.plan.update.reason, reason);
    assert.equal(outbox(tx).length, 0);
  }
});

test('all update batches are deterministic and inserted under saved version without audience truncation', async () => {
  const users = Array.from({ length: 65 }, (_, i) => ({ ...user, id: `id${i}`, email: `u${i}@example.test`,
    mailProfile: { id: user.mailDirectoryId, email: `u${i}@example.test` } }));
  const tx = transaction({ users });
  const notifications = service();
  const prepared = await notifications.prepare(tx, base, { ...base, materialName: 'changed' });
  assert.equal(prepared.plan.update.jobCount, 3);
  const result = await notifications.persisted(tx, { ...prepared.record, version: '0000000000000002' }, prepared.plan);
  assert.equal(result.update.jobCount, 3);
  assert.equal(outbox(tx).flatMap(call => call.inputs.to.split('; ')).length, 65);
  assert(outbox(tx).every(call => call.inputs.to.length <= 1000));
  assert(outbox(tx).every((call, index) => call.inputs.eventKey === `${base.id}:0000000000000002:update:${index}`));
});

test('worker revalidates current access and exact email identity before claiming update; sends only four fields', async () => {
  const payload = { to: user.email, subject: 'PCN updated', message: 'safe', senderName: 'PCN', notificationKind: 'pcn_update',
    updateSnapshot: { pcnId: base.id, recipients: [{ userId: user.id, email: user.email, directoryId: user.mailDirectoryId }] } };
  for (const [users, current, expected] of [[[user], base, 'sent'], [[{ ...user, isActive: false }], base, 'cancelled'],
    [[{ ...user, roles: ['supplier'] }], base, 'cancelled'], [[user], null, 'cancelled'],
    [[{ ...user, mailDirectoryId: 'new' }], base, 'cancelled']]) {
    const tx = transaction({ users, current, payload });
    let delivered;
    const worker = new NotificationWorker({ transaction: () => tx, request: () => tx.request() }, { integrationService: { sendMail: async mail => {
      assert.equal(tx.calls.at(-1), 'commit'); delivered = mail;
    } } });
    assert.equal((await worker.runOnce()).status, expected);
    if (expected === 'sent') assert.deepEqual(delivered, { to: user.email, subject: payload.subject, message: 'safe', senderName: 'PCN' });
    else assert.equal(delivered, undefined);
    assert(tx.calls.some(call => call.query?.includes('DeletedAt IS NULL')));
  }
});

test('worker sends valid snapshot recipients while dropping revoked contacts and excluding new audience', async () => {
  const revoked = { ...user, id: 'revoked', email: 'revoked@example.test',
    mailProfile: { id: user.mailDirectoryId, email: 'revoked@example.test' } };
  const added = { ...user, id: 'new-user', email: 'new@example.test', mailProfile: { id: user.mailDirectoryId, email: 'new@example.test' } };
  const payload = { to: `${user.email}; ${revoked.email}`, subject: 'PCN updated', message: 'safe', senderName: 'PCN',
    notificationKind: 'pcn_update', updateSnapshot: { pcnId: base.id, recipients: [user, revoked].map(entry => ({
      userId: entry.id, email: entry.email, directoryId: entry.mailDirectoryId
    })) } };
  const tx = transaction({ users: [user, { ...revoked, isActive: false }, added], current: base, payload });
  let delivered;
  const worker = new NotificationWorker({ transaction: () => tx, request: () => tx.request() }, {
    integrationService: { sendMail: async mail => { delivered = mail; } }
  });
  assert.equal((await worker.runOnce()).status, 'sent');
  assert.deepEqual(delivered, { to: user.email, subject: payload.subject, message: payload.message, senderName: payload.senderName });
});

class SavedRepository extends SqlPcnRepository {
  async readParent() { return { PcnId: 1, RowVersion: Buffer.from(base.version, 'hex') }; }
  async readAggregate(tx) { return tx.saved || base; }
  async writeParent(tx, entry) { tx.saved = { ...entry, version: '0000000000000002' }; return { PcnId: 1 }; }
  async writeChildren() {}
  async audit() {}
}
test('failure on later general batch rolls back PCN and preceding action/update inserts', async () => {
  const users = Array.from({ length: 35 }, (_, i) => ({ ...user, id: `id${i}`, email: `u${i}@example.test`,
    mailProfile: { id: user.mailDirectoryId, email: `u${i}@example.test` } }));
  const tx = transaction({ users, failAt: 3, settings: { schemaVersion: 2, groups: [
    { key: 'department.gscTet.checked', emails: 'actor@example.test', recipients: [] }
  ] } });
  const repository = new SavedRepository({ transaction: () => tx }, { notifications: service() });
  await assert.rejects(repository.update(base.id, current => ({ ...current, internalReview: { signoff: { gscTet: { approved: true } } } }), 'reviewer', base.version), /outbox insert failed/);
  assert.equal(outbox(tx).length, 3);
  assert.equal(tx.calls.at(-1), 'rollback');
  assert(!tx.calls.includes('commit'));
});
