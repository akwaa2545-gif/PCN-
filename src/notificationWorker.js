const crypto = require('node:crypto');
const sql = require('mssql');

class NotificationWorker {
  constructor(pool, options = {}) { this.pool = pool; this.integrationService = options.integrationService; }

  async runOnce() {
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

  async status() {
    const result = await this.pool.request().query(`SELECT TOP(100) Id,PcnId,PcnVersion,CompletedGroup,Action,Status,Attempts,CreatedAt,SentAt,LastError
      FROM pcn.NotificationJobs ORDER BY CreatedAt DESC`);
    return result.recordset;
  }
}

module.exports = { NotificationWorker };
