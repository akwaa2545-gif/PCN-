const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationService } = require('../src/notificationService');
const { NotificationWorker } = require('../src/notificationWorker');
const { IntegrationService } = require('../src/integrationService');
const { SqlPcnRepository } = require('../src/sqlPcnRepository');
const { mailGroups } = require('../src/mailRouting');

const done = { approved: true, checked: true, prepared: true };
const base = { id: 'PCN-2026-0001', version: '0000000000000001', status: 'gsc_review', riskLevel: 'RL0', mailRoutingPolicyVersion: 2, internalReview: {} };
const configured = { schemaVersion: 2, groups: mailGroups.map(group => ({ ...group, emails: 'reviewer@example.test', recipients: [] })) };
function transaction(settings = configured, failInsert = false) {
  const calls = [];
  return { calls, transaction() { return this; }, begin: async () => {}, commit: async () => {}, rollback: async () => {}, request() {
    const inputs = {};
    return { input(name, type, value) { inputs[name] = value; return this; }, async query(query) {
      calls.push({ query, inputs });
      if (query.includes('SELECT SettingsJson')) return { recordset: [{ SettingsJson: JSON.stringify(settings) }] };
      if (query.includes('INSERT pcn.NotificationJobs')) {
        if (failInsert) throw new Error('outbox failed');
        return { recordset: [{ Id: 'job-id', Status: 'pending' }] };
      }
      return { recordset: [], rowsAffected: [1] };
    } };
  } };
}
const service = () => new NotificationService(null, { mailUrl: 'https://mail.example.test/send', publicOrigin: 'https://pcn.example.test' });
const writes = tx => tx.calls.filter(call => call.query?.includes('INSERT pcn.NotificationJobs'));

test('submitted creation targets GSC Prepared; draft creation generates no handoff', async () => {
  const notifications = service();
  const tx = transaction();
  const prepared = await notifications.prepare(tx, null, { ...base, status: 'submitted' }, 'user:reviewer');
  assert.equal(prepared.record.mailRoutingState.groupKey, 'department.gscTet.prepared');
  const result = await notifications.persisted(tx, prepared.record, prepared.plan);
  assert.equal(result.queued, true);
  assert.equal(writes(tx).length, 1);
  assert.equal(JSON.parse(writes(tx)[0].inputs.payload).to, 'reviewer@example.test');
  const draft = await notifications.prepare(transaction(), null, { ...base, status: 'draft' });
  assert.equal(draft.record.mailRoutingState, undefined);
  assert.equal(draft.plan.queued, false);
});

test('each saved action targets only the next pending list, including multi-action saves', async () => {
  for (const [flags, groupKey] of [
    [{ prepared: true }, 'department.gscTet.checked'],
    [{ prepared: true, checked: true }, 'department.gscTet.approved'],
    [done, 'department.prodEngTet.prepared']
  ]) {
    const tx = transaction();
    const prepared = await service().prepare(tx, base, { ...base, internalReview: { signoff: { gscTet: flags } } });
    assert.equal(prepared.record.mailRoutingState.groupKey, groupKey);
    await service().persisted(tx, { ...prepared.record, version: '0000000000000002' }, prepared.plan);
    assert.equal(writes(tx).length, 1);
    assert.equal(writes(tx)[0].inputs.version, '0000000000000002');
  }
});

test('QA final aliases the QA list and identifies final judgment in message', async () => {
  const before = { ...base, internalReview: { signoff: { gscTet: done, prodEngTet: done, qaTet: { prepared: true, checked: true } } } };
  const after = { ...before, internalReview: { signoff: { ...before.internalReview.signoff, qaTet: done } } };
  const tx = transaction();
  const prepared = await service().prepare(tx, before, after);
  assert.equal(prepared.record.mailRoutingState.stageKey, 'qateFinal.signoff');
  assert.equal(prepared.record.mailRoutingState.groupKey, 'department.qaTet.prepared');
  await service().persisted(tx, prepared.record, prepared.plan);
  assert.match(JSON.parse(writes(tx)[0].inputs.payload).message, /Final Judgment/);
});

