const crypto = require('node:crypto');
const sql = require('mssql');
const { ApiError } = require('./apiError');
const { emailList } = require('./integrationService');
const { buildWorkflowNotificationMessage, buildPcnUpdateNotificationMessage } = require('./notificationTemplate');
const { meaningfulUpdate, notificationRecipient, batchRecipients } = require('./notificationUpdates');
const { actions, departments, legacyDefinitions, normalizeMailRouting, resolveNextMailTarget } = require('./mailRouting');
const { routeGroups } = require('./workflowAccess');
const { lockUserMailRouting, readUserMailAssignments, readGeneralNotificationUsers, applyUserMailRouting, assertCurrentUser } = require('./userMailRouting');

const groups = [
  ['signoff.gscTet', 'GSC/TET'], ['signoff.prodEngTet', 'Prod.Eng/TET'],
  ['signoff.qaTet', 'QA/TET'], ['tapbu.gsc', 'GSC/TaPBU'],
  ['tapbu.qa', 'QA/TaPBU'], ['qateFinal.signoff', 'QA/TET Final Judgment'],
  ['supplierNotification', 'GSC/TET Supplier Notification']
];
function complete(review, group) {
  const value = group.split('.').reduce((current, key) => current?.[key], review);
  return value && ['approved', 'checked', 'prepared'].every((key) => value[key] === true);
}

