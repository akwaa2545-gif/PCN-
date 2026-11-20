const sql = require('mssql');
const { ApiError } = require('./apiError');
const { activeReviewDeadline } = require('./reviewTiming');
const { resolveNextMailTarget } = require('./mailRouting');
const { lockUserMailRouting, readUserMailAssignments } = require('./userMailRouting');
const { versionHex } = require('./sqlPcnHydration');
const { buildReviewDeadlineNotificationMessage } = require('./notificationTemplate');
const { SqlWorkflowSettings } = require('./sqlWorkflowSettings');
const { isCode } = require('../pcn-types');
const { readNotificationSettings, readPreferenceUsers, defaultRoutingRecipients, preferenceBatches,
  batchEventKey, validBatchEvent, filteredPreferenceMail } = require('./notificationPreferenceRuntime');

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const projection = 'p.PcnCode,p.RowVersion,p.Status,p.RiskLevel,p.OwnerUserId,p.SupplierName,p.MaterialName,p.LegacyExtrasJson,r.ReviewJson';

function persistedRecord(row) {
  if (!row) return null;
  return { ...JSON.parse(row.LegacyExtrasJson || '{}'), id: row.PcnCode, version: versionHex(row.RowVersion),
    status: row.Status, riskLevel: row.RiskLevel, ownerUserId: row.OwnerUserId, supplierName: row.SupplierName, materialName: row.MaterialName,
    internalReview: JSON.parse(row.ReviewJson || '{}') };
}

function deadlinePlan(record, now, settings) {
  if (record?.mailRoutingPolicyVersion !== 2) return null;
  const deadline = activeReviewDeadline(record, now, settings);
  if (!deadline || deadline.source !== 'handoff') return null;
  const target = resolveNextMailTarget(record);
  if (!target || target.blockedReason || target.stageKey !== deadline.stageKey) return null;
  const kind = deadline.overdue ? 'overdue' : now.getTime() >= Date.parse(deadline.dueAt) - DAY_MS ? 'due_soon' : null;
  if (!kind) return null;
  const snapshot = { pcnId: record.id, stageKey: deadline.stageKey, department: deadline.department, startedAt: deadline.startedAt, dueAt: deadline.dueAt, kind };
  // Retain the original three-day Prod/QA keys so previously delivered notices
  // remain deduplicated across this upgrade. Other schedules include their due date.
  const legacy = ['prodEngTet', 'qaTet'].includes(deadline.department)
    && Date.parse(deadline.dueAt) - Date.parse(deadline.startedAt) === 3 * DAY_MS;
  const identity = legacy ? `${deadline.department}:${deadline.startedAt}` : `${deadline.stageKey}:${deadline.startedAt}:${deadline.dueAt}`;
  return { deadline, target, kind, snapshot, legacy, eventKey: `${record.id}:review:${identity}:${kind}` };
}

class ReviewDeadlineNotifications {
  constructor(pool, { notificationService, clock = () => new Date(), workflowSettings = new SqlWorkflowSettings(pool) } = {}) {
    this.pool = pool;
    this.notificationService = notificationService;
    this.clock = clock;
    this.workflowSettings = workflowSettings;
    this.after = '';
  }