test('non-RL0 keeps TaPBU requirements and persists an unsent prerequisite warning', async () => {
  const before = { ...base, riskLevel: 'RL2', internalReview: { signoff: { gscTet: done, prodEngTet: done, qaTet: { prepared: true, checked: true } } } };
  const tx = transaction();
  const after = { ...before, internalReview: { signoff: { ...before.internalReview.signoff, qaTet: done } } };
  const prepared = await service().prepare(tx, before, after);
  assert.equal(prepared.record.mailRoutingState.reason, 'tapbu_requirement_not_selected');
  assert.equal((await service().persisted(tx, prepared.record, prepared.plan)).queued, false);
  assert.equal(writes(tx).length, 0);
  const selected = await service().prepare(tx, prepared.record, { ...prepared.record,
    internalReview: { ...prepared.record.internalReview, tapbu: { need: true } } });
  assert.equal(selected.plan.queued, true);
  assert.equal(selected.record.mailRoutingState.groupKey, 'department.gscTapbu.prepared');
  await service().persisted(tx, selected.record, selected.plan);
  assert.equal(writes(tx).length, 1, 'Saving the prerequisite queues the now-actionable next step');
});

test('return to supplier action cancels pending handoff before a fresh resubmission', async () => {
  const tx = transaction();
  const notifications = service();
  const first = await notifications.prepare(tx, null, { ...base, status: 'submitted' });
  const returned = await notifications.prepare(tx, first.record, { ...first.record, status: 'supplier_action' });
  assert.equal(returned.record.mailRoutingState, undefined);
  assert.equal(returned.plan.queued, false);
  assert(tx.calls.some(call => call.query.includes("Status=N'cancelled'")));
  const submitted = await notifications.prepare(tx, returned.record, { ...returned.record, status: 'submitted' });
  assert.notEqual(submitted.record.mailRoutingState.activationId, first.record.mailRoutingState.activationId);
  assert.equal(submitted.plan.queued, true);
});

test('clearing and reselecting TaPBU Need cancels the pending job and starts one fresh handoff', async () => {
  const notifications = service();
  const tx = transaction();
  const before = { ...base, riskLevel: 'RL2', internalReview: { tapbu: { need: true },
    signoff: { gscTet: done, prodEngTet: done, qaTet: { prepared: true, checked: true } } } };
  const first = await notifications.prepare(tx, before, { ...before,
    internalReview: { ...before.internalReview, signoff: { ...before.internalReview.signoff, qaTet: done } } });
  await notifications.persisted(tx, first.record, first.plan);
  const cleared = await notifications.prepare(tx, first.record, { ...first.record,
    internalReview: { ...first.record.internalReview, tapbu: { need: false } } });
  assert.equal(cleared.plan.queued, false);
  assert.equal(cleared.record.mailRoutingState.reason, 'tapbu_requirement_not_selected');
  const cancellation = tx.calls.find(call => call.query?.includes("Status=N'cancelled'"));
  assert.equal(cancellation.inputs.eventKey, `${base.id}:${first.record.mailRoutingState.activationId}:handoff`);
  const selected = await notifications.prepare(tx, cleared.record, { ...cleared.record,
    internalReview: { ...cleared.record.internalReview, tapbu: { need: true } } });
  assert.equal(selected.plan.queued, true);
  assert.notEqual(selected.record.mailRoutingState.activationId, first.record.mailRoutingState.activationId);
  await notifications.persisted(tx, selected.record, selected.plan);
  assert.equal(writes(tx).length, 2, 'One initial job and one fresh job after the first is cancelled');
});

