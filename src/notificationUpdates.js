const { isDeepStrictEqual } = require('node:util');
const { isInternal } = require('./workflowAccess');
const { emailList } = require('./integrationService');

const metadata = new Set(['id', 'version', 'createdAt', 'updatedAt', 'submittedAt', 'ownerUserId', 'masterDataVersionId',
  'mailRoutingState', 'mailRoutingPolicyVersion', 'notification', 'workflow', 'workflowProgress', 'documentControl']);
const labels = { status: 'Status', riskLevel: 'Risk level', changeForm: 'Change form', internalReview: 'Internal review',
  comments: 'Comments', approvals: 'Approvals', supplierName: 'Supplier', manufacturerName: 'Manufacturer',
  materialName: 'Material', changeRows: 'Change details', documents: 'Documents', route: 'Workflow route' };

// Browser forms populate optional blank leaves that SQL records can omit. Arrays
// remain intact because their order and every item are actual workbook content.
function comparableDomainValue(value) {
  if (value === undefined || value === null || value === '' || value === false) return undefined;
  if (typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return value;
  const entries = Object.entries(value).map(([key, item]) => [key, comparableDomainValue(item)])
    .filter(([, item]) => item !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function meaningfulUpdate(before, after) {
  if ((!before || before.status === 'draft') && after.status === 'draft') return [];
  if (!before || before.status === 'draft') return ['PCN submitted'];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(key => !metadata.has(key) && !isDeepStrictEqual(comparableDomainValue(before[key]), comparableDomainValue(after[key])))
    .map(key => labels[key] || 'PCN details').filter((value, index, list) => list.indexOf(value) === index);
}

function notificationRecipient(user, record) {
  if (!record || user.identityProvider !== 'employee-code' || !user.isActive || !user.mailVerifiedAt || !user.mailDirectoryId
    || user.mailProfile?.id !== user.mailDirectoryId || (!isInternal(user) && String(record.ownerUserId || '') !== String(user.id))) return null;
  try {
    const email = emailList(user.email);
    if (email.includes(';') || email.toLowerCase() !== String(user.mailProfile.email).toLowerCase()) return null;
    return { userId: user.id, directoryId: user.mailDirectoryId, email };
  } catch { return null; }
}

function batchRecipients(recipients) {
  const ordered = [...recipients].sort((a, b) => a.email.toLowerCase().localeCompare(b.email.toLowerCase())
    || String(a.userId).localeCompare(String(b.userId)));
  const unique = ordered.filter((value, index) => index === 0 || ordered[index - 1].email.toLowerCase() !== value.email.toLowerCase());
  return unique.reduce((batches, entry) => {
    const last = batches.at(-1) || [];
    if (last.length >= 30 || [...last, entry].map(value => value.email).join('; ').length > 1000) return [...batches, [entry]];
    return last.length ? [...batches.slice(0, -1), [...last, entry]] : [...batches, [entry]];
  }, []);
}

function filterPendingUpdates(payload, users, record) {
  const valid = (payload.updateSnapshot?.recipients || []).filter(snapshot => {
    const user = users.find(entry => entry.id === snapshot.userId);
    const recipient = user && notificationRecipient(user, record);
    return recipient && recipient.directoryId === snapshot.directoryId && recipient.email.toLowerCase() === String(snapshot.email).toLowerCase();
  });
  return { ...payload, to: valid.length ? emailList(valid.map(entry => entry.email).join('; ')) : '' };
}

module.exports = { meaningfulUpdate, notificationRecipient, batchRecipients, filterPendingUpdates };
