const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationService } = require('../src/notificationService');
const { NotificationWorker } = require('../src/notificationWorker');
const { ReviewDeadlineNotifications } = require('../src/reviewDeadlineNotifications');

const kinds = ['submitted', 'actionRequired', 'updated', 'completed', 'dueSoon', 'overdue'];
const defaults = () => ({ schemaVersion: 1, rules: Object.fromEntries(kinds.map(key => [key,
  { enabled: true, includeDefaultRecipients: true, groupKeys: [], userIds: [], excludedUserIds: [] }])) });
const user = (index = 1, changes = {}) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  employeeCode: String(index).padStart(7, '0'), identityProvider: 'employee-code', isActive: true,
  roles: ['gsc'], department: 'gscTet', signingStep: 'prepared', email: `u${index}@example.test`,
  mailDirectoryId: `directory-${index}`, mailVerifiedAt: '2026-11-20T00:00:00.000Z',
  mailProfile: { id: `directory-${index}`, email: `u${index}@example.test` }, ...changes });
const record = () => ({ id: 'T-20112601', documentType: 'ta', ownerUserId: user().id, version: '0000000000000001',
  status: 'submitted', riskLevel: 'RL0', supplierName: 'Synthetic', materialName: 'Copper',
  mailRoutingPolicyVersion: 2, mailRoutingState: { signingOrderVersion: 2 }, internalReview: {} });