test('combined final signoff and terminal-status save still queues supplier handoff once', async () => {
  const before = { ...base, status: 'qa_review', internalReview: {
    signoff: { gscTet: done, prodEngTet: done, qaTet: done },
    qateFinal: { approve: true, signoff: { prepared: true, checked: true } }
  } };
  for (const status of ['approved', 'rejected', 'closed']) {
    const tx = transaction();
    const after = { ...before, status, internalReview: { ...before.internalReview, qateFinal: { ...before.internalReview.qateFinal, signoff: done } } };
    const prepared = await service().prepare(tx, before, after);
    assert.equal(prepared.record.mailRoutingState.groupKey, 'supplierNotification');
    await service().persisted(tx, prepared.record, prepared.plan);
    assert.equal(writes(tx).length, 1);
    const unchanged = await service().prepare(tx, prepared.record, prepared.record);
    assert.equal(unchanged.plan.queued, false);
  }
});

test('status-only closure preserves the previously queued final supplier notice', async () => {
  const before = { ...base, status: 'qa_review', internalReview: {
    signoff: { gscTet: done, prodEngTet: done, qaTet: done }, qateFinal: { signoff: { prepared: true, checked: true } }
  } };
  const tx = transaction();
  const prepared = await service().prepare(tx, before, { ...before, internalReview: { ...before.internalReview, qateFinal: { signoff: done } } });
  await service().persisted(tx, prepared.record, prepared.plan);
  const closing = await service().prepare(tx, prepared.record, { ...prepared.record, status: 'closed' });
  assert.equal(closing.record.mailRoutingState.activationId, prepared.record.mailRoutingState.activationId);
  assert.equal(closing.plan.queued, false);
  assert.equal(tx.calls.filter(call => call.query?.includes("Status=N'cancelled'")).length, 0);
  assert.equal(writes(tx).length, 1);
});

test('unrelated saves retain activation identity without a second email', async () => {
  const tx = transaction();
  const first = await service().prepare(tx, base, { ...base, internalReview: { signoff: { gscTet: { prepared: true } } } });
  const current = first.record;
  const unchanged = await service().prepare(tx, current, { ...current, updatedAt: '2026-10-06T10:00:00Z' });
  assert.equal(unchanged.record.mailRoutingState.activationId, current.mailRoutingState.activationId);
  const result = await service().persisted(tx, unchanged.record, unchanged.plan);
  assert.equal(result.queued, false);
  assert.equal(writes(tx).length, 0);
});

test('reset cancels only unclaimed jobs; valid recompletion gets a new identity', async () => {
  const notifications = service();
  const tx = transaction();
  const first = await notifications.prepare(tx, base, { ...base, internalReview: { signoff: { gscTet: { prepared: true } } } });
  const reset = await notifications.prepare(tx, first.record, { ...first.record, internalReview: {} });
  assert.equal(reset.plan.queued, false);
  const cancellation = tx.calls.find(call => call.query.includes("Status=N'cancelled'"));
  assert.match(cancellation.query, /Status=N'pending'/);
  assert.equal(cancellation.inputs.eventKey, `${base.id}:${first.record.mailRoutingState.activationId}:handoff`);
  const again = await notifications.prepare(tx, reset.record, { ...reset.record, internalReview: first.record.internalReview });
  assert.notEqual(again.record.mailRoutingState.activationId, first.record.mailRoutingState.activationId);
  assert.equal(again.plan.queued, true);
});

test('empty lists and missing mail save a blocked outcome and never enqueue', async () => {
  const next = { ...base, internalReview: { signoff: { gscTet: { prepared: true } } } };
  for (const [notifications, settings, reason] of [
    [service(), { schemaVersion: 2, groups: [] }, 'recipient_not_configured'],
    [new NotificationService(null), configured, 'mail_not_configured']
  ]) {
    const tx = transaction(settings);
    const prepared = await notifications.prepare(tx, base, next);
    assert.equal(prepared.record.mailRoutingState.reason, reason);
    assert.equal((await notifications.persisted(tx, prepared.record, prepared.plan)).reason, reason);
    assert.equal(writes(tx).length, 0);
    const afterConfigEdit = await notifications.prepare(transaction(configured), prepared.record, prepared.record);
    assert.equal(afterConfigEdit.plan.queued, false, 'Configuration changes do not release old blocked mail');
  }
});

