const { buildWorkflowProgress } = require('./masterData');
const { buildAction, buildChecks } = require('./documentChecks');
const { isEmployeeViewer, isInternal, routeGroups } = require('./workflowAccess');
const { actions } = require('./signingPermissions');
const { prodEngDeadline, qaDeadline, activeReviewDeadline } = require('./reviewTiming');
const { readWorkflowSettings } = require('./workflowSettings');

const at = (value, path) => path.split('.').reduce((current, key) => current?.[key], value);
const terminalStatuses = new Set(['approved', 'rejected', 'closed']);

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const day = value.slice(0, 10);
  const calendarDate = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== day) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function documentSummary(record, attachments) {
  const checks = buildChecks(record, attachments || []).items;
  const requested = checks.filter(item => item.attachment);
  const missingFields = checks.filter(item => !item.attachment && item.blocking && !item.complete)
    .map(({ key, label }) => ({ key, label }));
  const known = Array.isArray(attachments);
  const missing = known ? requested.filter(item => !item.complete).map(({ key, label }) => ({ key, label })) : [];
  return { state: !known ? 'unknown' : missing.length ? 'missing' : 'ready',
    ready: known ? missing.length === 0 : null, requiredCount: requested.length,
    completeCount: known ? requested.length - missing.length : null, missing, missingFields };
}

function pendingSummary(record, documents, now, timing, settings) {
  const currentTiming = timing?.parentVersion === record.version && timing?.status === record.status ? timestamp(timing.since) : null;
  const choices = [[currentTiming, 'status_transition'], [timestamp(record.updatedAt), 'updatedAt'], [timestamp(record.createdAt), 'createdAt']];
  const [since, source] = choices.find(([date]) => date && date <= now) || [null, 'unknown'];
  const due = timestamp(record.reviewDueAt);
  const departmentDeadline = activeReviewDeadline(record, now, settings);
  const active = !terminalStatuses.has(record.status);
  const explicitOverdue = due ? active && due < now : null;
  const overdue = explicitOverdue === true || departmentDeadline?.overdue === true
    ? true : explicitOverdue ?? departmentDeadline?.overdue ?? null;
  const reasons = active ? [documents.state === 'unknown' && 'document_status_unknown',
    documents.state === 'missing' && 'missing_documents', documents.missingFields.length > 0 && 'missing_fields', overdue && 'overdue'].filter(Boolean) : [];
  return { since: since?.toISOString() || null, source, ageDays: since ? Math.floor((now - since) / 86400000) : null,
    reviewOverdueDays: explicitOverdue === true ? Math.floor((now - due) / 86400000) : null,
    departmentOverdueDays: departmentDeadline?.overdue === true ? Math.floor((now - Date.parse(departmentDeadline.dueAt)) / 86400000) : null,
    reviewDueAt: due?.toISOString() || null, prodEngDeadline: prodEngDeadline(record, now, settings),
    qaDeadline: qaDeadline(record, now, settings), activeReviewDeadline: departmentDeadline,
    overdue, needsAttention: reasons.length > 0, reasons };
}

function buildRecordOverview(record, user, users = [], attachments = null, now = new Date(), timing = null, settings) {
  const review = record.internalReview || {};
  const groups = routeGroups(record.riskLevel, review);
  const progress = { ...buildWorkflowProgress(record), totalSignatures: groups.length * actions.length,
    completedSignatures: groups.reduce((count, group) => count + actions.filter(action => at(review, `${group}.${action}`) === true).length, 0) };
  const action = buildAction(record, user, users);
  const safeAction = { ...action, people: isInternal(user) ? action.people.map(person => ({ displayName: person.displayName })) : [],
    canAct: isEmployeeViewer(user) ? false : action.canAct };
  const documents = documentSummary(record, attachments);
  return { ...record, dashboard: { progress, action: safeAction, documents, pending: pendingSummary(record, documents, now, timing, settings) } };
}

async function optionalBatch(source, method, ids, label) {
  if (typeof source?.[method] !== 'function') return new Map();
  try { return await source[method](ids); }
  catch (error) {
    if ([401, 403, 404].some(status => error?.statusCode === status || error?.status === status)) throw error;
    console.warn(JSON.stringify({ level: 'warn', code: 'OVERVIEW_METADATA_UNAVAILABLE', metadata: label }));
    return new Map();
  }
}

async function loadRecordOverview(context, user, filters = {}, now = new Date()) {
  const records = await context.service.list(filters, user);
  const settings = await readWorkflowSettings(context.repository);
  const ids = records.map(record => record.id);
  const users = ids.length && isInternal(user) ? await context.authService.repository.listUsers() : [];
  const [files, timings] = await Promise.all([
    optionalBatch(context.documents, 'listForRecords', ids, 'documents'),
    optionalBatch(context.repository, 'getStatusTimings', ids, 'status')
  ]);
  return { generatedAt: now.toISOString(), items: records.map(record => {
    const fileEntry = files.get(record.id);
    const attachments = fileEntry?.parentVersion === record.version && record.version ? fileEntry.attachments : null;
    return buildRecordOverview(record, user, users, attachments, now, timings.get(record.id), settings);
  }) };
}

module.exports = { buildRecordOverview, loadRecordOverview };
