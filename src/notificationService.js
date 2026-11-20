const crypto = require('node:crypto');
const sql = require('mssql');
const { ApiError } = require('./apiError');
const { emailList } = require('./integrationService');
const { buildWorkflowNotificationMessage, buildPcnUpdateNotificationMessage } = require('./notificationTemplate');
const { meaningfulUpdate, notificationDepartmentKeys, notificationRecipient } = require('./notificationUpdates');
const { actions, departments, legacyDefinitions, normalizeMailRouting, resolveNextMailTarget, settingsVersion } = require('./mailRouting');
const { routeGroups } = require('./workflowAccess');
const { lockUserMailRouting, readUserMailAssignments, assertCurrentUser } = require('./userMailRouting');
const { isCode, typeOf, peLabel } = require('../pcn-types');
const { classifyNotification } = require('./notificationPreferences');
const { readNotificationSettings, readPreferenceUsers, defaultRoutingRecipients, preferenceBatches, batchEventKey } = require('./notificationPreferenceRuntime');

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
const notificationSubject = (record, subject) => record.isTestDocument === true ? `[TESTING DOC] ${subject}` : subject;

class NotificationService {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.repository = options.repository;
    this.publicOrigin = options.publicOrigin || '';
    this.mailUrl = options.mailUrl || '';
    this.mailConfigurationStatus = options.mailConfigurationStatus;
  }

  async prepare(tx, before, proposed) {
    await lockUserMailRouting(tx);
    const settings = await readNotificationSettings(tx);
    const updateSummary = meaningfulUpdate(before, proposed).join('; ');
    const prepared = await this.prepareAction(tx, before, proposed, updateSummary, settings);
    if (!prepared.plan || prepared.record.mailRoutingPolicyVersion !== 2) return prepared;
    const update = await this.prepareUpdate(tx, prepared.record, prepared.plan, updateSummary, before, settings);
    return { ...prepared, plan: { ...prepared.plan, update } };
  }

  async prepareUpdate(tx, record, actionPlan, updateSummary, before, settings) {
    if (!updateSummary) return { queued: false, jobCount: 0, reason: 'no_change' };
    const configured = this.mailConfigurationStatus ? this.mailConfigurationStatus() === 'configured' : Boolean(this.mailUrl);
    if (!configured) return { queued: false, jobCount: 0, reason: 'mail_not_configured' };
    if (settings === undefined) { await lockUserMailRouting(tx); settings = await readNotificationSettings(tx); }
    const excluded = new Set(actionPlan.queued ? (actionPlan.batches || [actionPlan.payload])
      .flatMap(payload => payload.to.split(';').map(email => email.trim().toLowerCase())) : []);
    const departmentKeys = notificationDepartmentKeys(before, record);
    const users = await readPreferenceUsers(tx, settings);
    const audience = users.map(user => notificationRecipient(user, record, departmentKeys)).filter(Boolean);
    try {
      const message = buildPcnUpdateNotificationMessage(record, { pcnUrl: this.pcnLink(record.id), updateSummary, status: record.status });
      const selected = preferenceBatches(settings, classifyNotification(before, record), { record, users, defaultRecipients: audience }, {
        subject: notificationSubject(record, `[PCN Update] ${record.id} - ${record.status}`),
        message, senderName: 'Supplier PCN Workflow', notificationKind: 'pcn_update', updateSnapshot: {
          pcnId: record.id, audiencePolicyVersion: 1, departmentKeys }
      });
      if (!selected.enabled) return { queued: false, jobCount: 0, reason: selected.reason };
      const batches = selected.batches.flatMap(payload => {
        const recipients = payload.notificationPreferenceSnapshot.recipients.filter(recipient => !excluded.has(recipient.email.toLowerCase()));
        return recipients.length ? [{ ...payload, to: emailList(recipients.map(recipient => recipient.email).join('; ')),
          notificationPreferenceSnapshot: { ...payload.notificationPreferenceSnapshot, recipients },
          updateSnapshot: { ...payload.updateSnapshot, recipients } }] : [];
      }).map((payload, batchIndex) => ({ ...payload,
        notificationPreferenceSnapshot: { ...payload.notificationPreferenceSnapshot, batchIndex } }));
      return batches.length ? { queued: true, jobCount: batches.length, batches }
        : { queued: false, jobCount: 0, reason: 'no_verified_recipients' };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { queued: false, jobCount: 0, reason: 'notification_configuration_invalid' };
    }
  }

  async prepareAction(tx, before, proposed, updateSummary, settings) {
    if (settings === undefined) { await lockUserMailRouting(tx); settings = await readNotificationSettings(tx); }
    const policy = settings.schemaVersion === 2 || typeOf(proposed) ? 2 : before?.mailRoutingPolicyVersion || 1;
    const adoptingCurrentRouting = Boolean(before && (before.mailRoutingPolicyVersion || 1) !== 2 && policy === 2);
    const policyRecord = { ...proposed, mailRoutingPolicyVersion: policy };
    if (policy !== 2 || (settings.schemaVersion !== 2 && !Object.hasOwn(settings, 'notificationPreferences'))) return { record: policyRecord,
      ...(typeOf(proposed) ? { plan: { queued: false, reason: 'notification_configuration_invalid' } } : {}) };
    proposed = policyRecord;
    const prior = before?.mailRoutingState;
    const adoptingSigningOrder = Boolean(before && prior?.signingOrderVersion !== 2);
    const changes = signoffChanges(before, proposed);
    const terminalCompletion = ['closed', 'rejected'].includes(proposed.status)
      && changes.completed.some(field => field.stageKey === 'qateFinal.signoff')
      && routeGroups(proposed.riskLevel, proposed.internalReview).every(stage => complete(proposed.internalReview, stage));
    const preserveFinalNotice = ['closed', 'rejected'].includes(proposed.status)
      && prior?.groupKey === 'supplierNotification' && routeGroups(proposed.riskLevel, proposed.internalReview).every(stage => complete(proposed.internalReview, stage));
    const target = resolveNextMailTarget(terminalCompletion || preserveFinalNotice ? { ...proposed, status: 'approved' } : proposed);
    const nextKey = target ? `${target.stageKey}:${target.action || 'notification'}` : '';
    const priorKey = prior ? `${prior.stageKey}:${prior.action || 'notification'}` : '';
    const submitted = proposed.status === 'submitted' && (!before || ['draft', 'supplier_action'].includes(before.status));
    const prerequisiteResolved = prior?.reason === 'tapbu_requirement_not_selected'
      && before?.internalReview?.tapbu?.need !== true && proposed.internalReview?.tapbu?.need === true;
    const prerequisiteInvalidated = target?.blockedReason && prior?.groupKey === target.groupKey && prior.reason !== target.blockedReason;
    const currentActionActivated = (adoptingCurrentRouting || adoptingSigningOrder) && target
      && !['approved', 'rejected', 'closed'].includes(proposed.status) && !changes.invalidated;
    const handoff = submitted || ((changes.completed.length > 0 || prerequisiteResolved || currentActionActivated) && !changes.invalidated);
    if (currentActionActivated) {
      await tx.request().input('pcnId', sql.NVarChar(32), proposed.id)
        .query("UPDATE pcn.NotificationJobs SET Status=N'cancelled',LastError=N'Current signing order replaced pending notification' WHERE PcnId=@pcnId AND (Action=N'completed' OR Action IN (N'prepared',N'checked',N'approved',N'notification')) AND Status=N'pending'");
    }
    if (prior?.activationId && (priorKey !== nextKey || changes.invalidated || handoff || prerequisiteInvalidated)) {
      await tx.request().input('eventKey', sql.NVarChar(200), `${proposed.id}:${prior.activationId}:handoff`)
        .query("UPDATE pcn.NotificationJobs SET Status=N'cancelled',LastError=N'Pending signoff changed before sending' WHERE (EventKey=@eventKey OR EventKey LIKE @eventKey+N':batch:%') AND Status=N'pending'");
    }
    if (prerequisiteInvalidated && !handoff) {
      return { record: { ...proposed, mailRoutingState: { ...prior, status: 'blocked', reason: target.blockedReason } },
        plan: { queued: false, reason: target.blockedReason, nextGroupKey: target.groupKey, nextLabel: target.label } };
    }
    if (!target || !handoff) {
      const { mailRoutingState: omitted, ...withoutState } = proposed;
      const retainedOrder = target && !['approved', 'rejected', 'closed'].includes(proposed.status)
        ? { ...withoutState, mailRoutingState: { signingOrderVersion: 2 } } : withoutState;
      const record = prior && priorKey === nextKey && !changes.invalidated ? proposed : retainedOrder;
      return { record, plan: { queued: false, reason: 'no_transition' } };
    }
    const assignments = await readUserMailAssignments(tx);
    let effective;
    try { effective = { ...normalizeMailRouting(settings), routingVersion: settingsVersion({ settings, assignments }) }; }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { record: { ...proposed, mailRoutingState: { signingOrderVersion: 2, activationId: crypto.randomUUID(), stageKey: target.stageKey,
        action: target.action, groupKey: target.groupKey, status: 'blocked', reason: 'notification_configuration_invalid' } },
        plan: { queued: false, reason: 'notification_configuration_invalid', nextGroupKey: target.groupKey, nextLabel: target.label } };
    }
    const group = effective.groups.find(entry => entry.key === target.groupKey);
    const configured = this.mailConfigurationStatus ? this.mailConfigurationStatus() === 'configured' : Boolean(this.mailUrl);
    const reason = target.blockedReason || (!configured ? 'mail_not_configured' : null);
    const state = { signingOrderVersion: 2, activationId: crypto.randomUUID(), stageKey: target.stageKey, action: target.action,
      groupKey: target.groupKey, routingVersion: effective.routingVersion, status: reason ? 'blocked' : 'pending', ...(reason ? { reason } : {}) };
    const record = { ...proposed, mailRoutingState: state };
    const summary = { queued: false, ...(reason ? { reason } : {}), nextGroupKey: target.groupKey, nextLabel: target.label };
    if (reason) return { record, plan: summary };
    const completed = submitted ? 'Supplier submission' : prerequisiteResolved ? 'TaPBU approval requirement selected'
      : changes.completed.length ? describeCompletion(changes.completed.at(-1), record) : 'Current workflow routing activated';
    try {
      const payload = { subject: notificationSubject(record, `[Action Required] ${record.id} - ${target.label}`),
        message: buildWorkflowNotificationMessage(record, { completedGroup: completed, nextGroup: target.label,
          nextDepartment: departments.find(department => department.key === target.departmentKey)?.label,
          nextRole: target.action ? target.action[0].toUpperCase() + target.action.slice(1) : undefined,
          updateSummary, pcnUrl: this.pcnLink(record.id) }),
        senderName: 'Supplier PCN Workflow', actionSnapshot: { signingOrderVersion: 2, pcnId: record.id,
          activationId: state.activationId, stageKey: target.stageKey, action: target.action, groupKey: target.groupKey } };
      const defaults = defaultRoutingRecipients(settings, assignments, target.groupKey);
      const automatic = defaults.filter(recipient => typeof recipient !== 'string');
      if (automatic.length) payload.routingSnapshot = { groupKey: group.key, manualEmails: group.emails,
        automaticRecipients: automatic };
      const users = await readPreferenceUsers(tx, settings);
      const selected = preferenceBatches(settings, 'actionRequired', { record, users,
        defaultRecipients: defaults }, payload);
      if (!selected.batches.length) return { record: { ...record, mailRoutingState: { ...state, status: 'blocked', reason: selected.reason } },
        plan: { ...summary, reason: selected.reason } };
      return { record, plan: { ...summary, queued: true, payload: selected.batches[0], batches: selected.batches,
        completedStage: submitted ? 'supplier_submission' : prerequisiteResolved ? 'tapbu_requirement'
          : changes.completed.at(-1)?.stageKey || 'routing_activation' } };
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
    if (!isCode(record.id) || !/^[0-9a-f]{16}$/i.test(record.version || '')) throw new ApiError(409, 'Saved PCN version is required');
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
    const batches = plan.batches || [plan.payload];
    const results = [];
    for (const [index, payload] of batches.entries()) results.push(await this.insertJob(tx, record,
      batchEventKey(`${record.id}:${state.activationId}:handoff`, index), plan.completedStage, state.action || 'notification', payload));
    const result = results[0];
    return { queued: true, jobId: result.Id, status: result.Status, nextGroupKey: state.groupKey, nextLabel: plan.nextLabel };
  }

  async workflow(record, input = {}, user = {}) {
    if (input.to || input.pcnUrl) throw new ApiError(400, 'Notification recipient and link are configured by the server');
    // A stale browser must not duplicate a handoff already recorded by the save transaction.
    if (record.mailRoutingPolicyVersion === 2 || typeOf(record)) return { queued: false, reason: 'handled_on_save' };
    const completedKey = input.completedGroupKey || groups.find(([key, label]) => input.completedGroup === key || input.completedGroup === label)?.[0];
    const effectiveGroups = [...routeGroups(record.riskLevel, record.internalReview), 'supplierNotification'];
    const route = groups.filter(([key]) => effectiveGroups.includes(key));
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
    if (typeOf(record)) throw new ApiError(400, 'Typed PCNs require signing-step notification routing');
    const settingsRows = await tx.request().query('SELECT SettingsJson FROM pcn.NotificationSettings WITH(HOLDLOCK) WHERE Id=1');
    const settings = settingsRows.recordset[0] ? JSON.parse(settingsRows.recordset[0].SettingsJson) : {};
    const recipients = settings.schemaVersion === 2 ? settings.legacyGroups : settings.groups;
    const configured = (recipients || []).find((group) => group.key === nextGroupKey)?.emails;
    if (!configured && !Object.hasOwn(settings, 'notificationPreferences')) return { queued: false, reason: 'recipient_not_configured', nextGroupKey };
    if (!this.mailUrl) return { queued: false, reason: 'mail_not_configured', nextGroupKey };
    if (!isCode(record.id) || !/^[0-9a-f]{16}$/i.test(record.version || '')) throw new ApiError(409, 'Saved PCN version is required');
    const payload = { subject: notificationSubject(record, `[PCN] ${record.id} - ${completedLabel} completed`),
      message: buildWorkflowNotificationMessage(record, { completedGroup: completedLabel, nextGroup: nextLabel, pcnUrl: this.pcnLink(record.id) }),
      senderName: typeof user.displayName === 'string' ? user.displayName.slice(0, 120) : 'Supplier PCN Workflow',
      legacyRoutingSnapshot: { nextGroupKey } };
    const eventKey = `${record.id}:${record.version}:${completedKey}:completed`;
    if (user.id) {
      const current = await tx.request().input('code', sql.NVarChar(32), record.id)
        .query('SELECT RowVersion FROM pcn.PcnRequests WITH(HOLDLOCK) WHERE PcnCode=@code AND DeletedAt IS NULL');
      if (Buffer.from(current.recordset[0]?.RowVersion || []).toString('hex') !== record.version) throw new ApiError(409, 'PCN changed before notification; reload');
    }
    const users = await readPreferenceUsers(tx, settings);
    const selected = preferenceBatches(settings, 'actionRequired', { record, users, defaultRecipients: configured || '' }, payload);
    if (!selected.batches.length) return { queued: false, reason: selected.reason, nextGroupKey };
    const results = [];
    for (const [index, batch] of selected.batches.entries()) results.push(await this.insertJob(tx, record,
      batchEventKey(eventKey, index), completedKey, 'completed', batch));
    return { queued: true, jobId: results[0].Id, status: results[0].Status, nextGroupKey };
  }
}

function signoffChanges(before, after) {
  const at = (record, stage, action) => stage.split('.').reduce((value, key) => value?.[key], record?.internalReview)?.[action] === true;
  const fields = routeGroups(after.riskLevel, after.internalReview).flatMap(stageKey => actions.map(action => ({ stageKey, action })));
  return {
    completed: fields.filter(field => !at(before, field.stageKey, field.action) && at(after, field.stageKey, field.action)),
    invalidated: fields.some(field => at(before, field.stageKey, field.action) && !at(after, field.stageKey, field.action))
  };
}

function describeCompletion(field, record) {
  const label = field.stageKey === 'signoff.prodEngTet' ? peLabel(record)
    : legacyDefinitions.find(group => group.key === field.stageKey)?.label || field.stageKey;
  return `${label} ${field.action[0].toUpperCase()}${field.action.slice(1)} completed`;
}

module.exports = { NotificationService };