test('legacy settings preserve existing explicit notification path without automatic jobs', async () => {
  const tx = transaction({ groups: [] });
  const prepared = await service().prepare(tx, base, { ...base, internalReview: { signoff: { gscTet: done } } });
  assert.equal(prepared.record.mailRoutingState, undefined);
  assert.equal(prepared.plan, undefined);
  assert.equal(writes(tx).length, 0);
});

test('existing submitted and review PCNs adopt current routing and queue the pending action once', async () => {
  const { mailRoutingPolicyVersion: omitted, ...unversioned } = base;
  for (const legacy of [unversioned, { ...base, mailRoutingPolicyVersion: 1 }]) {
    for (const status of ['submitted', 'gsc_review']) {
      for (const [signoff, groupKey] of [[{}, 'department.gscTet.prepared'],
        [{ gscTet: { prepared: true } }, 'department.gscTet.checked']]) {
        const tx = transaction();
        const notifications = service();
        const before = { ...legacy, status, internalReview: { signoff } };
        const prepared = await notifications.prepare(tx, before, { ...before });
        assert.equal(prepared.record.mailRoutingPolicyVersion, 2);
        assert.equal(prepared.record.mailRoutingState.groupKey, groupKey);
        assert.equal(prepared.plan.queued, true);
        assert.equal(prepared.plan.update.reason, 'no_change', 'Adoption does not fabricate a PCN update');
        const saved = { ...prepared.record, version: '0000000000000002' };
        const result = await notifications.persisted(tx, saved, prepared.plan);
        assert.equal(result.actionRequired.queued, true);
        assert.equal(result.update.queued, false);
        assert.equal(writes(tx).length, 1);
        assert.equal(writes(tx)[0].inputs.version, saved.version);
        assert.equal(JSON.parse(writes(tx)[0].inputs.payload).to, 'reviewer@example.test');
        const repeated = await notifications.prepare(tx, saved, { ...saved });
        assert.equal(repeated.record.mailRoutingState.activationId, saved.mailRoutingState.activationId);
        assert.equal((await notifications.persisted(tx, repeated.record, repeated.plan)).queued, false);
        assert.equal(writes(tx).length, 1, 'Repeated saves cannot queue another adoption notice');
      }
    }
  }
});

test('adopting legacy routing after a saved signoff sends only the current pending step', async () => {
  const legacy = { ...base, mailRoutingPolicyVersion: 1 };
  const tx = transaction();
  const prepared = await service().prepare(tx, legacy, { ...legacy,
    internalReview: { signoff: { gscTet: done } } });
  assert.equal(prepared.record.mailRoutingPolicyVersion, 2);
  assert.equal(prepared.record.mailRoutingState.groupKey, 'department.prodEngTet.prepared');
  assert.equal(prepared.plan.queued, true);
  await service().persisted(tx, prepared.record, prepared.plan);
  assert.equal(writes(tx).length, 1);
  assert.match(JSON.parse(writes(tx)[0].inputs.payload).message, /GSC\/TET Approved completed/);
});

test('adoption cancels pending legacy notices only before creating the current handoff', async () => {
  const tx = transaction();
  const legacy = { ...base, mailRoutingPolicyVersion: 1 };
  const notifications = service();
  const prepared = await notifications.prepare(tx, legacy, legacy);
  const cancellations = tx.calls.filter(call => call.query?.includes("Status=N'cancelled'"));
  assert.equal(cancellations.length, 1);
  assert.match(cancellations[0].query, /Status=N'pending'/);
  assert.match(cancellations[0].query, /Action=N'completed'/);
  assert.equal(cancellations[0].inputs.pcnId, legacy.id);
  await notifications.persisted(tx, prepared.record, prepared.plan);
  assert(tx.calls.indexOf(cancellations[0]) < tx.calls.indexOf(writes(tx)[0]));
  await notifications.prepare(tx, prepared.record, prepared.record);
  assert.equal(tx.calls.filter(call => call.query?.includes("Status=N'cancelled'")).length, 1);
});