class NotificationService {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.repository = options.repository;
    this.publicOrigin = options.publicOrigin || '';
    this.mailUrl = options.mailUrl || '';
    this.mailConfigurationStatus = options.mailConfigurationStatus;
  }

  async prepare(tx, before, proposed) {
    const updateSummary = meaningfulUpdate(before, proposed).join('; ');
    const prepared = await this.prepareAction(tx, before, proposed, updateSummary);
    if (!prepared.plan || prepared.record.mailRoutingPolicyVersion !== 2) return prepared;
    const update = await this.prepareUpdate(tx, prepared.record, prepared.plan, updateSummary);
    return { ...prepared, plan: { ...prepared.plan, update } };
  }

  async prepareUpdate(tx, record, actionPlan, updateSummary) {
    if (!updateSummary) return { queued: false, jobCount: 0, reason: 'no_change' };
    const configured = this.mailConfigurationStatus ? this.mailConfigurationStatus() === 'configured' : Boolean(this.mailUrl);
    if (!configured) return { queued: false, jobCount: 0, reason: 'mail_not_configured' };
    const excluded = new Set(actionPlan.queued ? actionPlan.payload.to.split(';').map(email => email.trim().toLowerCase()) : []);
    const users = await readGeneralNotificationUsers(tx);
    const audience = users.map(user => notificationRecipient(user, record)).filter(recipient => recipient && !excluded.has(recipient.email.toLowerCase()));
    const batches = batchRecipients(audience);
    if (!batches.length) return { queued: false, jobCount: 0, reason: 'no_verified_recipients' };
    try {
      const message = buildPcnUpdateNotificationMessage(record, { pcnUrl: this.pcnLink(record.id), updateSummary, status: record.status });
      return { queued: true, jobCount: batches.length, batches: batches.map(recipients => ({
        to: emailList(recipients.map(recipient => recipient.email).join('; ')), subject: `[PCN Update] ${record.id} - ${record.status}`,
        message, senderName: 'Supplier PCN Workflow', notificationKind: 'pcn_update', updateSnapshot: { pcnId: record.id, recipients }
      })) };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { queued: false, jobCount: 0, reason: 'notification_configuration_invalid' };
    }
  }

  async prepareAction(tx, before, proposed, updateSummary) {
    await lockUserMailRouting(tx);
    const rows = await tx.request().query('SELECT SettingsJson FROM pcn.NotificationSettings WITH (HOLDLOCK) WHERE Id=1');
    const settings = rows.recordset[0] ? JSON.parse(rows.recordset[0].SettingsJson) : {};
    const policy = before ? before.mailRoutingPolicyVersion || 1 : settings.schemaVersion === 2 ? 2 : 1;
    const policyRecord = { ...proposed, mailRoutingPolicyVersion: policy };
    if (settings.schemaVersion !== 2 || policy !== 2) return { record: policyRecord };
    proposed = policyRecord;
    const prior = before?.mailRoutingState;
    const changes = signoffChanges(before, proposed);
    const terminalCompletion = ['closed', 'rejected'].includes(proposed.status)
      && changes.completed.some(field => field.stageKey === 'qateFinal.signoff')
      && routeGroups(proposed.riskLevel).every(stage => complete(proposed.internalReview, stage));
    const preserveFinalNotice = ['closed', 'rejected'].includes(proposed.status)
      && prior?.groupKey === 'supplierNotification' && routeGroups(proposed.riskLevel).every(stage => complete(proposed.internalReview, stage));
    const target = resolveNextMailTarget(terminalCompletion || preserveFinalNotice ? { ...proposed, status: 'approved' } : proposed);
    const nextKey = target ? `${target.stageKey}:${target.action || 'notification'}` : '';
    const priorKey = prior ? `${prior.stageKey}:${prior.action || 'notification'}` : '';
    const submitted = proposed.status === 'submitted' && (!before || ['draft', 'supplier_action'].includes(before.status));
    const prerequisiteResolved = prior?.reason === 'tapbu_requirement_not_selected'
      && before?.internalReview?.tapbu?.need !== true && proposed.internalReview?.tapbu?.need === true;
    const prerequisiteInvalidated = target?.blockedReason && prior?.groupKey === target.groupKey && prior.reason !== target.blockedReason;
    const handoff = submitted || ((changes.completed.length > 0 || prerequisiteResolved) && !changes.invalidated);
    if (prior?.activationId && (priorKey !== nextKey || changes.invalidated || handoff || prerequisiteInvalidated)) {
      await tx.request().input('eventKey', sql.NVarChar(200), `${proposed.id}:${prior.activationId}:handoff`)
        .query("UPDATE pcn.NotificationJobs SET Status=N'cancelled',LastError=N'Pending signoff changed before sending' WHERE EventKey=@eventKey AND Status=N'pending'");
    }
    if (prerequisiteInvalidated && !handoff) {
      return { record: { ...proposed, mailRoutingState: { ...prior, status: 'blocked', reason: target.blockedReason } },
        plan: { queued: false, reason: target.blockedReason, nextGroupKey: target.groupKey, nextLabel: target.label } };
    }
    if (!target || !handoff) {
      const { mailRoutingState: omitted, ...withoutState } = proposed;
      const record = prior && priorKey === nextKey && !changes.invalidated ? proposed : withoutState;
      return { record, plan: { queued: false, reason: 'no_transition' } };
    }
    const assignments = await readUserMailAssignments(tx);
    let effective;
    try { effective = normalizeMailRouting(applyUserMailRouting(settings, assignments)); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { record: { ...proposed, mailRoutingState: { activationId: crypto.randomUUID(), stageKey: target.stageKey,
        action: target.action, groupKey: target.groupKey, status: 'blocked', reason: 'notification_configuration_invalid' } },
        plan: { queued: false, reason: 'notification_configuration_invalid', nextGroupKey: target.groupKey, nextLabel: target.label } };
    }
    const group = effective.groups.find(entry => entry.key === target.groupKey);
    const configured = this.mailConfigurationStatus ? this.mailConfigurationStatus() === 'configured' : Boolean(this.mailUrl);
    const reason = target.blockedReason || (!group?.effectiveEmails.trim() ? 'recipient_not_configured' : !configured ? 'mail_not_configured' : null);
    const state = { activationId: crypto.randomUUID(), stageKey: target.stageKey, action: target.action,
      groupKey: target.groupKey, routingVersion: effective.routingVersion, status: reason ? 'blocked' : 'pending', ...(reason ? { reason } : {}) };
    const record = { ...proposed, mailRoutingState: state };
    const summary = { queued: false, ...(reason ? { reason } : {}), nextGroupKey: target.groupKey, nextLabel: target.label };
    if (reason) return { record, plan: summary };
    const completed = submitted ? 'Supplier submission' : prerequisiteResolved ? 'TaPBU approval requirement selected' : describeCompletion(changes.completed.at(-1));
    try {
      const payload = { to: emailList(group.effectiveEmails), subject: `[Action Required] ${record.id} - ${target.label}`,
        message: buildWorkflowNotificationMessage(record, { completedGroup: completed, nextGroup: target.label,
          nextDepartment: departments.find(department => department.key === target.departmentKey)?.label,
          nextRole: target.action ? target.action[0].toUpperCase() + target.action.slice(1) : undefined,
          updateSummary, pcnUrl: this.pcnLink(record.id) }),
        senderName: 'Supplier PCN Workflow' };
      if (group.automaticRecipients.length) payload.routingSnapshot = { groupKey: group.key, manualEmails: group.emails,
        automaticRecipients: group.automaticRecipients.map(recipient => ({ userId: recipient.userId, email: recipient.email,
          department: target.departmentKey, signingStep: target.action, directoryId: recipient.id })) };
      return { record, plan: { ...summary, queued: true, payload,
        completedStage: submitted ? 'supplier_submission' : prerequisiteResolved ? 'tapbu_requirement' : changes.completed.at(-1).stageKey } };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { record: { ...record, mailRoutingState: { ...state, status: 'blocked', reason: 'notification_configuration_invalid' } },
        plan: { ...summary, queued: false, reason: 'notification_configuration_invalid' } };
    }
  }

  pcnLink(code) {
    if (!this.publicOrigin) return '';
    const origin = new URL(this.publicOrigin);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password) throw new ApiError(503, 'Public PCN origin is invalid');
    return new URL(`/form.html?id=${encodeURIComponent(code)}`, origin.origin).toString();
  }

  async persisted(tx, record, plan) {
    if (!plan) return plan;
    const actionRequired = await this.persistAction(tx, record, plan);
    const updatePlan = plan.update || { queued: false, jobCount: 0, reason: 'no_change' };
    let update = { queued: false, jobCount: 0, ...(updatePlan.reason ? { reason: updatePlan.reason } : {}) };
    if (updatePlan.queued) {
      this.assertSavedVersion(record);
      for (const [index, payload] of updatePlan.batches.entries()) {
        await this.insertJob(tx, record, `${record.id}:${record.version}:update:${index}`, 'pcn_update', 'pcn_update', payload);
      }
      update = { queued: true, jobCount: updatePlan.batches.length, status: 'pending' };
    }
    return { ...actionRequired, queued: Boolean(actionRequired.queued || update.queued), actionRequired, update };
  }

  assertSavedVersion(record) {
    if (!/^PCN-\d{4}-\d{4}$/.test(record.id) || !/^[0-9a-f]{16}$/i.test(record.version || '')) throw new ApiError(409, 'Saved PCN version is required');
  }

  async insertJob(tx, record, eventKey, completedStage, action, payload) {
    const result = await tx.request()
      .input('id', sql.UniqueIdentifier, crypto.randomUUID()).input('eventKey', sql.NVarChar(200), eventKey)
      .input('pcnId', sql.NVarChar(32), record.id).input('version', sql.NVarChar(16), record.version)
      .input('completedGroup', sql.NVarChar(50), completedStage).input('action', sql.NVarChar(30), action)
      .input('to', sql.NVarChar(1000), payload.to).input('payload', sql.NVarChar(sql.MAX), JSON.stringify(payload))
      .query(`IF NOT EXISTS (SELECT 1 FROM pcn.NotificationJobs WITH (UPDLOCK, HOLDLOCK) WHERE EventKey=@eventKey)
        INSERT pcn.NotificationJobs(Id,EventKey,PcnId,PcnVersion,CompletedGroup,Action,Recipient,PayloadJson)
        VALUES(@id,@eventKey,@pcnId,@version,@completedGroup,@action,@to,@payload);
        SELECT Id,Status FROM pcn.NotificationJobs WHERE EventKey=@eventKey;`);
    return result.recordset[0];
  }

  async persistAction(tx, record, plan) {
    if (!plan.queued) return { queued: false, ...(plan.reason ? { reason: plan.reason } : {}),
      ...(plan.nextGroupKey ? { nextGroupKey: plan.nextGroupKey, nextLabel: plan.nextLabel } : {}) };
    this.assertSavedVersion(record);
    const state = record.mailRoutingState;
    const result = await this.insertJob(tx, record, `${record.id}:${state.activationId}:handoff`, plan.completedStage,
      state.action || 'notification', plan.payload);
    return { queued: true, jobId: result.Id, status: result.Status, nextGroupKey: state.groupKey, nextLabel: plan.nextLabel };
  }

  async workflow(record, input = {}, user = {}) {
    if (input.to || input.pcnUrl) throw new ApiError(400, 'Notification recipient and link are configured by the server');
    // A stale browser must not duplicate a handoff already recorded by the save transaction.
    if (record.mailRoutingPolicyVersion === 2) return { queued: false, reason: 'handled_on_save' };
    const completedKey = input.completedGroupKey || groups.find(([key, label]) => input.completedGroup === key || input.completedGroup === label)?.[0];
    const route = groups.filter(([key]) => record.riskLevel !== 'RL0' || !key.startsWith('tapbu.'));
    const index = route.findIndex(([key]) => key === completedKey);
    if (index < 0 || index >= route.length - 1) throw new ApiError(400, 'Invalid completed notification group');
    if (!route.slice(0, index + 1).every(([key]) => complete(record.internalReview, key))) {
      throw new ApiError(409, 'All preceding signoff groups must be complete, including Checked');
    }
    const [nextGroupKey, nextLabel] = route[index + 1];
    if (input.nextGroupKey && input.nextGroupKey !== nextGroupKey) throw new ApiError(400, 'Invalid next notification group');
    const tx = this.pool.transaction();
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      await lockUserMailRouting(tx);
      await assertCurrentUser(tx, user.id ? user : undefined);
      const result = await this.queueLegacy(tx, record, user, { completedKey, nextGroupKey, nextLabel, completedLabel: route[index][1] });
      await tx.commit();
      return result;
    } catch (error) {
      try { await tx.rollback(); } catch { /* Preserve the original database error. */ }
      throw error;
    }
  }

  async queueLegacy(tx, record, user, { completedKey, nextGroupKey, nextLabel, completedLabel }) {
    const settingsRows = await tx.request().query('SELECT SettingsJson FROM pcn.NotificationSettings WITH(HOLDLOCK) WHERE Id=1');
    const settings = settingsRows.recordset[0] ? JSON.parse(settingsRows.recordset[0].SettingsJson) : {};
    const recipients = settings.schemaVersion === 2 ? settings.legacyGroups : settings.groups;
    const configured = (recipients || []).find((group) => group.key === nextGroupKey)?.emails;
    if (!configured) return { queued: false, reason: 'recipient_not_configured', nextGroupKey };
    const to = emailList(configured);
    if (!this.mailUrl) return { queued: false, reason: 'mail_not_configured', nextGroupKey };
    if (!/^PCN-\d{4}-\d{4}$/.test(record.id) || !/^[0-9a-f]{16}$/i.test(record.version || '')) throw new ApiError(409, 'Saved PCN version is required');
    const payload = { to, subject: `[PCN] ${record.id} - ${completedLabel} completed`,
      message: buildWorkflowNotificationMessage(record, { completedGroup: completedLabel, nextGroup: nextLabel, pcnUrl: this.pcnLink(record.id) }),
      senderName: typeof user.displayName === 'string' ? user.displayName.slice(0, 120) : 'Supplier PCN Workflow' };
    const eventKey = `${record.id}:${record.version}:${completedKey}:completed`;
    if (user.id) {
      const current = await tx.request().input('code', sql.NVarChar(32), record.id)
        .query('SELECT RowVersion FROM pcn.PcnRequests WITH(HOLDLOCK) WHERE PcnCode=@code AND DeletedAt IS NULL');
      if (Buffer.from(current.recordset[0]?.RowVersion || []).toString('hex') !== record.version) throw new ApiError(409, 'PCN changed before notification; reload');
    }
    const result = await tx.request()
      .input('id', sql.UniqueIdentifier, crypto.randomUUID()).input('eventKey', sql.NVarChar(200), eventKey)
      .input('pcnId', sql.NVarChar(32), record.id).input('version', sql.NVarChar(16), record.version)
      .input('completedGroup', sql.NVarChar(50), completedKey).input('action', sql.NVarChar(30), 'completed')
      .input('to', sql.NVarChar(1000), to).input('payload', sql.NVarChar(sql.MAX), JSON.stringify(payload))
      .query(`IF NOT EXISTS (SELECT 1 FROM pcn.NotificationJobs WITH (UPDLOCK, HOLDLOCK) WHERE EventKey=@eventKey)
          INSERT pcn.NotificationJobs(Id,EventKey,PcnId,PcnVersion,CompletedGroup,Action,Recipient,PayloadJson)
          VALUES(@id,@eventKey,@pcnId,@version,@completedGroup,@action,@to,@payload);
        SELECT Id,Status FROM pcn.NotificationJobs WHERE EventKey=@eventKey;`);
    return { queued: true, jobId: result.recordset[0].Id, status: result.recordset[0].Status, nextGroupKey };
  }
}

function signoffChanges(before, after) {
  const at = (record, stage, action) => stage.split('.').reduce((value, key) => value?.[key], record?.internalReview)?.[action] === true;
  const fields = routeGroups(after.riskLevel).flatMap(stageKey => actions.map(action => ({ stageKey, action })));
  return {
    completed: fields.filter(field => !at(before, field.stageKey, field.action) && at(after, field.stageKey, field.action)),
    invalidated: fields.some(field => at(before, field.stageKey, field.action) && !at(after, field.stageKey, field.action))
  };
}

function describeCompletion(field) {
  const label = legacyDefinitions.find(group => group.key === field.stageKey)?.label || field.stageKey;
  return `${label} ${field.action[0].toUpperCase()}${field.action.slice(1)} completed`;
}

module.exports = { NotificationService };
