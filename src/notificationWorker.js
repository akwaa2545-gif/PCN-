const crypto = require('node:crypto');
const sql = require('mssql');
const { lockUserMailRouting, filterPendingRecipients } = require('./userMailRouting');
const { filterPendingUpdates, notificationRecipient } = require('./notificationUpdates');
const { actions, resolveNextMailTarget, legacyDefinitions } = require('./mailRouting');
const { routeGroups } = require('./workflowAccess');
const { readNotificationSettings, readPreferenceUsers, defaultRoutingRecipients, filteredPreferenceMail,
  validBatchEvent } = require('./notificationPreferenceRuntime');

function currentAction(payload, job, row) {
  if (!row) return false;
  const extra = JSON.parse(row.LegacyExtrasJson || '{}');
  const review = JSON.parse(row.ReviewJson || '{}');
  const state = extra.mailRoutingState;
  const snapshot = payload.actionSnapshot;
  if (extra.mailRoutingPolicyVersion !== 2 || state?.signingOrderVersion !== 2 || state.status !== 'pending'
    || snapshot?.signingOrderVersion !== 2 || !state.activationId) return false;
  const finalNotice = state.groupKey === 'supplierNotification' && ['closed', 'rejected'].includes(row.Status)
    && routeGroups(row.RiskLevel, review).every(stage => {
      const step = stage.split('.').reduce((value, key) => value?.[key], review);
      return actions.every(action => step?.[action] === true);
    });
  const target = resolveNextMailTarget({ ...extra, id: row.PcnCode, status: finalNotice ? 'approved' : row.Status,
    riskLevel: row.RiskLevel, internalReview: review });
  return Boolean(target && !target.blockedReason && snapshot.pcnId === job.PcnId && row.PcnCode === job.PcnId
    && snapshot.activationId === state.activationId && validBatchEvent(`${job.PcnId}:${state.activationId}:handoff`, job, payload)
    && job.Action === (target.action || 'notification')
    && ['stageKey', 'action', 'groupKey'].every(key => snapshot[key] === target[key] && state[key] === target[key]));
}