test('legacy draft, supplier action and terminal PCNs adopt policy without retrospective action notices', async () => {
  for (const status of ['draft', 'supplier_action', 'approved', 'rejected', 'closed']) {
    const tx = transaction();
    const legacy = { ...base, status, mailRoutingPolicyVersion: 1,
      internalReview: { signoff: { gscTet: done, prodEngTet: done, qaTet: done }, qateFinal: { signoff: done } } };
    const prepared = await service().prepare(tx, legacy, legacy);
    assert.equal(prepared.record.mailRoutingPolicyVersion, 2);
    assert.equal(prepared.plan.queued, false, `${status} must not produce a retrospective action notice`);
    assert.equal((await service().persisted(tx, prepared.record, prepared.plan)).queued, false);
    assert.equal(writes(tx).length, 0);
  }
});

test('legacy adoption with missing recipients or mail configuration persists a blocked current step', async () => {
  const legacy = { ...base, mailRoutingPolicyVersion: 1 };
  for (const [notifications, settings, reason] of [
    [service(), { schemaVersion: 2, groups: [] }, 'recipient_not_configured'],
    [new NotificationService(null), configured, 'mail_not_configured']
  ]) {
    const tx = transaction(settings);
    const prepared = await notifications.prepare(tx, legacy, legacy);
    assert.equal(prepared.record.mailRoutingPolicyVersion, 2);
    assert.equal(prepared.record.mailRoutingState.groupKey, 'department.gscTet.prepared');
    assert.equal(prepared.record.mailRoutingState.reason, reason);
    assert.equal((await notifications.persisted(tx, prepared.record, prepared.plan)).queued, false);
    assert.equal(writes(tx).length, 0);
  }
});

test('clearing a legacy signoff during adoption never queues retrospective completion mail', async () => {
  const tx = transaction();
  const legacy = { ...base, mailRoutingPolicyVersion: 1,
    internalReview: { signoff: { gscTet: { prepared: true } } } };
  const prepared = await service().prepare(tx, legacy, { ...legacy, internalReview: {} });
  assert.equal(prepared.record.mailRoutingPolicyVersion, 2);
  assert.equal(prepared.plan.queued, false);
  assert.equal((await service().persisted(tx, prepared.record, prepared.plan)).actionRequired.queued, false);
  assert.equal(writes(tx).length, 0);
});

test('legacy settings continue to allow the explicit completed-group notification', async () => {
  const legacy = { ...base, mailRoutingPolicyVersion: 1,
    internalReview: { signoff: { gscTet: done } } };
  const raw = { groups: [{ key: 'signoff.prodEngTet', emails: 'legacy@example.test' }] };
  const tx = transaction(raw);
  const notifications = new NotificationService(tx, { mailUrl: 'https://mail.example.test/send' });
  const prepared = await notifications.prepare(tx, legacy, legacy);
  assert.equal(prepared.record.mailRoutingPolicyVersion, 1);
  assert.equal(prepared.plan, undefined);
  assert.equal((await notifications.workflow(prepared.record, { completedGroupKey: 'signoff.gscTet' })).queued, true);
  assert.equal(writes(tx).length, 1);
  assert.equal(JSON.parse(writes(tx)[0].inputs.payload).to, 'legacy@example.test');
});

