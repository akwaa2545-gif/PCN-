const { actions } = require('./signingPermissions');
const { routeGroups } = require('./workflowAccess');
const { RULES, defaultWorkflowSettings } = require('./workflowSettings');
const { departmentForStage } = require('../pcn-types');

const DAY_MS = 24 * 60 * 60 * 1000;
const stoppedStatuses = new Set(['draft', 'supplier_action', 'approved', 'rejected', 'closed']);
const timingKeys = new Set(RULES.map(rule => rule.key));
const at = (value, path) => path.split('.').reduce((item, key) => item?.[key], value);
const ruleForStage = (record, stage) => RULES.find(rule => rule.stageKey === stage
  && (stage !== 'signoff.prodEngTet' || rule.department === departmentForStage(record, stage)));

function activeStage(record) {
  if (!record?.status || stoppedStatuses.has(record.status)) return null;
  const review = record.internalReview || {};
  return routeGroups(record.riskLevel, review)
    .find(stage => !actions.every(action => at(review, `${stage}.${action}`) === true)) || null;
}

const isProdEngActive = record => activeStage(record) === 'signoff.prodEngTet';
const isQaActive = record => activeStage(record) === 'signoff.qaTet';

// Require an unambiguous full timestamp; Date.parse alone accepts dates and normalizes impossible days.
function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) return null;
  const offset = parts[6];
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) return null;
  const wallTime = `${parts[1]}T${parts[2]}:${parts[3]}:${parts[4]}.${(parts[5] || '').padEnd(3, '0')}Z`;
  const wallDate = new Date(wallTime);
  if (!Number.isFinite(wallDate.getTime()) || wallDate.toISOString() !== wallTime) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function trustedStart(record, ruleKey, now) {
  const startedAt = canonicalTimestamp(record?.reviewTiming?.[ruleKey]?.startedAt);
  return startedAt && Number.isFinite(now) && Date.parse(startedAt) <= now ? startedAt : null;
}

function applyReviewTiming(before, after, nowISO) {
  const now = canonicalTimestamp(nowISO);
  if (!now) throw new TypeError('Review timing requires a full ISO server timestamp');
  const currentStage = activeStage(after);
  const rule = ruleForStage(after, currentStage);
  // An ordinary save of an old active stage must not invent a historical handoff.
  const timingKey = rule && (rule.timingKey || rule.key);
  const startedAt = rule && (activeStage(before) === currentStage ? trustedStart(before, timingKey, Date.parse(now)) : now);
  const otherTiming = Object.fromEntries(Object.entries(before?.reviewTiming || {})
    .filter(([key]) => !timingKeys.has(key)));
  const { reviewTiming: proposedTiming, ...record } = after;
  const reviewTiming = { ...otherTiming, ...(startedAt ? { [timingKey]: { startedAt } } : {}) };
  return { ...record, ...(Object.keys(reviewTiming).length ? { reviewTiming } : {}) };
}

function stageDeadline(record, stageKey, nowDate = new Date(), settings = defaultWorkflowSettings()) {
  const rule = ruleForStage(record, stageKey);
  const pendingDays = rule && (Object.hasOwn(settings?.pendingDays || {}, rule.key)
    ? settings.pendingDays[rule.key] : settings?.pendingDays?.[rule.timingKey || rule.key]);
  if (!rule || activeStage(record) !== stageKey || !Number.isInteger(pendingDays) || pendingDays < 1 || pendingDays > 365) return null;
  const now = nowDate instanceof Date ? nowDate.getTime() : NaN;
  const startedAt = trustedStart(record, rule.timingKey || rule.key, now);
  const dueAt = startedAt ? new Date(Date.parse(startedAt) + pendingDays * DAY_MS).toISOString() : null;
  return {
    stageKey, department: rule.department, label: rule.label, startedAt, dueAt,
    overdue: dueAt ? now > Date.parse(dueAt) : null,
    source: startedAt ? 'handoff' : 'unknown'
  };
}

const prodEngDeadline = (record, nowDate = new Date(), settings = defaultWorkflowSettings()) => stageDeadline(record, 'signoff.prodEngTet', nowDate, settings);
const qaDeadline = (record, nowDate = new Date(), settings = defaultWorkflowSettings()) => stageDeadline(record, 'signoff.qaTet', nowDate, settings);
const activeReviewDeadline = (record, nowDate = new Date(), settings = defaultWorkflowSettings()) => stageDeadline(record, activeStage(record), nowDate, settings);

module.exports = { isProdEngActive, isQaActive, applyReviewTiming, stageDeadline, prodEngDeadline, qaDeadline, activeReviewDeadline };
