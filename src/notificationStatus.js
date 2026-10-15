function summarizeNotificationStatus(rows = [], { configurationStatus = 'configured', blocked = false, currentActionBlocked = false } = {}) {
  const count = status => rows.filter(row => row.Status === status).reduce((sum, row) => sum + Math.max(0, Number(row.JobCount) || 0), 0);
  const accepted = count('sent');
  const processing = count('sending');
  const queued = count('pending') + processing;
  const noRecordedJobAndCurrentBlock = rows.length === 0 && currentActionBlocked;
  const needsAttention = count('uncertain') + count('failed') + (blocked || noRecordedJobAndCurrentBlock ? 1 : 0);
  const cancelled = count('cancelled');
  const state = needsAttention ? 'needs_attention' : queued ? 'queued' : accepted ? 'accepted' : cancelled ? 'cancelled' : 'not_queued';
  const messages = { needs_attention: 'Notification needs attention; workflow acceptance could not be confirmed.',
    queued: processing ? 'Notification is processing.' : 'Notification is queued.', accepted: 'Notification accepted by workflow.',
    cancelled: 'Notification was cancelled or superseded.', not_queued: configurationStatus === 'configured' ? 'No action notification was queued for this save.' : 'Notification sending is not configured.' };
  const dates = rows.map(row => row.LatestAcceptedAt instanceof Date ? row.LatestAcceptedAt.toISOString() : row.LatestAcceptedAt).filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort();
  return { state, accepted, queued, processing, needsAttention, cancelled,
    message: noRecordedJobAndCurrentBlock ? 'No action notification is recorded for the requested version. The current action is blocked and needs attention.' : messages[state],
    ...(noRecordedJobAndCurrentBlock ? { currentActionBlocked: true, requestedVersionRecorded: false } : {}), latestAcceptedAt: dates.at(-1) || null };
}
module.exports = { summarizeNotificationStatus };
