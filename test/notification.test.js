const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationService } = require('../src/notificationService');
const { NotificationWorker } = require('../src/notificationWorker');

test('worker health aggregates queue totals without reading payloads or invoking mail', async () => {
  let calls = 0;
  const date = new Date('2026-10-06T01:02:03.000Z');
  const pool = mockPool([{ recordset: [{ pending: 10001, sending: 2, accepted: 3, uncertain: 4, latestAcceptedAt: date,
    LastError: 'private-health-test', PayloadJson: '{"to":"private@example.com"}' }] }]);
  const worker = new NotificationWorker(pool, { integrationService: { sendMail: async () => { calls++; } } });
  assert.deepEqual(await worker.health(), { worker: { lastCheckedAt: null, lastOutcome: null },
    queue: { pending: 10001, sending: 2, accepted: 3, uncertain: 4, latestAcceptedAt: date.toISOString() } });
  assert.equal(calls, 0);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /SUM\(CASE WHEN Status=N'pending'/);
  assert.match(pool.calls[0].sql, /Status=N'sent'/);
  assert.match(pool.calls[0].sql, /MAX\(CASE WHEN Status=N'sent' THEN SentAt/);
  assert.doesNotMatch(pool.calls[0].sql, /PayloadJson|LastError|TOP\(/);
});

test('worker health reports empty queue and tracks only safe idle, accepted, uncertain and error outcomes', async () => {
  const lastCheckedAt = '2026-10-06T04:05:06.000Z';
  for (const outcome of ['idle', 'accepted', 'uncertain', 'error']) {
    const results = outcome === 'idle' ? [] : [{ recordset: [{ Id: 'private-job', PayloadJson: '{}' }] }];
    const pool = mockPool(results);
    const worker = new NotificationWorker(pool, { clock: () => new Date(lastCheckedAt),
      integrationService: { sendMail: async () => { if (outcome === 'uncertain') throw new Error('sig=private-health-test'); } } });
    if (outcome === 'error') {
      pool.transaction = () => { throw new Error('DB private-health-test'); };
      await assert.rejects(worker.runOnce(), /private-health-test/);
      pool.request = mockPool().request;
    } else await worker.runOnce();
    assert.deepEqual(await worker.health(), { worker: { lastCheckedAt, lastOutcome: outcome },
      queue: { pending: 0, sending: 0, accepted: 0, uncertain: 0, latestAcceptedAt: null } });
  }
});

test('worker completion write failure remains an error instead of claiming acceptance', async () => {
  const pool = mockPool([{ recordset: [{ Id: 'private-job', PayloadJson: '{}' }] }]);
  const request = pool.request;
  pool.request = () => {
    const value = request();
    const query = value.query;
    value.query = async sqlText => { if (sqlText.includes('SET Status=@status')) throw new Error('DB private-health-test'); return query(sqlText); };
    return value;
  };
  const worker = new NotificationWorker(pool, { integrationService: { sendMail: async () => {} } });
  await assert.rejects(worker.runOnce(), /private-health-test/);
  assert.equal((await worker.health()).worker.lastOutcome, 'error');
});

function mockPool(results = [], settings = {}) {
  const calls = [];
  const pool = { calls, request() { const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; }, async query(sql) {
    calls.push({ sql, inputs });
    if (sql.includes('sp_getapplock') || sql.includes("Status=N'sending',Attempts")) return { recordset: [] };
    if (sql.includes('SELECT SettingsJson')) return { recordset: [{ SettingsJson: JSON.stringify(settings) }] };
    return results.shift() || { recordset: [] }; } }; } };
  pool.transaction = () => ({ begin: async () => {}, commit: async () => {}, rollback: async () => {}, request: () => pool.request() });
  return pool;
}
const complete = { approved: true, checked: true, prepared: true };
const record = { id: 'PCN-2026-0001', version: '0000000000000001', internalReview: { signoff: { gscTet: complete } } };

test('workflow derives route and returns mapping-empty without queuing', async () => {
  const pool = mockPool();
  const service = new NotificationService(pool, { repository: { getNotificationSettings: async () => ({ groups: [] }) } });
  assert.deepEqual(await service.workflow(record, { completedGroupKey: 'signoff.gscTet' }, { displayName: 'Reviewer' }), { queued: false, reason: 'recipient_not_configured', nextGroupKey: 'signoff.prodEngTet' });
  assert(!pool.calls.some(call => call.sql.includes('INSERT pcn.NotificationJobs')));
});

test('legacy handoff honors explicit TaPBU no-need and targets final QA', async () => {
  const service=new NotificationService(mockPool(),{repository:{getNotificationSettings:async()=>({groups:[]})}});
  const review={signoff:{gscTet:complete,prodEngTet:complete,qaTet:complete},tapbu:{noNeed:true}};
  const result=await service.workflow({...record,riskLevel:'RL1',internalReview:review},{completedGroupKey:'signoff.qaTet'});
  assert.equal(result.nextGroupKey,'qateFinal.signoff');
  assert.equal(result.reason,'recipient_not_configured');
});

