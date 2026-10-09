const { ApiError } = require('./apiError');
const { documentRequirements } = require('./documentRequirements');
const { isInternal, routeGroups, hasRole } = require('./workflowAccess');
const { actions, stageDepartments, departments, canSign } = require('./signingPermissions');

const at = (value, field) => field.split('.').reduce((item, key) => item?.[key], value);
const textPresent = value => typeof value === 'string' && value.trim().length > 0;

function buildChecks(record, attachments = []) {
  const fields = [
    ['supplierName', 'Supplier name'], ['materialName', 'Material / chemical name'],
    ['selectedChange', 'Change description'], ['reason', 'Reason for change'],
    ['currentCondition', 'Current condition'], ['newCondition', 'New condition'],
    ['desiredStart', 'Target start date or lot']
  ];
  const core = fields.map(([key, label]) => ({ key, label, field: key,
    complete: textPresent(record[key]) || (['currentCondition', 'newCondition'].includes(key)
      && Array.isArray(record.changeRows) && record.changeRows.length > 0
      && record.changeRows.every(row => textPresent(row[key]))), blocking: true }));
  const sample = [{key:'sampleSubmitted',label:'Sample submission choice',field:'sampleSubmitted',
    complete:['yes','no'].includes(record.sampleSubmitted),blocking:true},
  ...(record.sampleSubmitted === 'yes' ? [{key:'sampleSubmittedDate',label:'Sample submission date',
    field:'sampleSubmittedDate',complete:textPresent(record.sampleSubmittedDate),blocking:false}] : [])];
  const required = documentRequirements.filter(item => at(record, item.field) === true).map(item => ({
    ...item, requirementName: item.key, attachment: true, blocking: true,
    complete: attachments.some(file => !file.deletedAt && !file.DeletedAt && file.isDeleted !== true
      && (file.scanStatus || file.ScanStatus) === 'clean'
      && [item.key,item.label].includes(file.requirementName || file.RequirementName))
  }));
  const items = [...core, ...sample, ...required];
  return { items, ready: items.every(item => !item.blocking || item.complete) };
}

function assertCompletion(record, attachments = [], { requiredFilesOnly = false } = {}) {
  const missing = buildChecks(record, attachments).items.filter(item => item.blocking && !item.complete
    && (!requiredFilesOnly || item.attachment));
  if (missing.length) throw new ApiError(400, 'Complete required document information before advancing the PCN',
    { missing: missing.map(({key,label,field}) => ({key,label,field})) });
}

function publicPerson(user) {
  return { displayName: String(user.displayName || user.username || user.employeeCode || 'Assigned user'),
    employeeCode: user.employeeCode || null };
}

function buildAction(record, user, users = []) {
  const none = { stage:null,department:null,signingStep:null,field:null,label:'No action required',message:'No action required',terminal:false,people:[],canAct:false };
  if (['approved','rejected','closed'].includes(record.status)) return { ...none,terminal:true,message:`PCN ${record.status}` };
  if (['draft','supplier_action'].includes(record.status)) {
    const owner = String(user.id) === String(record.ownerUserId);
    return { ...none, stage:'supplier_submission',field:'supplierName',label:'Prepare and submit PCN',
      people: owner ? [publicPerson(user)] : [],canAct:user.isActive !== false && (owner || isInternal(user)) };
  }
  const review = record.internalReview || {};
  const groups = routeGroups(record.riskLevel, review).map(stage => [stage,stageDepartments[stage]]);
  for (const [stage, department] of groups) {
    for (const action of actions) {
      if (at(review, `${stage}.${action}`) === true) continue;
      const tapbuPending = stage.startsWith('tapbu.') && review.tapbu?.need !== true;
      const people = isInternal(user) ? users.filter(candidate => candidate.isActive === true
        && candidate.department === department && candidate.signingStep === action && canSign(candidate, department, action)).map(publicPerson) : [];
      const departmentLabel = departments.find(item => item.key === department)?.label || department;
      return { stage,department,signingStep:action,
        label: tapbuPending ? 'Confirm TaPBU requirement' : `${departmentLabel} — ${action[0].toUpperCase()}${action.slice(1)}`,
        people,field:tapbuPending ? 'internalReview.tapbu.need' : `internalReview.${stage}.${action}`,
        canAct: tapbuPending ? user.isActive !== false && hasRole(user,'admin','reviewer','gsc') : canSign(user,department,action) };
    }
  }
  return { ...none,stage:'final_judgment',department:'qaTet',signingStep:'prepared',
    field:'internalReview.qateFinal.approve',label:'Record final judgment',canAct:canSign(user,'qaTet','prepared') };
}

module.exports = { buildChecks, assertCompletion, buildAction };
