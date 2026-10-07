const crypto = require('node:crypto');
const sql = require('mssql');
const { lockUserMailRouting, readUserMailAssignments, filterPendingRecipients } = require('./userMailRouting');

class NotificationWorker {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.integrationService = options.integrationService;
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
      await lockUserMailRouting(tx);
      // Expired leases are ambiguous; never return them to the pending queue.
      const result = await tx.request().query(`UPDATE pcn.NotificationJobs SET Status=N'uncertain',
        LastError=N'Worker lease expired; operator review required' WHERE Status=N'sending' AND LeaseExpiresAt<SYSUTCDATETIME();
        SELECT TOP(1) Id,PayloadJson FROM pcn.NotificationJobs WITH(UPDLOCK,READPAST,ROWLOCK)
        WHERE Status=N'pending' ORDER BY CreatedAt,Id;`);
      const row = result.recordset[0];
      if (!row) { await tx.commit(); return null; }
      const savedPayload = JSON.parse(row.PayloadJson);
      const payload = savedPayload.routingSnapshot ? filterPendingRecipients(savedPayload, await readUserMailAssignments(tx)) : savedPayload;
      const cancelled = Boolean(savedPayload.routingSnapshot && !payload.to);
      await tx.request().input('id', sql.UniqueIdentifier, row.Id).input('token', sql.UniqueIdentifier, claimToken)
        .input('recipient', sql.NVarChar(1000), payload.to || '').input('payload', sql.NVarChar(sql.MAX), JSON.stringify(payload))
        .query(cancelled
          ? "UPDATE pcn.NotificationJobs SET Status=N'cancelled',LastError=N'Assigned recipients changed before sending' WHERE Id=@id AND Status=N'pending'"
          : `UPDATE pcn.NotificationJobs SET Status=N'sending',Attempts=Attempts+1,ClaimedAt=SYSUTCDATETIME(),
            LeaseExpiresAt=DATEADD(second,60,SYSUTCDATETIME()),ClaimToken=@token,Recipient=@recipient,PayloadJson=@payload
            WHERE Id=@id AND Status=N'pending'`);
      await tx.commit();
      // Account changes after the committed claim do not recall an in-flight send.
      const { routingSnapshot: omitted, ...mail } = payload;
      return { Id: row.Id, payload: mail, cancelled };
    } catch (error) {
      try { await tx.rollback(); } catch { /* Preserve the original database error. */ }
      throw error;
    }
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
