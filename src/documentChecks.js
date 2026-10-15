const { ApiError } = require('./apiError');
const { buildChecks } = require('../pcn-readiness');
const { isInternal, isEmployeeViewer, routeGroups, hasRole } = require('./workflowAccess');
const { actions, stageDepartments, departments, canSign } = require('./signingPermissions');

const at = (value, field) => field.split('.').reduce((item, key) => item?.[key], value);
function assertCompletion(record, attachments = [], { requiredFilesOnly = false } = {}) {
  const missing = buildChecks(record, attachments).items.filter(item => item.blocking && !item.complete
    && (!requiredFilesOnly || item.attachment));
  if (missing.length) throw new ApiError(400, `Complete required document information before advancing the PCN. Still missing: ${missing.map(item => item.label).join('; ')}.`,
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
      people: owner ? [publicPerson(user)] : [],canAct:user.isActive !== false && !isEmployeeViewer(user) && (owner || isInternal(user)) };
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
  return { ...none,stage:'final_judgment',department:'qaTet',signingStep:'approved',
    field:'internalReview.qateFinal.approve',label:'Record final judgment',canAct:canSign(user,'qaTet','approved') };
}

module.exports = { buildChecks, assertCompletion, buildAction };
