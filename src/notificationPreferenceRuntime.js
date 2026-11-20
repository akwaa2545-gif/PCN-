const { ApiError } = require('./apiError');
const { emailList } = require('./integrationService');
const { mailGroups } = require('./mailRouting');
const { managedRecipient, readGeneralNotificationUsers } = require('./userMailRouting');
const { readNotificationPreferenceUsers } = require('./notificationPreferenceUsers');
const { batchRecipients } = require('./notificationUpdates');
const { selectNotificationRecipients, filterNotificationRecipients } = require('./notificationPreferences');

async function readNotificationSettings(tx) {
  const rows = await tx.request().query('SELECT SettingsJson FROM pcn.NotificationSettings WITH(HOLDLOCK) WHERE Id=1');
  return rows.recordset[0] ? JSON.parse(rows.recordset[0].SettingsJson) : {};
}

async function readPreferenceUsers(tx, settings) {
  return settings.notificationPreferences ? readNotificationPreferenceUsers(tx) : readGeneralNotificationUsers(tx);
}

function defaultRoutingRecipients(settings, users, groupKey) {
  if (settings.schemaVersion !== 2) return [];
  const group = mailGroups.find(item => item.key === groupKey);
  if (!group) return [];
  const configured = settings.groups?.find(item => item.key === groupKey)?.emails || '';
  const manual = configured.trim() ? emailList(configured).split(';').map(email => email.trim()) : [];
  const automatic = users.filter(user => user.department === group.departmentKey && user.signingStep === group.action)
    .map(managedRecipient).filter(Boolean).map(recipient => ({ email: recipient.email, userId: recipient.userId,
      directoryId: recipient.id, department: group.departmentKey, signingStep: recipient.signingStep }));
  return [...manual, ...automatic];
}

function preferenceBatches(settings, type, { record, users, defaultRecipients }, template) {
  const selection = selectNotificationRecipients(settings, type, { record, users, defaultRecipients });
  if (!selection.enabled) return { enabled: false, batches: [], reason: 'notification_disabled' };
  const batches = batchRecipients(selection.recipients).map((recipients, batchIndex) => ({ ...template,
    to: emailList(recipients.map(recipient => recipient.email).join('; ')),
    notificationPreferenceSnapshot: { type, batchIndex, recipients } }));
  return { enabled: true, batches, ...(batches.length ? {} : { reason: 'recipient_not_configured' }) };
}

function batchEventKey(base, index = 0) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 9999) throw new ApiError(400, 'Invalid notification batch');
  return index === 0 ? base : `${base}:batch:${index}`;
}

function validBatchEvent(base, job, payload) {
  const snapshot = payload.notificationPreferenceSnapshot;
  const index = snapshot ? snapshot.batchIndex : 0;
  return Number.isSafeInteger(index) && index >= 0 && index <= 9999 && job.EventKey === batchEventKey(base, index);
}

function filteredPreferenceMail(settings, types, payload, { record, users, defaultRecipients }) {
  const snapshot = payload.notificationPreferenceSnapshot;
  if (snapshot !== undefined && !validPreferenceSnapshot(snapshot)) return null;
  const recipients = snapshot?.recipients || String(payload.to || '').split(';').map(email => ({ email: email.trim() })).filter(item => item.email);
  let remaining = recipients;
  for (const type of types) {
    const selection = filterNotificationRecipients(settings, type, remaining, { record, users, defaultRecipients });
    if (!selection.enabled) return null;
    remaining = selection.recipients;
  }
  return remaining.length ? { ...payload, to: emailList(remaining.map(recipient => recipient.email).join('; ')) } : null;
}

function validPreferenceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || Object.keys(snapshot).length !== 3 || !Object.hasOwn(snapshot, 'type')
    || !Number.isSafeInteger(snapshot.batchIndex) || snapshot.batchIndex < 0 || snapshot.batchIndex > 9999
    || !Array.isArray(snapshot.recipients) || !snapshot.recipients.length || snapshot.recipients.length > 30) return false;
  if (!['submitted','actionRequired','updated','completed','dueSoon','overdue'].includes(snapshot.type)) return false;
  return snapshot.recipients.every(recipient => recipient && typeof recipient === 'object' && !Array.isArray(recipient)
    && typeof recipient.email === 'string' && ['default','custom'].includes(recipient.source)
    && (recipient.source !== 'custom' || (typeof recipient.userId === 'string' && typeof recipient.directoryId === 'string')))
    && snapshot.recipients.map(recipient => recipient.email).join('; ').length <= 1000;
}

module.exports = { readNotificationSettings, readPreferenceUsers, defaultRoutingRecipients, preferenceBatches, batchEventKey,
  validBatchEvent, filteredPreferenceMail, validPreferenceSnapshot };