test('workflow requires checked completed group and disallows supplied recipient or link', async () => {
  const service = new NotificationService(mockPool(), { repository: {} });
  await assert.rejects(service.workflow({ ...record, internalReview: { signoff: { gscTet: { ...complete, checked: false } } } }, { completedGroupKey: 'signoff.gscTet' }), { statusCode: 409 });
  await assert.rejects(service.workflow(record, { completedGroupKey: 'signoff.gscTet', to: 'other@example.com' }), { statusCode: 400 });
});

test('workflow queues unique version key with parameters and server-owned link', async () => {
  const pool = mockPool([{ recordset: [{ Id: 'job-id', Status: 'pending' }] }], { groups: [{ key: 'signoff.prodEngTet', emails: 'qa@example.com' }] });
  const service = new NotificationService(pool, { mailUrl: 'https://mail.example/send', publicOrigin: 'https://pcn.example', repository: { getNotificationSettings: async () => ({ groups: [{ key: 'signoff.prodEngTet', emails: 'qa@example.com' }] }) } });
  const result = await service.workflow(record, { completedGroupKey: 'signoff.gscTet' }, { displayName: 'QA' });
  assert.equal(result.jobId, 'job-id');
  const write = pool.calls.find(call => call.inputs.eventKey);
  assert.match(write.sql, /UPDLOCK, HOLDLOCK/);
  assert.equal(write.inputs.eventKey, 'PCN-2026-0001:0000000000000001:signoff.gscTet:completed');
  assert.match(write.inputs.payload, /https:\/\/pcn.example\/form.html\?id=PCN-2026-0001/);
  const payload = JSON.parse(write.inputs.payload);
  assert.deepEqual(Object.keys(payload).sort(), ['message', 'senderName', 'subject', 'to']);
  assert.equal(payload.to, 'qa@example.com');
  assert.equal(payload.senderName, 'QA');
  assert.equal(payload.subject, '[PCN] PCN-2026-0001 - GSC/TET completed');
  assert.match(payload.message, /<table role="presentation"/);
  assert.match(payload.message, /Current Status/);
  assert.match(payload.message, /Prod\.Eng\/TET/);
});

test('worker marks ambiguous send failure uncertain and never retries automatically', async () => {
  const pool = mockPool([{ recordset: [{ Id: 'job', PayloadJson: JSON.stringify({ to: 'qa@example.com' }) }] }]);
  const service = new NotificationWorker(pool, { integrationService: { sendMail: async () => { throw new Error('network timeout'); } } });
  assert.equal((await service.runOnce()).status, 'uncertain');
  assert.match(pool.calls.find(call => call.sql.includes('SELECT TOP(1)')).sql, /Status=N'pending'/);
  assert.equal(pool.calls.at(-1).inputs.status, 'uncertain');
  assert.equal(pool.calls.at(-1).inputs.error, 'Mail delivery outcome is unknown; operator review required');
});


test('worker idle does not call external mail and success records sent result using claim token', async () => {
  let calls = 0;
  const integrationService = { sendMail: async () => { calls++; } };
  assert.deepEqual(await new NotificationWorker(mockPool(), { integrationService }).runOnce(), { status: 'idle' });
  assert.equal(calls, 0);
  const pool = mockPool([{ recordset: [{ Id: 'job', PayloadJson: '{}' }] }]);
  assert.equal((await new NotificationWorker(pool, { integrationService }).runOnce()).status, 'sent');
  assert.equal(pool.calls.find(call => call.inputs.token).inputs.token, pool.calls.at(-1).inputs.token);
  assert.equal(pool.calls.at(-1).inputs.error, null);
});

test('RL0 routing skips TaPBU and blocks client attempts to select other next groups', async () => {
  const settings = { getNotificationSettings: async () => ({ groups: [] }) };
  const service = new NotificationService(mockPool(), { repository: settings });
  const pcn = { ...record, riskLevel: 'RL0', internalReview: { signoff: { gscTet: complete, prodEngTet: complete, qaTet: complete } } };
  assert.equal((await service.workflow(pcn, { completedGroupKey: 'signoff.qaTet' })).nextGroupKey, 'qateFinal.signoff');
  await assert.rejects(service.workflow(pcn, { completedGroupKey: 'signoff.qaTet', nextGroupKey: 'tapbu.gsc' }), { statusCode: 400 });
});

test('configured recipients without a server mail endpoint never queue jobs', async () => {
  const pool = mockPool([], { groups: [{ key: 'signoff.prodEngTet', emails: 'qa@example.com' }] });
  const service = new NotificationService(pool, { repository: { getNotificationSettings: async () => ({ groups: [{ key: 'signoff.prodEngTet', emails: 'qa@example.com' }] }) } });
  assert.equal((await service.workflow(record, { completedGroupKey: 'signoff.gscTet' })).reason, 'mail_not_configured');
  assert(!pool.calls.some(call => call.sql.includes('INSERT pcn.NotificationJobs')));
});
