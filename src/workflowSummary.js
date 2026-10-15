const { routeGroups } = require('./workflowAccess');
const { actions, departments, stageDepartments } = require('./signingPermissions');

const at = (value,path) => path.split('.').reduce((item,key) => item?.[key],value);
const text = value => typeof value === 'string' && value.trim() ? value : null;
const title = action => action[0].toUpperCase()+action.slice(1);

function nextAction(record,stages) {
  const terminal = ['approved','rejected','closed'].includes(record.status);
  if (terminal) return {stage:null,signingStep:null,label:`PCN ${record.status}`,terminal:true};
  if (['draft','supplier_action'].includes(record.status)) {
    return {stage:'supplier_submission',signingStep:null,
      label:record.status === 'supplier_action' ? 'Supplier updates and resubmits PCN' : 'Prepare and submit PCN',terminal:false};
  }
  const stage = stages.find(item => item.completed < item.total);
  if (!stage) return {stage:'final_judgment',signingStep:null,label:'Record final judgment',terminal:false};
  if (stage.key.startsWith('tapbu.') && record.internalReview?.tapbu?.need !== true) {
    return {stage:stage.key,signingStep:null,label:'Confirm TaPBU requirement',terminal:false};
  }
  const step = stage.steps.find(item => !item.completed);
  return {stage:stage.key,signingStep:step.action,label:`${stage.label} — ${step.label}`,terminal:false};
}

function buildWorkflowSummary(record) {
  const review = record.internalReview || {};
  const stages = routeGroups(record.riskLevel,review).map(key => {
    const department = stageDepartments[key];
    const label = departments.find(item => item.key === department).label+(key === 'qateFinal.signoff' ? ' Final judgment' : '');
    const steps = actions.map(action => {
      const completed = at(review,`${key}.${action}`) === true;
      const binding = record.documentControl?.signatureBindings?.[`${key}.${action}`];
      return {action,label:title(action),completed,
        person:completed ? text(binding?.displayName) || text(at(review,`${key}.${action}Name`)) : null,
        signedAt:completed ? text(binding?.signedAt) || text(at(review,`${key}.${action}Date`)) : null};
    });
    return {key,label,completed:steps.filter(step => step.completed).length,total:actions.length,steps};
  });
  const next = nextAction(record,stages);
  return {id:record.id,version:record.version,status:record.status,stages:stages.map(stage => {
    const current = !next.terminal && next.stage === stage.key;
    return {...stage,state:stage.completed === stage.total ? 'completed' : next.terminal ? 'stopped' : current ? 'current' : 'waiting',
      currentStep:current ? next.signingStep ? title(next.signingStep) : next.label : null};
  }),nextAction:next};
}

module.exports = {buildWorkflowSummary};
