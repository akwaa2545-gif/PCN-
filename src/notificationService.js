const crypto = require('node:crypto');
const sql = require('mssql');
const { ApiError } = require('./apiError');
const { emailList } = require('./integrationService');
const { buildWorkflowNotificationMessage } = require('./notificationTemplate');

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
  }

  async workflow(record, input = {}, user = {}) {
    if (input.to || input.pcnUrl) throw new ApiError(400, 'Notification recipient and link are configured by the server');
    const completedKey = input.completedGroupKey || groups.find(([key, label]) => input.completedGroup === key || input.completedGroup === label)?.[0];
    const route = groups.filter(([key]) => record.riskLevel !== 'RL0' || !key.startsWith('tapbu.'));
    const index = route.findIndex(([key]) => key === completedKey);
    if (index < 0 || index >= route.length - 1) throw new ApiError(400, 'Invalid completed notification group');
    if (!route.slice(0, index + 1).every(([key]) => complete(record.internalReview, key))) {
      throw new ApiError(409, 'All preceding signoff groups must be complete, including Checked');
    }
    const [nextGroupKey, nextLabel] = route[index + 1];
    if (input.nextGroupKey && input.nextGroupKey !== nextGroupKey) throw new ApiError(400, 'Invalid next notification group');
    const settings = await this.repository.getNotificationSettings();
    const configured = (settings.groups || []).find((group) => group.key === nextGroupKey)?.emails;
    if (!configured) return { queued: false, reason: 'recipient_not_configured', nextGroupKey };
    const to = emailList(configured);
    if (!this.mailUrl) return { queued: false, reason: 'mail_not_configured', nextGroupKey };
    if (!/^PCN-\d{4}-\d{4}$/.test(record.id) || !/^[0-9a-f]{16}$/i.test(record.version || '')) throw new ApiError(409, 'Saved PCN version is required');
    let link = '';
    if (this.publicOrigin) {
      const origin = new URL(this.publicOrigin);
      if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password) throw new ApiError(503, 'Public PCN origin is invalid');
      link = new URL(`/form.html?id=${encodeURIComponent(record.id)}`, origin.origin).toString();
    }
    const payload = { to, subject: `[PCN] ${record.id} - ${route[index][1]} completed`,
      message: buildWorkflowNotificationMessage(record, { completedGroup: route[index][1], nextGroup: nextLabel, pcnUrl: link }),
      senderName: typeof user.displayName === 'string' ? user.displayName.slice(0, 120) : 'Supplier PCN Workflow' };
    const eventKey = `${record.id}:${record.version}:${completedKey}:completed`;
    const result = await this.pool.request()
      .input('id', sql.UniqueIdentifier, crypto.randomUUID()).input('eventKey', sql.NVarChar(200), eventKey)
      .input('pcnId', sql.NVarChar(32), record.id).input('version', sql.NVarChar(16), record.version)
      .input('completedGroup', sql.NVarChar(50), completedKey).input('action', sql.NVarChar(30), 'completed')
      .input('to', sql.NVarChar(1000), to).input('payload', sql.NVarChar(sql.MAX), JSON.stringify(payload))
      .query(`SET XACT_ABORT ON; BEGIN TRY BEGIN TRANSACTION;
        IF NOT EXISTS (SELECT 1 FROM pcn.NotificationJobs WITH (UPDLOCK, HOLDLOCK) WHERE EventKey=@eventKey)
          INSERT pcn.NotificationJobs(Id,EventKey,PcnId,PcnVersion,CompletedGroup,Action,Recipient,PayloadJson)
          VALUES(@id,@eventKey,@pcnId,@version,@completedGroup,@action,@to,@payload);
        SELECT Id,Status FROM pcn.NotificationJobs WHERE EventKey=@eventKey;
        COMMIT; END TRY BEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK; THROW; END CATCH;`);
    return { queued: true, jobId: result.recordset[0].Id, status: result.recordset[0].Status, nextGroupKey };
  }
}

module.exports = { NotificationService };