class NotificationWorker {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.integrationService = options.integrationService;
    this.reviewDeadlineNotifications = options.reviewDeadlineNotifications;
    this.clock = options.clock || (() => new Date());
    this.lastCheck = { lastCheckedAt: null, lastOutcome: null };
  }

  async runOnce() {
    try {
      const result = await this.processNext();
      this.lastCheck = { lastCheckedAt: this.clock().toISOString(), lastOutcome: result.status === 'sent' ? 'accepted' : result.status };
      return result;
    } catch (error) {
      this.lastCheck = { lastCheckedAt: this.clock().toISOString(), lastOutcome: 'error' };
      throw error;
    }
  }

  async processNext() {
    const claimToken = crypto.randomUUID();
    const job = await this.claim(claimToken);
    if (!job) return { status: 'idle' };
    if (job.cancelled) return { jobId: job.Id, status: 'cancelled' };
    let status = 'sent';
    let errorMessage = null;
    try { await this.integrationService.sendMail(job.payload); }
    catch { status = 'uncertain'; errorMessage = 'Mail delivery outcome is unknown; operator review required'; }
    await this.pool.request().input('id', sql.UniqueIdentifier, job.Id).input('token', sql.UniqueIdentifier, claimToken)
      .input('status', sql.NVarChar(20), status).input('error', sql.NVarChar(1000), errorMessage)
      .query(`UPDATE pcn.NotificationJobs SET Status=@status,LastError=@error,
        SentAt=CASE WHEN @status=N'sent' THEN SYSUTCDATETIME() ELSE NULL END,LeaseExpiresAt=NULL
        WHERE Id=@id AND ClaimToken=@token AND Status=N'sending';`);
    return { jobId: job.Id, status };
  }

  async claim(claimToken) {
    const tx = this.pool.transaction();
    await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    try {
      // Saves lock routing before the PCN and outbox. Exclusive mode keeps the
      // authoritative PCN check from reversing that lock order during claims.
      await lockUserMailRouting(tx, 'Exclusive');
      // Expired leases are ambiguous; never return them to the pending queue.
      const result = await tx.request().query(`UPDATE pcn.NotificationJobs SET Status=N'uncertain',
        LastError=N'Worker lease expired; operator review required' WHERE Status=N'sending' AND LeaseExpiresAt<SYSUTCDATETIME();
        SELECT TOP(1) Id,PayloadJson,PcnId,PcnVersion,CompletedGroup,Action,EventKey FROM pcn.NotificationJobs WITH(UPDLOCK,READPAST,ROWLOCK)
        WHERE Status=N'pending' ORDER BY CreatedAt,Id;`);
      const row = result.recordset[0];
      if (!row) { await tx.commit(); return null; }
      const savedPayload = JSON.parse(row.PayloadJson);
      const settings = await readNotificationSettings(tx);
      let payload;
      let staleAction = false;
      if (savedPayload.notificationKind !== undefined && !['review_deadline', 'pcn_update'].includes(savedPayload.notificationKind)) {
        payload = {}; staleAction = true;
      } else if (savedPayload.notificationKind === 'review_deadline') {
        payload = this.reviewDeadlineNotifications
          ? await this.reviewDeadlineNotifications.prepareClaim(tx, row, savedPayload, this.clock()) : null;
        staleAction = !payload;
        payload = payload || {};
      } else if (savedPayload.notificationKind === 'pcn_update') {
        const current = await tx.request().input('code', sql.NVarChar(32), row.PcnId)
          .query('SELECT PcnCode,OwnerUserId FROM pcn.PcnRequests WITH(HOLDLOCK) WHERE PcnCode=@code AND DeletedAt IS NULL');
        const currentRow = current.recordset[0];
        const record = currentRow ? { id: currentRow.PcnCode, ownerUserId: currentRow.OwnerUserId } : null;
        const users = await readPreferenceUsers(tx, settings);
        const scope = Array.isArray(savedPayload.updateSnapshot?.departmentKeys) ? savedPayload.updateSnapshot.departmentKeys : [];
        const defaults = users.map(user => notificationRecipient(user, record, scope)).filter(Boolean);
        const snapshot = savedPayload.notificationPreferenceSnapshot;
        const legacy = snapshot ? savedPayload : filterPendingUpdates(savedPayload, users, record);
        const types = snapshot ? [snapshot.type] : ['submitted', 'updated', 'completed'];
        const valid = row.PcnId === savedPayload.updateSnapshot?.pcnId && (!snapshot || (types.every(type => ['submitted', 'updated', 'completed'].includes(type))
          && Number.isSafeInteger(snapshot.batchIndex) && snapshot.batchIndex >= 0 && snapshot.batchIndex <= 9999
          && row.PcnId === savedPayload.updateSnapshot?.pcnId
          && row.EventKey === `${row.PcnId}:${row.PcnVersion}:update:${snapshot.batchIndex}`));
        payload = valid ? this.filterPreferences(settings, types, legacy, { record, users, defaultRecipients: defaults }) : null;
        staleAction = !payload; payload = payload || {};
      } else {
        const current = await tx.request().input('code', sql.NVarChar(32), row.PcnId)
            .query(`SELECT p.PcnCode,p.Status,p.RiskLevel,p.OwnerUserId,p.LegacyExtrasJson,r.ReviewJson
              FROM pcn.PcnRequests p WITH(HOLDLOCK) LEFT JOIN pcn.PcnInternalReviews r WITH(HOLDLOCK) ON r.PcnId=p.PcnId
              WHERE p.PcnCode=@code AND p.DeletedAt IS NULL`);
        const currentRow = current.recordset[0];
        const record = currentRow ? { ...JSON.parse(currentRow.LegacyExtrasJson || '{}'), id: currentRow.PcnCode,
          status: currentRow.Status, riskLevel: currentRow.RiskLevel, ownerUserId: currentRow.OwnerUserId,
          internalReview: JSON.parse(currentRow.ReviewJson || '{}') } : null;
        const users = await readPreferenceUsers(tx, settings);
        if (savedPayload.actionSnapshot || ['prepared', 'checked', 'approved', 'notification'].includes(row.Action)) {
          staleAction = !currentAction(savedPayload, row, currentRow);
        }
        const key = savedPayload.actionSnapshot?.groupKey;
        const defaults = key ? defaultRoutingRecipients(settings, users, key)
          : this.legacyRecipients(settings, row.CompletedGroup, record, savedPayload.legacyRoutingSnapshot?.nextGroupKey);
        if (!key && savedPayload.notificationPreferenceSnapshot && !validBatchEvent(
          `${row.PcnId}:${row.PcnVersion}:${row.CompletedGroup}:completed`, row, savedPayload)) staleAction = true;
        const candidate = savedPayload.notificationPreferenceSnapshot ? savedPayload : filterPendingRecipients(savedPayload, users);
        payload = !staleAction && record && (!savedPayload.notificationPreferenceSnapshot
          || savedPayload.notificationPreferenceSnapshot.type === 'actionRequired')
          ? this.filterPreferences(settings, ['actionRequired'], candidate, { record, users, defaultRecipients: defaults }) : null;
        staleAction = staleAction || !payload; payload = payload || {};
      }
      const cancelled = staleAction || Boolean((savedPayload.routingSnapshot || savedPayload.notificationKind === 'pcn_update') && !payload.to);
      await tx.request().input('id', sql.UniqueIdentifier, row.Id).input('token', sql.UniqueIdentifier, claimToken)
        .input('recipient', sql.NVarChar(1000), payload.to || '').input('payload', sql.NVarChar(sql.MAX), JSON.stringify(payload))
        .query(cancelled
          ? "UPDATE pcn.NotificationJobs SET Status=N'cancelled',LastError=N'Workflow target or assigned recipients changed before sending' WHERE Id=@id AND Status=N'pending'"
          : `UPDATE pcn.NotificationJobs SET Status=N'sending',Attempts=Attempts+1,ClaimedAt=SYSUTCDATETIME(),
            LeaseExpiresAt=DATEADD(second,60,SYSUTCDATETIME()),ClaimToken=@token,Recipient=@recipient,PayloadJson=@payload
            WHERE Id=@id AND Status=N'pending'`);
      await tx.commit();
      // Account changes after the committed claim do not recall an in-flight send.
      const mail = { to: payload.to, subject: payload.subject, message: payload.message, senderName: payload.senderName };
      return { Id: row.Id, payload: mail, cancelled };
    } catch (error) {
      try { await tx.rollback(); } catch { /* Preserve the original database error. */ }
      throw error;
    }
  }

  filterPreferences(settings, types, payload, context) {
    try { return filteredPreferenceMail(settings, types, payload, context); }
    catch (error) { if (error.statusCode === 400 || error.statusCode === 503) return null; throw error; }
  }

  legacyRecipients(settings, completedGroup, record, savedKey) {
    if (!record) return [];
    const route = [...routeGroups(record.riskLevel, record.internalReview), 'supplierNotification'];
    const next = route[route.indexOf(completedGroup) + 1];
    if (savedKey && savedKey !== next) return [];
    if (!legacyDefinitions.some(group => group.key === next)) return [];
    const groups = settings.schemaVersion === 2 ? settings.legacyGroups : settings.groups;
    return [groups?.find(group => group.key === next)?.emails || ''];
  }

  async health() {
    const result = await this.pool.request().query(`SELECT
      COALESCE(SUM(CASE WHEN Status=N'pending' THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN Status=N'sending' THEN 1 ELSE 0 END),0) AS sending,
      COALESCE(SUM(CASE WHEN Status=N'sent' THEN 1 ELSE 0 END),0) AS accepted,
      COALESCE(SUM(CASE WHEN Status=N'uncertain' THEN 1 ELSE 0 END),0) AS uncertain,
      MAX(CASE WHEN Status=N'sent' THEN SentAt ELSE NULL END) AS latestAcceptedAt
      FROM pcn.NotificationJobs;`);
    const totals = result.recordset[0] || {};
    return { worker: { ...this.lastCheck }, queue: {
      pending: totals.pending || 0, sending: totals.sending || 0,
      accepted: totals.accepted || 0, uncertain: totals.uncertain || 0,
      latestAcceptedAt: totals.latestAcceptedAt ? totals.latestAcceptedAt.toISOString() : null
    } };
  }

  async status() {
    const result = await this.pool.request().query(`SELECT TOP(100) Id,PcnId,PcnVersion,CompletedGroup,Action,Status,Attempts,CreatedAt,SentAt,LastError
      FROM pcn.NotificationJobs ORDER BY CreatedAt DESC`);
    return result.recordset;
  }
}

module.exports = { NotificationWorker };
