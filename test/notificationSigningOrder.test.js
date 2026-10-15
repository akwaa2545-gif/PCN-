const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationWorker } = require('../src/notificationWorker');

const pcnId = 'PCN-2026-0001';
const state = { signingOrderVersion: 2, activationId: 'current-activation', stageKey: 'signoff.gscTet',
  action: 'prepared', groupKey: 'department.gscTet.prepared', status: 'pending' };
const actionSnapshot = { signingOrderVersion: 2, pcnId, activationId: state.activationId,
  stageKey: state.stageKey, action: state.action, groupKey: state.groupKey };
const mail = { to: 'prepared@example.test', subject: 'GSC/TET Prepared', message: 'Complete Prepared', senderName: 'PCN' };
function poolFor(payload, options = {}) {
  const calls = [];
  const record = options.record === null ? null : { PcnCode: pcnId, Status: 'gsc_review', RiskLevel: 'RL0',
    LegacyExtrasJson: JSON.stringify({ mailRoutingPolicyVersion: 2, mailRoutingState: state }),
    ReviewJson: JSON.stringify({}), ...options.record };
  const tx = { begin: async () => calls.push('begin'), commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'), request() {
      const inputs = {};
      return { input(name, type, value) { inputs[name] = value; return this; }, async query(query) {
        calls.push({ query, inputs });
        if (query.includes('SELECT TOP(1)')) return { recordset: [{ Id: 'job-id', PcnId: pcnId,
          Action: options.action || 'prepared', EventKey: `${pcnId}:${options.activationId || state.activationId}:handoff`,
          PayloadJson: JSON.stringify(payload) }] };
        if (query.includes('pcn.PcnRequests')) return { recordset: record ? [record] : [] };
        return { recordset: [] };
      } };
    } };
  return { calls, transaction: () => tx, request: () => tx.request() };
}

test('worker cancels old-order manual and managed action jobs before calling Power Automate', async () => {
  for (const managed of [false, true]) {
    const payload = { ...mail, to: 'approved@example.test', ...(managed ? { routingSnapshot: {
      groupKey: 'department.gscTet.approved', manualEmails: 'approved@example.test', automaticRecipients: [] } } : {}) };
    const pool = poolFor(payload, { action: 'approved' });
    let calls = 0;
    const worker = new NotificationWorker(pool, { integrationService: { sendMail: async () => { calls++; } } });
    assert.equal((await worker.runOnce()).status, 'cancelled');
    assert.equal(calls, 0);
    const lock = pool.calls.find(call => call.query?.includes('sp_getapplock'));
    assert.equal(lock.inputs.mode, 'Exclusive');
    const claim = pool.calls.find(call => call.query?.includes('SELECT TOP(1)'));
    assert(pool.calls.indexOf(lock) < pool.calls.indexOf(claim));
    assert(pool.calls.some(call => call.query?.includes("Status=N'cancelled'")));
  }
});

test('worker validates current target and activation for every versioned manual handoff', async () => {
  const cases = [
    { record: null },
    { record: { Status: 'draft' } },
    { record: { ReviewJson: JSON.stringify({ signoff: { gscTet: { prepared: true } } }) } },
    { record: { LegacyExtrasJson: JSON.stringify({ mailRoutingPolicyVersion: 2,
      mailRoutingState: { ...state, activationId: 'new-activation' } }) } },
    { activationId: 'another-job-activation' },
    { record: { LegacyExtrasJson: JSON.stringify({ mailRoutingPolicyVersion: 2,
      mailRoutingState: { ...state, status: 'blocked' } }) } }
  ];
  for (const options of cases) {
    let calls = 0;
    const worker = new NotificationWorker(poolFor({ ...mail, actionSnapshot }, options),
      { integrationService: { sendMail: async () => { calls++; } } });
    assert.equal((await worker.runOnce()).status, 'cancelled');
    assert.equal(calls, 0);
  }
});

test('worker commits a current action claim before sending exactly the four public fields', async () => {
  const pool = poolFor({ ...mail, actionSnapshot });
  let delivered;
  const worker = new NotificationWorker(pool, { integrationService: { sendMail: async payload => {
    assert.equal(pool.calls.at(-1), 'commit'); delivered = payload;
  } } });
  assert.equal((await worker.runOnce()).status, 'sent');
  assert.deepEqual(delivered, mail);
  assert(pool.calls.some(call => call.query?.includes('pcn.PcnInternalReviews')));
});

test('worker allows the current final supplier notice after terminal status and rejects old unversioned notice', async () => {
  const done = { prepared: true, checked: true, approved: true };
  const finalState = { ...state, stageKey: 'supplierNotification', action: null, groupKey: 'supplierNotification' };
  const snapshot = { ...actionSnapshot, stageKey: finalState.stageKey, action: null, groupKey: finalState.groupKey };
  for (const versioned of [true, false]) {
    const pool = poolFor({ ...mail, ...(versioned ? { actionSnapshot: snapshot } : {}) }, { action: 'notification', record: {
      Status: 'closed', ReviewJson: JSON.stringify({ signoff: { gscTet: done, prodEngTet: done, qaTet: done }, qateFinal: { signoff: done } }),
      LegacyExtrasJson: JSON.stringify({ mailRoutingPolicyVersion: 2, mailRoutingState: finalState })
    } });
    let calls = 0;
    const worker = new NotificationWorker(pool, { integrationService: { sendMail: async () => { calls++; } } });
    assert.equal((await worker.runOnce()).status, versioned ? 'sent' : 'cancelled');
    assert.equal(calls, versioned ? 1 : 0);
  }
});