function harness({ preferences = defaults(), users = [user()], value = record() } = {}) {
  const state = { settings: { schemaVersion: 2, groups: [{ key: 'department.gscTet.prepared', emails: 'manual@example.test' }],
    notificationPreferences: preferences }, users, record: value, jobs: [], calls: [], time: new Date('2026-11-22T00:00:00.000Z') };
  const sqlUser = u => ({ Id: u.id, EmployeeCode: u.employeeCode, IsActive: u.isActive, IdentityProvider: u.identityProvider,
    DepartmentKey: u.department, SigningStep: u.signingStep, Email: u.email, MailDirectoryId: u.mailDirectoryId,
    MailVerifiedAt: u.mailVerifiedAt, MailProfileJson: JSON.stringify(u.mailProfile), RoleName: u.roles[0] });
  const sqlRecord = () => state.record ? { PcnCode: state.record.id, OwnerUserId: state.record.ownerUserId,
    RowVersion: Buffer.from(state.record.version, 'hex'), Status: state.record.status, RiskLevel: state.record.riskLevel,
    SupplierName: state.record.supplierName, MaterialName: state.record.materialName,
    LegacyExtrasJson: JSON.stringify(state.record), ReviewJson: JSON.stringify(state.record.internalReview) } : null;
  function request() {
    const inputs = {};
    return { input(key, type, value) { inputs[key] = value; return this; }, async query(query) {
      state.calls.push({ query, inputs });
      if (query.includes('sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
      if (query.includes('SELECT SettingsJson')) return { recordset: [{ SettingsJson: JSON.stringify(state.settings) }] };
      if (query.includes('FROM pcn.Users')) return { recordset: state.users.map(sqlUser) };
      if (query.includes('FROM pcn.PcnRequests')) return { recordset: sqlRecord() ? [sqlRecord()] : [] };
      if (query.includes('INSERT pcn.NotificationJobs')) {
        const existing = state.jobs.find(job => job.EventKey === inputs.eventKey);
        const job = existing || { Id: inputs.id, PcnId: inputs.pcnId, PcnVersion: inputs.version,
          CompletedGroup: inputs.completedGroup, Action: inputs.action, EventKey: inputs.eventKey,
          PayloadJson: inputs.payload, Status: 'pending', Attempts: 0 };
        if (!existing) state.jobs.push(job);
        return { recordset: [job] };
      }
      if (query.includes('SELECT TOP(1)')) return { recordset: state.jobs.filter(job => job.Status === 'pending').slice(0, 1) };
      if (query.includes('SELECT') && query.includes('FROM pcn.NotificationJobs')) {
        return { recordset: state.jobs.filter(job => job.EventKey === inputs.eventKey || job.EventKey.startsWith(`${inputs.eventKey}:batch:`)) };
      }
      if (query.includes("SET Status=N'cancelled'")) {
        const job = state.jobs.find(job => job.Id === inputs.id); if (job) job.Status = 'cancelled';
      }
      if (query.includes("SET Status=N'sending',Attempts")) {
        const job = state.jobs.find(job => job.Id === inputs.id); if (job) job.Status = 'sending';
      }
      if (query.includes("SET Status=N'pending'")) {
        const job = state.jobs.find(job => job.EventKey === inputs.eventKey && job.Status === 'cancelled' && !job.Attempts
          && !job.SentAt && job.LastError === 'Workflow target or assigned recipients changed before sending');
        if (job) { job.Status = 'pending'; job.PayloadJson = inputs.payload; }
      }
      return { recordset: [] };
    } };
  }
  const pool = { request, transaction: () => ({ request, async begin() {}, async commit() {}, async rollback() {} }) };
  const service = new NotificationService(pool, { mailUrl: 'https://mail.example.test', publicOrigin: 'https://pcn.example.test' });
  const scheduler = new ReviewDeadlineNotifications(pool, { notificationService: service, clock: () => state.time,
    workflowSettings: { async get() { return { schemaVersion: 1, version: 0,
      pendingDays: { gscTet: 3, prodEngTet: 3, prodEngTa: 3, prodEngSc: 3, qaTet: 3, gscTapbu: null, qaTapbu: null, qaFinal: null } }; } } });
  return { state, pool, service, scheduler, tx: pool.transaction(), worker: new NotificationWorker(pool,
    { reviewDeadlineNotifications: scheduler, clock: () => state.time }) };
}

test('submission, update and completion preferences independently suppress their FYI stream', async () => {
  for (const [kind, before, after] of [['submitted', null, record()], ['updated', record(), { ...record(), materialName: 'Changed' }],
    ['completed', record(), { ...record(), status: 'closed' }]]) {
    const preferences = defaults(); preferences.rules[kind].enabled = false;
    const h = harness({ preferences });
    const prepared = await h.service.prepare(h.tx, before, after);
    assert.equal(prepared.plan.update.queued, false, kind);
    assert.equal(prepared.plan.update.reason, 'notification_disabled');
  }
});

test('custom action subscriptions batch all selected users and exclude their union from FYI mail', async () => {
  const users = Array.from({ length: 65 }, (_, index) => user(index + 1));
  const preferences = defaults();
  preferences.rules.actionRequired = { enabled: true, includeDefaultRecipients: false,
    groupKeys: ['department.gscTet.any'], userIds: [], excludedUserIds: [users[0].id] };
  const h = harness({ preferences, users });
  const prepared = await h.service.prepare(h.tx, null, record());
  assert.equal(prepared.plan.batches.length, 3);
  assert.equal(prepared.plan.batches.flatMap(payload => payload.to.split('; ')).length, 64);
  assert.equal(prepared.plan.update.batches[0].to, users[0].email);
  const saved = { ...prepared.record, version: record().version };
  await h.service.persisted(h.tx, saved, prepared.plan);
  const action = h.state.jobs.filter(job => job.Action === 'prepared');
  assert.equal(action.length, 3);
  assert.equal(action[0].EventKey, `${saved.id}:${saved.mailRoutingState.activationId}:handoff`);
  assert.equal(action[1].EventKey, `${action[0].EventKey}:batch:1`);
  assert(action.every(job => JSON.parse(job.PayloadJson).to.length <= 1000));
});

test('pending action policy is checked again, and newly selected users never join an existing batch', async () => {
  const preferences = defaults(); preferences.rules.actionRequired.includeDefaultRecipients = false;
  preferences.rules.actionRequired.userIds = [user(1).id];
  const h = harness({ preferences, users: [user(1), user(2)] });
  const prepared = await h.service.prepare(h.tx, null, record());
  h.state.record = prepared.record;
  await h.service.persistAction(h.tx, prepared.record, prepared.plan);
  h.state.settings.notificationPreferences.rules.actionRequired.userIds = [user(2).id];
  const claimed = await h.worker.claim('00000000-0000-4000-8000-000000000099');
  assert.equal(claimed.cancelled, true);
  assert.equal(claimed.payload.to || '', '');
});

test('disabled due-soon preferences stop deadline queueing and disabled overdue preferences stop pending claims', async () => {
  const value = { ...record(), status: 'gsc_review', reviewTiming: { gscTet: { startedAt: '2026-11-20T00:00:00.000Z' } } };
  const h = harness({ value });
  h.state.settings.notificationPreferences.rules.dueSoon.enabled = false;
  assert.equal(await h.scheduler.queueRecord(value.id, h.state.time), false);
  assert.equal(h.state.jobs.length, 0);
  h.state.time = new Date('2026-11-23T00:00:00.001Z');
  assert.equal(await h.scheduler.queueRecord(value.id, h.state.time), true);
  h.state.settings.notificationPreferences.rules.overdue.enabled = false;
  assert.equal((await h.worker.claim('00000000-0000-4000-8000-000000000099')).cancelled, true);
});

test('new tagged FYI jobs retain their exact event identity and send their saved custom audience', async () => {
  const preferences = defaults();
  preferences.rules.updated = { enabled: true, includeDefaultRecipients: false,
    groupKeys: [], userIds: [user().id], excludedUserIds: [] };
  const h = harness({ preferences });
  const changed = { ...record(), materialName: 'Changed' };
  const prepared = await h.service.prepare(h.tx, record(), changed);
  h.state.record = prepared.record;
  await h.service.persisted(h.tx, prepared.record, prepared.plan);
  assert.equal(h.state.jobs.length, 1);
  assert.equal(JSON.parse(h.state.jobs[0].PayloadJson).notificationPreferenceSnapshot.type, 'updated');
  const claimed = await h.worker.claim('00000000-0000-4000-8000-000000000099');
  assert.equal(claimed.cancelled, false);
  assert.equal(claimed.payload.to, user().email);
});

test('explicit custom deadline recipients work without upgrading legacy or missing Mail Routing', async () => {
  for (const routing of [{}, { schemaVersion: 1, groups: [{ key: 'signoff.gscTet', emails: 'legacy@example.test' }] }]) {
    const h = harness({ value: { ...record(), status: 'gsc_review',
      reviewTiming: { gscTet: { startedAt: '2026-11-20T00:00:00.000Z' } } } });
    const preferences = defaults(); preferences.rules.dueSoon.userIds = [user().id];
    h.state.settings = { ...routing, notificationPreferences: preferences };
    assert.equal(await h.scheduler.queueRecord(h.state.record.id, h.state.time), true);
    assert.equal(JSON.parse(h.state.jobs[0].PayloadJson).to, user().email);
    const claimed = await h.worker.claim('00000000-0000-4000-8000-000000000099');
    assert.equal(claimed.cancelled, false);
    assert.equal(claimed.payload.to, user().email);
  }
});

test('typed custom action and submission subscriptions work with a legacy or missing routing schema', async () => {
  for (const routing of [{}, { schemaVersion: 1, groups: [{ key: 'signoff.gscTet', emails: 'legacy@example.test' }] }]) {
    const preferences = defaults(); preferences.rules.actionRequired.userIds = [user().id];
    preferences.rules.submitted = { enabled: true, includeDefaultRecipients: false, groupKeys: [],
      userIds: [user(2).id], excludedUserIds: [] };
    const h = harness({ preferences, users: [user(), user(2), user(3)] });
    h.state.settings = { ...routing, notificationPreferences: preferences };
    const prepared = await h.service.prepare(h.tx, null, record()); h.state.record = prepared.record;
    assert.equal(prepared.plan.queued, true); assert.equal(prepared.plan.payload.to, user().email);
    assert.equal(prepared.plan.update.batches[0].to, user(2).email);
    await h.service.persisted(h.tx, prepared.record, prepared.plan);
    const claim = await h.worker.claim('00000000-0000-4000-8000-000000000099');
    assert.equal(claim.cancelled, false); assert.equal(claim.payload.to, user().email);
  }
});

test('action batches claim only their own snapshot and reject a noncanonical batch suffix', async () => {
  const preferences = defaults();
  preferences.rules.actionRequired = { enabled: true, includeDefaultRecipients: false,
    groupKeys: ['department.gscTet.any'], userIds: [], excludedUserIds: [] };
  const h = harness({ preferences, users: Array.from({ length: 65 }, (_, index) => user(index + 1)) });
  const prepared = await h.service.prepare(h.tx, null, record()); h.state.record = prepared.record;
  await h.service.persistAction(h.tx, prepared.record, prepared.plan);
  assert.equal(h.state.jobs.length, 3);
  const first = await h.worker.claim('00000000-0000-4000-8000-000000000099');
  assert.equal(first.cancelled, false); assert.equal(first.payload.to.split('; ').length, 30);
  h.state.jobs[1].EventKey = h.state.jobs[1].EventKey.replace(':batch:1', ':batch:01');
  assert.equal((await h.worker.claim('00000000-0000-4000-8000-000000000099')).cancelled, true);
  const last = await h.worker.claim('00000000-0000-4000-8000-000000000099');
  assert.equal(last.cancelled, false); assert.equal(last.payload.to.split('; ').length, 5);
  assert(!last.payload.to.split('; ').some(email => first.payload.to.split('; ').includes(email)));
});

test('deadline batches stay frozen across rescans, subscriber ordering changes and sent history', async () => {
  const preferences = defaults();
  preferences.rules.dueSoon = { enabled: true, includeDefaultRecipients: false,
    groupKeys: ['department.gscTet.any'], userIds: [], excludedUserIds: [] };
  const h = harness({ preferences, users: Array.from({ length: 65 }, (_, index) => user(index + 1)),
    value: { ...record(), status: 'gsc_review', reviewTiming: { gscTet: { startedAt: '2026-11-20T00:00:00.000Z' } } } });
  await h.scheduler.queueRecord(h.state.record.id, h.state.time);
  assert.equal(h.state.jobs.length, 3);
  const frozen = h.state.jobs.map(job => job.PayloadJson);
  h.state.users = [...h.state.users.slice(1).reverse(), user(100)];
  await h.scheduler.queueRecord(h.state.record.id, h.state.time);
  assert.deepEqual(h.state.jobs.map(job => job.PayloadJson), frozen);
  const delivered = [];
  for (let index = 0; index < 3; index++) {
    const claim = await h.worker.claim('00000000-0000-4000-8000-000000000099');
    assert.equal(claim.cancelled, false); delivered.push(...claim.payload.to.split('; '));
  }
  assert.equal(delivered.length, 64); assert(!delivered.includes(user(100).email)); assert(!delivered.includes(user().email));
  h.state.jobs = h.state.jobs.map(job => ({ ...job, Status: 'sent' }));
  await h.scheduler.queueRecord(h.state.record.id, h.state.time);
  assert.equal(h.state.jobs.length, 3); assert(h.state.jobs.every(job => job.Status === 'sent'));
  const lookup = h.state.calls.find(call => call.query.includes('SELECT EventKey,PayloadJson,Status'));
  assert.match(lookup.query, /LIKE @batchPrefix ESCAPE N'~'/);
  assert.match(lookup.inputs.batchPrefix, /due~_soon:batch:%$/);
});

test('restoring an unsent deadline cannot replace old subscribers with a newly selected user', async () => {
  const preferences = defaults();
  preferences.rules.dueSoon = { enabled: true, includeDefaultRecipients: false, groupKeys: [], userIds: [user().id], excludedUserIds: [] };
  const h = harness({ preferences, users: [user(), user(2)], value: { ...record(), status: 'gsc_review',
    reviewTiming: { gscTet: { startedAt: '2026-11-20T00:00:00.000Z' } } } });
  await h.scheduler.queueRecord(h.state.record.id, h.state.time);
  const original = h.state.jobs[0].PayloadJson;
  Object.assign(h.state.jobs[0], { Status: 'cancelled', LastError: 'Workflow target or assigned recipients changed before sending' });
  h.state.settings.notificationPreferences.rules.dueSoon.userIds = [user(2).id];
  await h.scheduler.queueRecord(h.state.record.id, h.state.time);
  assert.equal(h.state.jobs.length, 1); assert.equal(h.state.jobs[0].Status, 'cancelled');
  assert.equal(h.state.jobs[0].PayloadJson, original);
});

test('legacy automatic action identity remains bound while still-configured manual recipients survive', async () => {
  const h = harness(); const prepared = await h.service.prepare(h.tx, null, record()); h.state.record = prepared.record;
  await h.service.persistAction(h.tx, prepared.record, prepared.plan);
  const payload = JSON.parse(h.state.jobs[0].PayloadJson); delete payload.notificationPreferenceSnapshot;
  h.state.jobs[0].PayloadJson = JSON.stringify(payload);
  h.state.users = [user(2, { email: user().email, mailProfile: { id: 'directory-2', email: user().email } })];
  const claim = await h.worker.claim('00000000-0000-4000-8000-000000000099');
  assert.equal(claim.cancelled, false); assert.equal(claim.payload.to, 'manual@example.test');
});

test('untagged legacy FYI requires all possible event policies and remains bound to its job PCN', async () => {
  for (const mismatch of [false, true]) {
    const h = harness();
    if (!mismatch) h.state.settings.notificationPreferences.rules.completed.enabled = false;
    const payload = { to: user().email, subject: 'Legacy update', message: 'Synthetic', senderName: 'PCN', notificationKind: 'pcn_update',
      updateSnapshot: { pcnId: mismatch ? 'T-20112602' : record().id, audiencePolicyVersion: 1, departmentKeys: ['gscTet'],
        recipients: [{ userId: user().id, directoryId: user().mailDirectoryId, email: user().email }] } };
    h.state.jobs = [{ Id: 'job', PcnId: record().id, Action: 'pcn_update', PayloadJson: JSON.stringify(payload), Status: 'pending' }];
    assert.equal((await h.worker.claim('00000000-0000-4000-8000-000000000099')).cancelled, true);
  }
});

test('malformed type, batch membership and stored policy cancel action claims without sending', async () => {
  for (const mutate of [
    (payload, h) => { payload.notificationKind = 'unknown'; },
    payload => { payload.notificationPreferenceSnapshot.recipients = { email: 'manual@example.test' }; },
    payload => { payload.notificationPreferenceSnapshot.batchIndex = '0'; },
    (payload, h) => { h.state.settings.notificationPreferences.rules.actionRequired.enabled = 'true'; }
  ]) {
    const h = harness(); const prepared = await h.service.prepare(h.tx, null, record()); h.state.record = prepared.record;
    await h.service.persistAction(h.tx, prepared.record, prepared.plan);
    const payload = JSON.parse(h.state.jobs[0].PayloadJson); mutate(payload, h); h.state.jobs[0].PayloadJson = JSON.stringify(payload);
    assert.equal((await h.worker.claim('00000000-0000-4000-8000-000000000099')).cancelled, true);
  }
});

test('an individual exclusion continues to remove a matching manual email after the account becomes inactive', async () => {
  const preferences = defaults(); preferences.rules.actionRequired.excludedUserIds = [user().id];
  const h = harness({ preferences, users: [user(1, { isActive: false, mailVerifiedAt: null })] });
  h.state.settings.groups[0].emails = user().email;
  const prepared = await h.service.prepare(h.tx, null, record());
  assert.equal(prepared.plan.queued, false); assert.equal(prepared.plan.reason, 'recipient_not_configured');
});
