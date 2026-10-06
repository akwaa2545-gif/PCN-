const crypto = require('node:crypto');
const sql = require('mssql');

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
    // An expired sending lease is ambiguous: the previous sender may have delivered mail.
    const result = await this.pool.request().input('token', sql.UniqueIdentifier, claimToken).query(`
      SET XACT_ABORT ON; BEGIN TRY BEGIN TRANSACTION;
      UPDATE pcn.NotificationJobs SET Status=N'uncertain', LastError=N'Worker lease expired; operator review required'
      WHERE Status=N'sending' AND LeaseExpiresAt < SYSUTCDATETIME();
      ;WITH candidate AS (SELECT TOP(1) * FROM pcn.NotificationJobs WITH(UPDLOCK,READPAST,ROWLOCK)
        WHERE Status=N'pending' ORDER BY CreatedAt,Id)
      UPDATE candidate SET Status=N'sending',Attempts=Attempts+1,ClaimedAt=SYSUTCDATETIME(),
        LeaseExpiresAt=DATEADD(second,60,SYSUTCDATETIME()),ClaimToken=@token OUTPUT inserted.Id,inserted.PayloadJson;
      COMMIT; END TRY BEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK; THROW; END CATCH;`);
    const job = result.recordset[0];
    if (!job) return { status: 'idle' };
    let status = 'sent';
    let errorMessage = null;
    try { await this.integrationService.sendMail(JSON.parse(job.PayloadJson)); }
    catch { status = 'uncertain'; errorMessage = 'Mail delivery outcome is unknown; operator review required'; }
    await this.pool.request().input('id', sql.UniqueIdentifier, job.Id).input('token', sql.UniqueIdentifier, claimToken)
      .input('status', sql.NVarChar(20), status).input('error', sql.NVarChar(1000), errorMessage)
      .query(`UPDATE pcn.NotificationJobs SET Status=@status,LastError=@error,
        SentAt=CASE WHEN @status=N'sent' THEN SYSUTCDATETIME() ELSE NULL END,LeaseExpiresAt=NULL
        WHERE Id=@id AND ClaimToken=@token AND Status=N'sending';`);
    return { jobId: job.Id, status };
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