test('legacy adoption reaches the Power Automate transport with only the current action payload', async () => {
  const mailUrl = 'https://mail.example.test/power-automate';
  const transportCalls = [];
  const integrations = new IntegrationService({ mailUrl, allowedHosts: ['mail.example.test'],
    fetchImpl: async (url, options) => {
      transportCalls.push({ url, options });
      return { ok: true };
    } });
  const settings = { ...configured, groups: configured.groups.map(group => ({ ...group,
    emails: group.key === 'department.gscTet.checked' ? 'checked@example.test' : 'approved@example.test' })) };
  const tx = transaction(settings);
  const legacy = { ...base, status: 'submitted', mailRoutingPolicyVersion: 1,
    internalReview: { signoff: { gscTet: { prepared: true } } } };
  const notifications = new NotificationService(null, { mailUrl,
    mailConfigurationStatus: () => integrations.mailConfigurationStatus() });
  const prepared = await notifications.prepare(tx, legacy, legacy);
  assert.equal(prepared.plan.queued, true);
  await notifications.persisted(tx, { ...prepared.record, version: '0000000000000002' }, prepared.plan);
  const jobs = writes(tx).map(write => ({ Id: write.inputs.id, payload: JSON.parse(write.inputs.payload) }));
  assert.equal(jobs.length, 1);
  const updates = transaction();
  const worker = new NotificationWorker(updates, { integrationService: integrations });
  worker.claim = async () => jobs.shift() || null;
  assert.equal((await worker.runOnce()).status, 'sent');
  assert.equal((await worker.runOnce()).status, 'idle');
  assert.equal(transportCalls.length, 1, 'Power Automate receives exactly one request');
  assert.equal(transportCalls[0].url, mailUrl);
  assert.equal(transportCalls[0].options.method, 'POST');
  assert.equal(transportCalls[0].options.redirect, 'error');
  assert.equal(transportCalls[0].options.headers['content-type'], 'application/json');
  const payload = JSON.parse(transportCalls[0].options.body);
  assert.deepEqual(Object.keys(payload).sort(), ['message', 'senderName', 'subject', 'to']);
  assert.equal(payload.to, 'checked@example.test');
  assert.match(payload.subject, /GSC\/TET Checked/);
  assert.match(payload.message, /GSC\/TET Checked/);
  const recorded = updates.calls.filter(call => call.query?.includes('UPDATE pcn.NotificationJobs'));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].inputs.status, 'sent');
});

test('a stale browser notification POST cannot duplicate a version-2 save handoff', async () => {
  const tx = transaction();
  const notifications = new NotificationService(tx, { repository: { getNotificationSettings: async () => configured } });
  assert.deepEqual(await notifications.workflow(base, { completedGroupKey: 'signoff.gscTet' }), { queued: false, reason: 'handled_on_save' });
  assert.equal(writes(tx).length, 0);
});

test('job key uses activation identity and original Power Automate payload contract', async () => {
  const tx = transaction();
  const prepared = await service().prepare(tx, base, { ...base, internalReview: { signoff: { gscTet: { prepared: true } } } });
  await service().persisted(tx, prepared.record, prepared.plan);
  const write = writes(tx)[0];
  assert.equal(write.inputs.eventKey, `${base.id}:${prepared.record.mailRoutingState.activationId}:handoff`);
  assert.deepEqual(Object.keys(JSON.parse(write.inputs.payload)).sort(), ['actionSnapshot', 'message', 'senderName', 'subject', 'to']);
  assert.doesNotMatch(write.query, /BEGIN TRANSACTION|COMMIT/);
});

class IsolatedSqlRepository extends SqlPcnRepository {
  async allocateCode() { return base.id; }
  async readParent() { return { PcnId: 1, RowVersion: Buffer.from(base.version, 'hex') }; }
  async readAggregate(tx, parent) { return tx.saved || base; }
  async writeParent(tx, record) { tx.saved = { ...record, version: '0000000000000002' }; return { PcnId: 1 }; }
  async writeChildren() {}
  async audit() {}
}
function sqlPool(failInsert) {
  const tx = transaction(configured, failInsert);
  tx.begin = async () => tx.calls.push('begin');
  tx.commit = async () => tx.calls.push('commit');
  tx.rollback = async () => tx.calls.push('rollback');
  return { transaction: () => tx, tx };
}

