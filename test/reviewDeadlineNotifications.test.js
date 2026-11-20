const test = require('node:test');
const assert = require('node:assert/strict');
const { ReviewDeadlineNotifications } = require('../src/reviewDeadlineNotifications');
const { NotificationService } = require('../src/notificationService');
const { NotificationWorker } = require('../src/notificationWorker');

const start = '2026-10-20T03:00:00.000Z';
const due = '2026-10-23T03:00:00.000Z';
const soon = '2026-10-22T03:00:00.000Z';
const late = '2026-10-23T03:00:00.001Z';
const complete = { prepared: true, checked: true, approved: true };
function record(department = 'prodEngTet', changes = {}) {
  return { id: 'PCN-2026-0001', version: '0000000000000001', status: 'technical_review', riskLevel: 'RL0',
    supplierName: 'Example Supplier', materialName: 'Copper', mailRoutingPolicyVersion: 2,
    reviewTiming: { [department]: { startedAt: start } }, internalReview: {
      signoff: { gscTet: complete, ...(department === 'qaTet' ? { prodEngTet: complete } : {}) }
    }, ...changes };
}
function managed(department = 'prodEngTet', action = 'prepared', changes = {}) {
  const id = require('node:crypto').createHash('sha256').update(`${department}-${action}`).digest('hex').slice(0,32)
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  return { Id: id, EmployeeCode: '012345', IsActive: true, IdentityProvider: 'employee-code',
    DepartmentKey: department, SigningStep: action, Email: `${department}-${action}@example.test`,
    MailDirectoryId: 'directory-id', MailVerifiedAt: new Date(start),
    MailProfileJson: JSON.stringify({ id: 'directory-id', email: `${department}-${action}@example.test` }),
    RoleName: department === 'qaTet' ? 'qa' : 'productionengineering', ...changes };
}
function row(value) {
  return { PcnCode: value.id, RowVersion: Buffer.from(value.version, 'hex'), Status: value.status,
    RiskLevel: value.riskLevel, SupplierName: value.supplierName, MaterialName: value.materialName,
    LegacyExtrasJson: JSON.stringify(value), ReviewJson: JSON.stringify(value.internalReview || {}) };
}
function harness(options = {}) {
  const state = { records: options.records || [record()], users: options.users || [managed()], settings: options.settings || { schemaVersion: 2, groups: [] },
    workflowSettings: { schemaVersion: 1, version: 0, pendingDays: { gscTet: null, prodEngTet: 3, qaTet: 3, gscTapbu: null, qaTapbu: null, qaFinal: null } },
    jobs: [], calls: [], time: options.time || soon, failInsert: false, failRead: false };
  function request(transactional = false) {
    const inputs = {};
    return { input(name, type, value) { inputs[name] = value; return this; }, async query(query) {
      state.calls.push({ query, inputs, transactional });
      if (query.includes('sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
      if (query.includes('SELECT TOP(@pageSize)')) {
        if (state.failRead) throw new Error('Read unavailable');
        return { recordset: state.records.filter(value => value.id > inputs.after).sort((a, b) => a.id.localeCompare(b.id)).slice(0, inputs.pageSize).map(row) };
      }
      if (query.includes('FROM pcn.PcnRequests')) return { recordset: state.records.filter(value => value.id === inputs.code).map(row) };
      if (query.includes('SELECT SettingsJson')) return { recordset: [{ SettingsJson: JSON.stringify(state.settings) }] };
      if (query.includes('FROM pcn.Users')) return { recordset: state.users };
      if (query.includes('INSERT pcn.NotificationJobs')) {
        if (state.failInsert) throw new Error('Outbox write unavailable');
        const existing = state.jobs.find(job => job.EventKey === inputs.eventKey);
        const job = existing || { Id: inputs.id, EventKey: inputs.eventKey, PcnId: inputs.pcnId, Action: inputs.action,
          PayloadJson: inputs.payload, Status: 'pending' };
        if (!existing) state.jobs.push(job);
        return { recordset: [job] };
      }
      if (query.includes('SELECT TOP(1)')) return { recordset: state.jobs.filter(job => job.Status === 'pending').slice(0, 1) };
      if (query.includes('SELECT EventKey,PayloadJson,Status')) return { recordset: state.jobs.filter(job => job.EventKey === inputs.eventKey || job.EventKey.startsWith(`${inputs.eventKey}:batch:`)) };
      if (query.includes("SET Status=N'pending'")) {
        const job = state.jobs.find(job => job.EventKey === inputs.eventKey && job.Status === 'cancelled' && (job.Attempts || 0) === 0
          && job.LastError === 'Workflow target or assigned recipients changed before sending' && !job.SentAt);
        if (job) Object.assign(job, { Status: 'pending', LastError: null, PayloadJson: inputs.payload });
        return { recordset: [] };
      }
      if (query.includes("SET Status=N'cancelled'")) { Object.assign(state.jobs.find(job => job.Id === inputs.id), {
        Status: 'cancelled', LastError: 'Workflow target or assigned recipients changed before sending'
      }); return { recordset: [] }; }
      if (query.includes("SET Status=N'sending',Attempts")) { state.jobs.find(job => job.Id === inputs.id).Status = 'sending'; return { recordset: [] }; }
      if (query.includes('SET Status=@status')) { state.jobs.find(job => job.Id === inputs.id).Status = inputs.status; return { recordset: [] }; }
      throw new Error(`Unhandled query: ${query}`);
    } };
  }
  const pool = { request: () => request(), transaction() {
    return { async begin() { state.calls.push('begin'); }, async commit() { state.calls.push('commit'); },
      async rollback() { state.calls.push('rollback'); }, request: () => request(true) };
  } };
  const service = new NotificationService(pool, { publicOrigin: 'https://pcn.example.test', mailUrl: 'https://mail.example.test/send' });
  const scheduler = new ReviewDeadlineNotifications(pool, { notificationService: service, clock: () => new Date(state.time),
    workflowSettings: { async get() { return structuredClone(state.workflowSettings); } } });
  const claim = (job = state.jobs[0], payload = JSON.parse(job.PayloadJson)) => scheduler.prepareClaim(pool.transaction(), job, payload, new Date(state.time));
  return { state, pool, service, scheduler, claim };
}

test('both review departments queue only at due-soon and overdue boundaries without catch-up reminders', async () => {
  for (const department of ['prodEngTet', 'qaTet']) {
    for (const [time, kind] of [['2026-10-22T02:59:59.999Z', null], [soon, 'due_soon'], [due, 'due_soon'], [late, 'overdue']]) {
      const { state, scheduler } = harness({ records: [record(department)], users: [managed(department)], time });
      await scheduler.queueDue();
      assert.equal(state.jobs.length, kind ? 1 : 0, `${department}: ${time}`);
      if (kind) {
        const payload = JSON.parse(state.jobs[0].PayloadJson);
        assert.equal(payload.notificationKind, 'review_deadline');
        assert.equal(payload.deadlineSnapshot.kind, kind);
        assert.equal(payload.deadlineSnapshot.dueAt, due);
        assert.match(payload.message, new RegExp(department === 'qaTet' ? 'QA/TET' : 'Prod.Eng/TET'));
      }
    }
  }
});

test('typed PE reminders use independent schedules and revalidate only the matching team at claim', async () => {
  for (const [documentType, id, department, days] of [['ta', 'T-20102601', 'prodEngTa', 2], ['sc', 'S-20102601', 'prodEngSc', 5]]) {
    const value = record('prodEngTet', { id, documentType });
    const other = department === 'prodEngTa' ? 'prodEngSc' : 'prodEngTa';
    const time = new Date(Date.parse(start) + (days - 1) * 86400000).toISOString();
    const { state, scheduler, claim } = harness({ records: [value], users: [managed(department), managed(other), managed('prodEngTet')], time });
    state.workflowSettings = { ...state.workflowSettings, pendingDays: { ...state.workflowSettings.pendingDays, prodEngTa: 2, prodEngSc: 5 } };
    await scheduler.queueDue();
    assert.equal(state.jobs.length, 1);
    const payload = JSON.parse(state.jobs[0].PayloadJson);
    assert.equal(payload.to, `${department}-prepared@example.test`);
    assert.equal(payload.deadlineSnapshot.department, department);
    assert.equal(payload.deadlineSnapshot.dueAt, new Date(Date.parse(start) + days * 86400000).toISOString());
    assert.equal((await claim()).to, `${department}-prepared@example.test`);
    state.users = [managed(other), managed('prodEngTet')];
    assert.equal(await claim(), null, 'Revoking the matching team cannot substitute the other or legacy PE group');
  }
});

test('repeated and concurrent scans deduplicate by stage episode and kind independently of PCN version or partial signatures', async () => {
  const { state, scheduler } = harness();
  await Promise.all([scheduler.queueDue(), scheduler.queueDue()]);
  assert.equal(state.jobs.length, 1);
  const event = state.jobs[0].EventKey;
  assert.equal(event, `${state.records[0].id}:review:prodEngTet:${start}:due_soon`);
  state.records = [record('prodEngTet', { version: '0000000000000002', internalReview: { signoff: { gscTet: complete, prodEngTet: { prepared: true } } } })];
  state.users = [managed('prodEngTet', 'checked')];
  await scheduler.queueDue();
  assert.equal(state.jobs.length, 1);
  state.time = late;
  await scheduler.queueDue();
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs[1].Action, 'overdue');
  assert(state.calls.filter(call => call.query?.includes('INSERT pcn.NotificationJobs')).every(call => /UPDLOCK, HOLDLOCK/.test(call.query)));
});

test('claim cancels when the signing role changed instead of adding its newly assigned recipients', async () => {
  const { state, scheduler, claim } = harness({ settings: { schemaVersion: 2, groups: [{ key: 'department.prodEngTet.prepared', emails: 'old-manual@example.test' }] } });
  await scheduler.queueDue();
  state.records = [record('prodEngTet', { version: '0000000000000009', internalReview: { signoff: { gscTet: complete, prodEngTet: { prepared: true } } } })];
  state.settings = { schemaVersion: 2, groups: [{ key: 'department.prodEngTet.checked', emails: 'new-manual@example.test' }] };
  state.users = [managed('prodEngTet', 'checked')];
  assert.equal(await claim(), null);
});

test('changed limits cancel old claims and allow replacement notices without resetting the stage start', async () => {
  const context = harness();
  await context.scheduler.queueDue();
  const old = context.state.jobs[0];
  context.state.workflowSettings.pendingDays.prodEngTet = 5;
  assert.equal(await context.claim(old), null);
  await context.scheduler.queueDue();
  assert.equal(context.state.jobs.length, 1, 'Extending a limit stops the old reminder');
  context.state.time = '2026-10-24T03:00:00.000Z';
  await context.scheduler.queueDue();
  assert.equal(context.state.jobs.length, 2);
  const replacement = context.state.jobs[1];
  assert.notEqual(replacement.EventKey, old.EventKey);
  const snapshot = JSON.parse(replacement.PayloadJson).deadlineSnapshot;
  assert.equal(snapshot.stageKey, 'signoff.prodEngTet');
  assert.equal(snapshot.startedAt, start);
  assert.equal(snapshot.dueAt, '2026-10-25T03:00:00.000Z');
  assert.ok(await context.claim(replacement));
  context.state.workflowSettings.pendingDays.prodEngTet = null;
  assert.equal(await context.claim(replacement), null);
});

test('original three-day pending and delivered notice identities remain compatible after the settings upgrade', async () => {
  const context = harness();
  await context.scheduler.queueDue();
  const job = context.state.jobs[0];
  const payload = JSON.parse(job.PayloadJson);
  delete payload.deadlineSnapshot.stageKey;
  assert.ok(await context.claim(job, payload), 'Existing pending notice is valid when the original deadline is unchanged');
  job.Status = 'sent';
  await context.scheduler.queueDue();
  assert.equal(context.state.jobs.length, 1, 'Already sent notices do not repeat after upgrading the settings tool');
});

test('reenabling an unchanged deadline restores only automatically cancelled notices that were never attempted', async () => {
  const context = harness();
  const deliveries = [];
  const worker = new NotificationWorker(context.pool, { reviewDeadlineNotifications: context.scheduler,
    integrationService: { async sendMail(mail) { deliveries.push(mail); } }, clock: () => new Date(context.state.time) });
  await context.scheduler.queueDue();
  context.state.workflowSettings.pendingDays.prodEngTet = null;
  assert.equal((await worker.runOnce()).status, 'cancelled');
  assert.equal(context.state.jobs[0].Status, 'cancelled');
  context.state.workflowSettings.pendingDays.prodEngTet = 3;
  await context.scheduler.queueDue();
  assert.equal(context.state.jobs.length, 1);
  assert.equal(context.state.jobs[0].Status, 'pending');
  assert.equal((await worker.runOnce()).status, 'sent');
  assert.equal(deliveries.length, 1);
  for (const blocked of [
    { Status: 'sent' }, { Status: 'uncertain' }, { Status: 'sending' },
    { Status: 'cancelled', Attempts: 1 }, { Status: 'cancelled', Attempts: 0, LastError: 'Manually cancelled' },
    { Status: 'cancelled', Attempts: 0, SentAt: start }
  ]) {
    const other = harness();
    await other.scheduler.queueDue();
    Object.assign(other.state.jobs[0], { LastError: 'Workflow target or assigned recipients changed before sending' }, blocked);
    await other.scheduler.queueDue();
    assert.equal(other.state.jobs[0].Status, blocked.Status);
  }
});

test('TaPBU and final QA notices use their exact current signing stage and configured deadline', async () => {
  const variants = [
    ['gscTet', 'signoff.gscTet', {}, { gscTet: {} }],
    ['gscTapbu', 'tapbu.gsc', { need: true }, { gscTet: complete, prodEngTet: complete, qaTet: complete }],
    ['qaTapbu', 'tapbu.qa', { need: true, gsc: complete }, { gscTet: complete, prodEngTet: complete, qaTet: complete }],
    ['qaFinal', 'qateFinal.signoff', { noNeed: true }, { gscTet: complete, prodEngTet: complete, qaTet: complete }]
  ];
  for (const [key, stageKey, tapbu, signoff] of variants) {
    const department = key === 'qaFinal' ? 'qaTet' : key;
    const context = harness({ records: [record('prodEngTet', {
      riskLevel: 'RL2', reviewTiming: { [key]: { startedAt: start } }, internalReview: { signoff, tapbu }
    })], users: [], settings: { schemaVersion: 2, groups: [{ key: `department.${department}.prepared`, emails: 'reviewer@example.test' }] } });
    context.state.workflowSettings.pendingDays[key] = 2;
    context.state.time = '2026-10-22T03:00:00.001Z';
    await context.scheduler.queueDue();
    assert.equal(context.state.jobs.length, 1, stageKey);
    const job = context.state.jobs[0];
    assert.equal(JSON.parse(job.PayloadJson).deadlineSnapshot.stageKey, stageKey);
    assert.ok(await context.claim(job));
  }
});

test('claim cancels deleted, completed, reset, unknown and changed-phase stage episodes', async () => {
  const mutations = [
    state => { state.records = []; },
    state => { state.records = [record('prodEngTet', { status: 'approved' })]; },
    state => { state.records = [record('prodEngTet', { internalReview: { signoff: { gscTet: complete, prodEngTet: complete } } })]; },
    state => { state.records = [record('prodEngTet', { reviewTiming: {} })]; },
    state => { state.records = [record('prodEngTet', { reviewTiming: { prodEngTet: { startedAt: '2026-10-21T03:00:00.000Z' } } })]; },
    state => { state.records = [record('prodEngTet', { reviewTiming: { prodEngTet: { startedAt: '2026-02-30T00:00:00.000Z' } } })]; },
    state => { state.records = [record('prodEngTet', { reviewTiming: { prodEngTet: { startedAt: '2026-10-25T00:00:00.000Z' } } })]; },
    state => { state.time = late; },
    state => { state.settings = { schemaVersion: 1, groups: [] }; },
    state => { state.records = [record('prodEngTet', { mailRoutingPolicyVersion: 1 })]; }
  ];
  for (const mutate of mutations) {
    const context = harness();
    await context.scheduler.queueDue();
    mutate(context.state);
    assert.equal(await context.claim(), null);
  }
});

test('claim cancels removed manual recipients, revoked or unverified managed signers and disabled mail', async () => {
  for (const users of [[], [managed('prodEngTet', 'prepared', { IsActive: false })], [managed('prodEngTet', 'prepared', { MailVerifiedAt: null })],
    [managed('prodEngTet', 'prepared', { MailProfileJson: JSON.stringify({ id: 'wrong', email: 'other@example.test' }) })]]) {
    const context = harness({ settings: { schemaVersion: 2, groups: [{ key: 'department.prodEngTet.prepared', emails: 'manual@example.test' }] } });
    await context.scheduler.queueDue();
    context.state.settings = { schemaVersion: 2, groups: [] };
    context.state.users = users;
    assert.equal(await context.claim(), null);
  }
  const context = harness();
  await context.scheduler.queueDue();
  context.service.mailUrl = '';
  assert.equal(await context.claim(), null);
});

test('queue skips missing timing, no current recipient and invalid notification configuration', async () => {
  for (const context of [harness({ records: [record('prodEngTet', { reviewTiming: {} })] }), harness({ users: [] }),
    harness({ settings: { schemaVersion: 2, groups: [{ key: 'department.prodEngTet.prepared', emails: 'invalid' }] } })]) {
    await context.scheduler.queueDue();
    assert.equal(context.state.jobs.length, 0);
  }
  const context = harness();
  context.service.mailUrl = '';
  await context.scheduler.queueDue();
  assert.equal(context.state.jobs.length, 0);
});

test('scheduler follows routing, PCN, outbox lock order and rolls back database failures', async () => {
  const { state, scheduler } = harness();
  await scheduler.queueDue();
  const lock = state.calls.findIndex(call => call.query?.includes('sp_getapplock'));
  const pcn = state.calls.findIndex(call => call.transactional && call.query?.includes('FROM pcn.PcnRequests'));
  const outbox = state.calls.findIndex(call => call.query?.includes('INSERT pcn.NotificationJobs'));
  assert(lock < pcn && pcn < outbox);
  assert.equal(state.calls[lock].inputs.mode, 'Shared');
  const failed = harness();
  failed.state.failInsert = true;
  await assert.rejects(failed.scheduler.queueDue(), /Outbox write unavailable/);
  assert.equal(failed.state.calls.at(-1), 'rollback');
});

test('bounded keyset pages progress beyond already notified rows and wrap for future sweeps', async () => {
  const records = Array.from({ length: 1005 }, (_, index) => record('prodEngTet', {
    id: `PCN-2026-${String(index + 1).padStart(4, '0')}`, reviewTiming: index === 1004 ? { prodEngTet: { startedAt: start } } : {}
  }));
  const { state, scheduler } = harness({ records });
  const first = await scheduler.queueDue();
  assert.equal(first.scanned, 1000);
  assert.equal(state.jobs.length, 0);
  await scheduler.queueDue();
  assert.equal(state.jobs.length, 1);
  await scheduler.queueDue();
  const scans = state.calls.filter(call => call.query?.includes('SELECT TOP(@pageSize)'));
  assert.equal(scans[10].inputs.after, 'PCN-2026-1000');
  assert.equal(scans[11].inputs.after, '');
  assert(scans.every(call => call.inputs.pageSize === 100 && !call.transactional));
});

test('claim rejects forged identity, event key, episode and kind while preserving TESTING DOC marking', async () => {
  const { state, scheduler, claim } = harness({ records: [record('qaTet', { isTestDocument: true })], users: [managed('qaTet')] });
  await scheduler.queueDue();
  const job = state.jobs[0];
  const saved = JSON.parse(job.PayloadJson);
  const mail = await claim();
  assert.match(mail.subject, /^\[TESTING DOC\]/);
  assert.match(mail.message, /TESTING DOC/);
  assert.equal(await claim({ ...job, EventKey: 'wrong' }, saved), null);
  assert.equal(await claim({ ...job, Action: 'overdue' }, saved), null);
  assert.equal(await claim(job, { ...saved, deadlineSnapshot: { ...saved.deadlineSnapshot, pcnId: 'PCN-2026-9999' } }), null);
  assert.equal(await claim(job, { ...saved, deadlineSnapshot: { ...saved.deadlineSnapshot, startedAt: soon } }), null);
});

test('worker cancels deadline jobs without a scheduler and sends only rebuilt mail after committed claim', async () => {
  for (const injected of [false, true]) {
    const { state, pool, scheduler } = harness();
    await scheduler.queueDue();
    let deliveries = 0;
    const worker = new NotificationWorker(pool, { clock: () => new Date(state.time),
      ...(injected ? { reviewDeadlineNotifications: scheduler } : {}), integrationService: { async sendMail(mail) {
        deliveries++;
        assert.equal(state.calls.at(-1), 'commit');
        assert.deepEqual(Object.keys(mail).sort(), ['message', 'senderName', 'subject', 'to']);
      } } });
    assert.equal((await worker.runOnce()).status, injected ? 'sent' : 'cancelled');
    assert.equal(deliveries, injected ? 1 : 0);
  }
});

test('worker marks ambiguous deadline delivery uncertain and scheduler never duplicates that episode', async () => {
  const { state, pool, scheduler } = harness();
  await scheduler.queueDue();
  const worker = new NotificationWorker(pool, { reviewDeadlineNotifications: scheduler, clock: () => new Date(state.time),
    integrationService: { async sendMail() { throw new Error('Timeout'); } } });
  assert.equal((await worker.runOnce()).status, 'uncertain');
  await scheduler.queueDue();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].Status, 'uncertain');
  assert.equal((await worker.runOnce()).status, 'idle');
});
