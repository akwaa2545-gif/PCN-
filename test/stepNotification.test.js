const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationService } = require('../src/notificationService');
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

test('submitted creation targets GSC Approved; draft creation generates no handoff', async () => {
  const notifications = service();
  const tx = transaction();
  const prepared = await notifications.prepare(tx, null, { ...base, status: 'submitted' }, 'user:reviewer');
  assert.equal(prepared.record.mailRoutingState.groupKey, 'department.gscTet.approved');
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
    [{ approved: true }, 'department.gscTet.checked'],
    [{ approved: true, checked: true }, 'department.gscTet.prepared'],
    [done, 'department.prodEngTet.approved']
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
  const before = { ...base, internalReview: { signoff: { gscTet: done, prodEngTet: done, qaTet: { approved: true, checked: true } } } };
  const after = { ...before, internalReview: { signoff: { ...before.internalReview.signoff, qaTet: done } } };
  const tx = transaction();
  const prepared = await service().prepare(tx, before, after);
  assert.equal(prepared.record.mailRoutingState.stageKey, 'qateFinal.signoff');
  assert.equal(prepared.record.mailRoutingState.groupKey, 'department.qaTet.approved');
  await service().persisted(tx, prepared.record, prepared.plan);
  assert.match(JSON.parse(writes(tx)[0].inputs.payload).message, /Final Judgment/);
});

test('non-RL0 keeps TaPBU requirements and persists an unsent prerequisite warning', async () => {
  const before = { ...base, riskLevel: 'RL2', internalReview: { signoff: { gscTet: done, prodEngTet: done, qaTet: { approved: true, checked: true } } } };
  const tx = transaction();
  const after = { ...before, internalReview: { signoff: { ...before.internalReview.signoff, qaTet: done } } };
  const prepared = await service().prepare(tx, before, after);
  assert.equal(prepared.record.mailRoutingState.reason, 'tapbu_requirement_not_selected');
  assert.equal((await service().persisted(tx, prepared.record, prepared.plan)).queued, false);
  assert.equal(writes(tx).length, 0);
  const selected = await service().prepare(tx, prepared.record, { ...prepared.record,
    internalReview: { ...prepared.record.internalReview, tapbu: { need: true } } });
  assert.equal(selected.plan.queued, true);
  assert.equal(selected.record.mailRoutingState.groupKey, 'department.gscTapbu.approved');
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
    signoff: { gscTet: done, prodEngTet: done, qaTet: { approved: true, checked: true } } } };
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
    qateFinal: { approve: true, signoff: { approved: true, checked: true } }
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
    signoff: { gscTet: done, prodEngTet: done, qaTet: done }, qateFinal: { signoff: { approved: true, checked: true } }
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
  const first = await service().prepare(tx, base, { ...base, internalReview: { signoff: { gscTet: { approved: true } } } });
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
  const first = await notifications.prepare(tx, base, { ...base, internalReview: { signoff: { gscTet: { approved: true } } } });
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
  const next = { ...base, internalReview: { signoff: { gscTet: { approved: true } } } };
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

test('existing PCNs keep legacy routing after an administrator saves step lists', async () => {
  const { mailRoutingPolicyVersion: omitted, ...legacy } = base;
  const tx = transaction();
  const prepared = await service().prepare(tx, legacy, { ...legacy, internalReview: { signoff: { gscTet: done } } });
  assert.equal(prepared.record.mailRoutingPolicyVersion, 1);
  assert.equal(prepared.record.mailRoutingState, undefined);
  assert.equal(prepared.plan, undefined);
  assert.equal(writes(tx).length, 0);
  const raw = { ...configured, legacyGroups: [{ key: 'signoff.prodEngTet', emails: 'legacy@example.test' }] };
  const legacyPool = transaction(raw);
  const notifications = new NotificationService(legacyPool, { repository: { getNotificationSettings: async () => raw }, mailUrl: 'https://mail.example.test/send' });
  assert.equal((await notifications.workflow(prepared.record, { completedGroupKey: 'signoff.gscTet' })).queued, true);
  assert.equal(JSON.parse(writes(legacyPool)[0].inputs.payload).to, 'legacy@example.test');
});

test('a stale browser notification POST cannot duplicate a version-2 save handoff', async () => {
  const tx = transaction();
  const notifications = new NotificationService(tx, { repository: { getNotificationSettings: async () => configured } });
  assert.deepEqual(await notifications.workflow(base, { completedGroupKey: 'signoff.gscTet' }), { queued: false, reason: 'handled_on_save' });
  assert.equal(writes(tx).length, 0);
});

test('job key uses activation identity and original Power Automate payload contract', async () => {
  const tx = transaction();
  const prepared = await service().prepare(tx, base, { ...base, internalReview: { signoff: { gscTet: { approved: true } } } });
  await service().persisted(tx, prepared.record, prepared.plan);
  const write = writes(tx)[0];
  assert.equal(write.inputs.eventKey, `${base.id}:${prepared.record.mailRoutingState.activationId}:handoff`);
  assert.deepEqual(Object.keys(JSON.parse(write.inputs.payload)).sort(), ['message', 'senderName', 'subject', 'to']);
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
        : repository.update(base.id, current => ({ ...current, internalReview: { signoff: { gscTet: { approved: true } } } }), 'reviewer', base.version);
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