test('SQL create/update execute notification hooks before commit and roll back outbox failures', async () => {
  for (const operation of ['create', 'update']) {
    for (const fail of [false, true]) {
      const pool = sqlPool(fail);
      const repository = new IsolatedSqlRepository(pool, { notifications: service() });
      const save = operation === 'create'
        ? repository.create({ ...base, id: undefined, status: 'submitted', createdAt: '2026-10-06T00:00:00Z' })
        : repository.update(base.id, current => ({ ...current, internalReview: { signoff: { gscTet: { prepared: true } } } }), 'reviewer', base.version);
      if (fail) {
        await assert.rejects(save, /outbox failed/);
        assert.equal(pool.tx.calls.at(-1), 'rollback');
        assert(!pool.tx.calls.includes('commit'));
      } else {
        const saved = await save;
        assert.equal(saved.notification.queued, true);
        assert.equal(pool.tx.calls.at(-1), 'commit');
        assert.equal(writes(pool.tx).length, 1);
      }
    }
  }
});

test('stale SQL PCN save rejects before notification preparation', async () => {
  const pool = sqlPool(false);
  const repository = new IsolatedSqlRepository(pool, { notifications: service() });
  await assert.rejects(repository.update(base.id, () => base, 'reviewer', '000000000000000f'), { statusCode: 409 });
  assert.equal(pool.tx.calls.filter(call => typeof call === 'object' && !call.query.includes('sp_getapplock')).length, 0);
});

test('old-order v2 records adopt the current Prepared target on the first eligible save only', async () => {
  for (const oldState of [undefined, { activationId: 'old-activation', stageKey: 'signoff.gscTet',
    action: 'checked', groupKey: 'department.gscTet.checked', status: 'pending' }]) {
    const tx = transaction();
    const before = { ...base, internalReview: { signoff: { gscTet: { approved: true } } },
      ...(oldState ? { mailRoutingState: oldState } : {}) };
    const prepared = await service().prepare(tx, before, before);
    assert.equal(prepared.record.mailRoutingState.signingOrderVersion, 2);
    assert.equal(prepared.record.mailRoutingState.groupKey, 'department.gscTet.prepared');
    assert.equal(prepared.plan.queued, true);
    const cancellation = tx.calls.find(call => call.query?.includes("Status=N'cancelled'") && call.inputs.pcnId);
    assert(cancellation, 'All pending old-order handoffs must be cancelled before replacing them');
    assert.match(cancellation.query, /Status=N'pending'/);
    await service().persisted(tx, prepared.record, prepared.plan);
    assert.equal(writes(tx).length, 1);
    assert(tx.calls.indexOf(cancellation) < tx.calls.indexOf(writes(tx)[0]));
    const snapshot = JSON.parse(writes(tx)[0].inputs.payload).actionSnapshot;
    assert.deepEqual(snapshot, { signingOrderVersion: 2, pcnId: base.id,
      activationId: prepared.record.mailRoutingState.activationId, stageKey: 'signoff.gscTet',
      action: 'prepared', groupKey: 'department.gscTet.prepared' });
    const repeated = await service().prepare(tx, prepared.record, prepared.record);
    assert.equal(repeated.plan.queued, false);
    assert.equal(repeated.record.mailRoutingState.activationId, prepared.record.mailRoutingState.activationId);
  }
});

test('old-order terminal records do not receive retrospective handoffs when signing order changes', async () => {
  for (const status of ['approved', 'rejected', 'closed']) {
    const before = { ...base, status,
      internalReview: { signoff: { gscTet: done, prodEngTet: done, qaTet: done }, qateFinal: { signoff: done } },
      mailRoutingState: { activationId: 'old-final', stageKey: 'supplierNotification', action: null,
        groupKey: 'supplierNotification', status: 'pending' } };
    const prepared = await service().prepare(transaction(), before, before);
    assert.equal(prepared.plan.queued, false);
  }
});