  async queueDue() {
    const now = this.clock();
    const settings = await this.workflowSettings.get();
    let scanned = 0;
    let queued = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      // This bounded projection does not acquire write locks or hydrate attachment/history children.
      const rows = await this.pool.request().input('after', sql.NVarChar(32), this.after).input('pageSize', sql.Int, PAGE_SIZE)
        .query(`SELECT TOP(@pageSize) ${projection} FROM pcn.PcnRequests p
          LEFT JOIN pcn.PcnInternalReviews r ON r.PcnId=p.PcnId
          WHERE p.PcnCode>@after AND p.DeletedAt IS NULL
            AND p.Status NOT IN(N'draft',N'supplier_action',N'approved',N'rejected',N'closed') ORDER BY p.PcnCode;`);
      for (const row of rows.recordset) {
        scanned++;
        if (deadlinePlan(persistedRecord(row), now, settings) && await this.queueRecord(row.PcnCode, now)) queued++;
      }
      this.after = rows.recordset.at(-1)?.PcnCode || '';
      if (rows.recordset.length < PAGE_SIZE) { this.after = ''; break; }
    }
    return { scanned, queued };
  }

  async readRecord(tx, code) {
    const rows = await tx.request().input('code', sql.NVarChar(32), code)
      .query(`SELECT ${projection} FROM pcn.PcnRequests p WITH(HOLDLOCK)
        LEFT JOIN pcn.PcnInternalReviews r WITH(HOLDLOCK) ON r.PcnId=p.PcnId
        WHERE p.PcnCode=@code AND p.DeletedAt IS NULL;`);
    return persistedRecord(rows.recordset[0]);
  }

  async queueRecord(code, now) {
    const tx = this.pool.transaction();
    await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    try {
      // Match save lock ordering: routing, authoritative PCN, then deduplicated outbox insertion.
      await lockUserMailRouting(tx);
      const settings = await this.workflowSettings.get(tx);
      const record = await this.readRecord(tx, code);
      const plan = deadlinePlan(record, now, settings);
      const mail = plan ? await this.prepareMail(tx, record, plan) : null;
      if (mail) {
        this.notificationService.assertSavedVersion(record);
        const batchPrefix = plan.eventKey.replaceAll('~', '~~').replaceAll('%', '~%').replaceAll('_', '~_').replaceAll('[', '~[') + ':batch:%';
        const existing = await tx.request().input('eventKey', sql.NVarChar(200), plan.eventKey)
          .input('batchPrefix', sql.NVarChar(220), batchPrefix)
          .query(`SELECT EventKey,PayloadJson,Status,Attempts,SentAt,LastError FROM pcn.NotificationJobs WITH(UPDLOCK,HOLDLOCK)
            WHERE EventKey=@eventKey OR EventKey LIKE @batchPrefix ESCAPE N'~';`);
        if (existing.recordset.length) {
          for (const job of existing.recordset) {
            const saved = JSON.parse(job.PayloadJson);
            const allowed = this.filterMail(record, plan, { ...job, PcnId: record.id, Action: plan.kind }, saved, mail);
            if (allowed) await this.restoreUnsentNotice(tx, record, { ...plan, eventKey: job.EventKey }, { ...saved, ...allowed });
          }
        } else {
          for (const [index, batch] of mail.batches.entries()) {
            const payload = { ...batch, notificationKind: 'review_deadline', deadlineSnapshot: plan.snapshot };
            await this.notificationService.insertJob(tx, record, batchEventKey(plan.eventKey, index), plan.deadline.stageKey, plan.kind, payload);
          }
        }
      }
      await tx.commit();
      return Boolean(mail);
    } catch (error) {
      try { await tx.rollback(); } catch { /* Preserve the original database failure. */ }
      throw error;
    }
  }

  async restoreUnsentNotice(tx, record, plan, payload) {
    // A policy can return to its earlier due date. Restore only automatic
    // cancellations that never reached a delivery attempt; sent/uncertain jobs stay final.
    await tx.request().input('eventKey', sql.NVarChar(200), plan.eventKey)
      .input('pcnId', sql.NVarChar(32), record.id).input('version', sql.NVarChar(16), record.version)
      .input('kind', sql.NVarChar(30), plan.kind).input('recipient', sql.NVarChar(1000), payload.to)
      .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(payload))
      .query(`UPDATE pcn.NotificationJobs WITH(UPDLOCK,HOLDLOCK)
        SET Status=N'pending',PcnVersion=@version,Recipient=@recipient,PayloadJson=@payload,
          LastError=NULL,ClaimedAt=NULL,ClaimToken=NULL,LeaseExpiresAt=NULL
        WHERE EventKey=@eventKey AND PcnId=@pcnId AND Action=@kind AND Status=N'cancelled'
          AND Attempts=0 AND SentAt IS NULL
          AND LastError=N'Workflow target or assigned recipients changed before sending';`);
  }

  async prepareMail(tx, record, plan) {
    const service = this.notificationService;
    const configured = service.mailConfigurationStatus ? service.mailConfigurationStatus() === 'configured' : Boolean(service.mailUrl);
    if (!configured) return null;
    const settings = await readNotificationSettings(tx);
    if (settings.schemaVersion !== 2 && !Object.hasOwn(settings, 'notificationPreferences')) return null;
    const assignments = await readUserMailAssignments(tx);
    try {
      const role = plan.target.action[0].toUpperCase() + plan.target.action.slice(1);
      const subject = `[Review ${plan.kind === 'overdue' ? 'Overdue' : 'Due Soon'}] ${record.id} - ${plan.deadline.label} ${role}`;
      const template = { subject: `${record.isTestDocument === true ? '[TESTING DOC] ' : ''}${subject}`,
        message: buildReviewDeadlineNotificationMessage(record, { departmentLabel: plan.deadline.label, role,
          dueAt: plan.deadline.dueAt, kind: plan.kind, pcnUrl: service.pcnLink(record.id) }), senderName: 'Supplier PCN Workflow' };
      const users = await readPreferenceUsers(tx, settings);
      const defaults = settings.schemaVersion === 2 ? defaultRoutingRecipients(settings, assignments, plan.target.groupKey) : [];
      const selected = preferenceBatches(settings, plan.kind === 'due_soon' ? 'dueSoon' : 'overdue',
        { record, users, defaultRecipients: defaults }, template);
      return selected.batches.length ? { ...selected, settings, users, defaultRecipients: defaults } : null;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return null;
    }
  }

  async prepareClaim(tx, job, savedPayload, nowDate) {
    if (savedPayload.notificationKind !== 'review_deadline' || !isCode(job.PcnId)) return null;
    const settings = await this.workflowSettings.get(tx);
    const record = await this.readRecord(tx, job.PcnId);
    const plan = deadlinePlan(record, nowDate, settings);
    const snapshot = savedPayload.deadlineSnapshot;
    if (!plan || !validBatchEvent(plan.eventKey, job, savedPayload) || job.Action !== plan.kind
      || !snapshot || Object.keys(plan.snapshot).some(key => snapshot[key] !== plan.snapshot[key]
        && !(key === 'stageKey' && plan.legacy && snapshot.stageKey === undefined))) return null;
    // Rebuild current policy and message, retaining only the saved batch's identities.
    const mail = await this.prepareMail(tx, record, plan);
    return mail ? this.filterMail(record, plan, job, savedPayload, mail) : null;
  }

  filterMail(record, plan, job, savedPayload, mail) {
    const type = plan.kind === 'due_soon' ? 'dueSoon' : 'overdue';
    if (!validBatchEvent(plan.eventKey, job, savedPayload) || (savedPayload.notificationPreferenceSnapshot
      && savedPayload.notificationPreferenceSnapshot.type !== type)) return null;
    try {
      const filtered = filteredPreferenceMail(mail.settings, [type], savedPayload,
        { record, users: mail.users, defaultRecipients: mail.defaultRecipients });
      if (!filtered) return null;
      const template = mail.batches[0];
      return { to: filtered.to, subject: template.subject, message: template.message, senderName: template.senderName };
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 503) return null;
      throw error;
    }
  }
}

module.exports = { ReviewDeadlineNotifications };
