const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationService } = require('../src/notificationService');
const { NotificationWorker } = require('../src/notificationWorker');

function mockPool(results = []) {
  const calls = [];
  return { calls, request() { const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; }, async query(sql) { calls.push({ sql, inputs }); return results.shift() || { recordset: [] }; } }; } };
}
const complete = { approved: true, checked: true, prepared: true };
const record = { id: 'PCN-2026-0001', version: '0000000000000001', internalReview: { signoff: { gscTet: complete } } };

test('workflow derives route and returns mapping-empty without queuing', async () => {
  const pool = mockPool();
  const service = new NotificationService(pool, { repository: { getNotificationSettings: async () => ({ groups: [] }) } });
  assert.deepEqual(await service.workflow(record, { completedGroupKey: 'signoff.gscTet' }, { displayName: 'Reviewer' }), { queued: false, reason: 'recipient_not_configured', nextGroupKey: 'signoff.prodEngTet' });
  assert.equal(pool.calls.length, 0);
});

test('workflow requires checked completed group and disallows supplied recipient or link', async () => {
  const service = new NotificationService(mockPool(), { repository: {} });
  await assert.rejects(service.workflow({ ...record, internalReview: { signoff: { gscTet: { ...complete, checked: false } } } }, { completedGroupKey: 'signoff.gscTet' }), { statusCode: 409 });
  await assert.rejects(service.workflow(record, { completedGroupKey: 'signoff.gscTet', to: 'other@example.com' }), { statusCode: 400 });
});

test('workflow queues unique version key with parameters and server-owned link', async () => {
  const pool = mockPool([{ recordset: [{ Id: 'job-id', Status: 'pending' }] }]);
  const service = new NotificationService(pool, { mailUrl: 'https://mail.example/send', publicOrigin: 'https://pcn.example', repository: { getNotificationSettings: async () => ({ groups: [{ key: 'signoff.prodEngTet', emails: 'qa@example.com' }] }) } });
  const result = await service.workflow(record, { completedGroupKey: 'signoff.gscTet' }, { displayName: 'QA' });
  assert.equal(result.jobId, 'job-id');
  assert.match(pool.calls[0].sql, /UPDLOCK, HOLDLOCK/);
  assert.equal(pool.calls[0].inputs.eventKey, 'PCN-2026-0001:0000000000000001:signoff.gscTet:completed');
  assert.match(pool.calls[0].inputs.payload, /https:\/\/pcn.example\/form.html\?id=PCN-2026-0001/);
});

test('worker marks ambiguous send failure uncertain and never retries automatically', async () => {
  const pool = mockPool([{ recordset: [{ Id: 'job', PayloadJson: JSON.stringify({ to: 'qa@example.com' }) }] }]);
  const service = new NotificationWorker(pool, { integrationService: { sendMail: async () => { throw new Error('network timeout'); } } });
  assert.equal((await service.runOnce()).status, 'uncertain');
  assert.match(pool.calls[0].sql, /Status=N'pending'/);
  assert.equal(pool.calls[1].inputs.status, 'uncertain');
  assert.equal(pool.calls[1].inputs.error, 'Mail delivery outcome is unknown; operator review required');
});


test('worker idle does not call external mail and success records sent result using claim token', async () => {
  let calls = 0;
  const integrationService = { sendMail: async () => { calls++; } };
  assert.deepEqual(await new NotificationWorker(mockPool(), { integrationService }).runOnce(), { status: 'idle' });
  assert.equal(calls, 0);
  const pool = mockPool([{ recordset: [{ Id: 'job', PayloadJson: '{}' }] }]);
  assert.equal((await new NotificationWorker(pool, { integrationService }).runOnce()).status, 'sent');
  assert.equal(pool.calls[0].inputs.token, pool.calls[1].inputs.token);
  assert.equal(pool.calls[1].inputs.error, null);
});

test('RL0 routing skips TaPBU and blocks client attempts to select other next groups', async () => {
  const settings = { getNotificationSettings: async () => ({ groups: [] }) };
  const service = new NotificationService(mockPool(), { repository: settings });
  const pcn = { ...record, riskLevel: 'RL0', internalReview: { signoff: { gscTet: complete, prodEngTet: complete, qaTet: complete } } };
  assert.equal((await service.workflow(pcn, { completedGroupKey: 'signoff.qaTet' })).nextGroupKey, 'qateFinal.signoff');
  await assert.rejects(service.workflow(pcn, { completedGroupKey: 'signoff.qaTet', nextGroupKey: 'tapbu.gsc' }), { statusCode: 400 });
});

test('configured recipients without a server mail endpoint never queue jobs', async () => {
  const pool = mockPool();
  const service = new NotificationService(pool, { repository: { getNotificationSettings: async () => ({ groups: [{ key: 'signoff.prodEngTet', emails: 'qa@example.com' }] }) } });
  assert.equal((await service.workflow(record, { completedGroupKey: 'signoff.gscTet' })).reason, 'mail_not_configured');
  assert.equal(pool.calls.length, 0);
});
