const { ApiError } = require('./apiError');
const { isDeveloperAssignment, actions, departments, stageDepartments } = require('./signingPermissions');
const { routeGroups } = require('./workflowAccess');
const { buildWorkflowProgress } = require('./masterData');
const { buildAction, buildChecks } = require('./documentChecks');

const recordKeys = ['id','supplierName','materialName','status','riskLevel','updatedAt','isTestDocument'];
const fields = new Set(['status','changeForm','riskLevel','selectedChange','supplierName','manufacturerName','materialName',
  'desiredStart','sampleSubmitted','sampleSubmittedDate','currentCondition','newCondition','changeRows','reason',
  'identification','sampleLocation','priceLevel','internalReview','comments','approvals','documentAttachments','documents',
  'isTestDocument','submittedAt','reviewDueAt','changeType','sourceTemplate']);
const privateKeys = new Set(['ownerUserId','userId','passwordHash','password','securityStamp','accessVersion','token','csrfToken',
  'email','mailProfile','mailDirectoryId','storagePath','storageKey','base64','bytes','contentHash','version','notification']);
const at = (object, path) => path.split('.').reduce((value,key) => value?.[key],object);
const select = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key,object[key]]));
const summary = record => ({...select(record,recordKeys),isTestDocument:record.isTestDocument === true});

function requireDeveloper(user) {
  if (!user || user.isActive !== true || !isDeveloperAssignment(user)
    || user.roles.length !== 1 || typeof user.roles[0] !== 'string' || user.roles[0].toLowerCase() !== 'developer') {
    throw new ApiError(403,'Developer access required');
  }
}

function assertId(id) {
  if (typeof id !== 'string' || !/^PCN-\d{4}-\d{4}$/.test(id)) throw new ApiError(400,'Invalid PCN id');
}

async function loadDeveloperPcns(context,user) {
  requireDeveloper(user);
  return {items:(await context.service.list({},user)).map(summary)};
}

function safeValue(value, root) {
  if (Array.isArray(value)) return value.map(item => safeValue(item,root));
  if (!value || typeof value !== 'object') return value ?? null;
  const source = ['documentAttachments','documents'].includes(root)
    ? select(value,['id','fileName','contentType','sizeBytes','scanStatus','uploadedBy','uploadedAt','contentRevision','requirementName','name','type']) : value;
  return Object.fromEntries(Object.entries(source).filter(([key]) => !privateKeys.has(key))
    .map(([key,item]) => [key,safeValue(item,root)]));
}

function fieldLabel(path) {
  const labels = {'documentControl.revisionReason':'Revision reason',documentAttachments:'Attachments',internalReview:'Review',
    desiredStart:'Target start date or lot',reason:'Reason for change'};
  if (labels[path]) return labels[path];
  const prefix = Object.keys(stageDepartments).find(stage => path.startsWith(`internalReview.${stage}.`));
  if (prefix) {
    const department=departments.find(item => item.key === stageDepartments[prefix])?.label;
    const part=path.slice(`internalReview.${prefix}.`.length);
    const action=/^(prepared|checked|approved)(Name|Date)?$/.exec(part);
    const step=action ? `${action[1][0].toUpperCase()}${action[1].slice(1)}${action[2] === 'Name' ? ' by' : action[2] === 'Date' ? ' date' : ''}` : part;
    return `${department}${prefix === 'qateFinal.signoff' ? ' Final judgment' : ''} / ${step}`;
  }
  return path.split('.').map(part => labels[part] || part.replace(/([a-z])([A-Z])/g,'$1 $2'))
    .join(' / ').replace(/^./,letter => letter.toUpperCase());
}

function safeChange(change) {
  if (!change || typeof change.path !== 'string') throw new ApiError(503,'Document transaction history is unavailable');
  const segments=change.path.split('.');
  if ((!fields.has(segments[0]) && change.path !== 'documentControl.revisionReason') || segments.some(key => privateKeys.has(key))) return null;
  return {path:change.path,label:fieldLabel(change.path),before:safeValue(change.before,segments[0]),after:safeValue(change.after,segments[0])};
}

function transactions(revisions,users) {
  if (!Array.isArray(revisions) || revisions.some(row => !Number.isSafeInteger(row?.revision) || row.revision < 1 || !Array.isArray(row.changes))) {
    throw new ApiError(503,'Document transaction history is unavailable');
  }
  const sorted=[...revisions].sort((a,b) => b.revision-a.revision);
  const ascending=[...sorted].reverse();
  const unavailable=!sorted.length || ascending[0].revision !== 1 || ascending.some((row,index) => row.isBaseline
    || index && row.revision !== ascending[index-1].revision+1);
  return {items:sorted.map(row => {
    const actorReference=String(row.actor || 'Unknown actor');
    const known=actorReference.startsWith('user:') ? users.find(user => String(user.id) === actorReference.slice(5)) : null;
    return {revision:row.revision,contentRevision:row.contentRevision ?? null,actor:known?.displayName || known?.username || actorReference,
      actorReference,createdAt:row.createdAt || null,status:row.status || null,isBaseline:row.isBaseline === true,
      changes:row.changes.map(safeChange).filter(Boolean)};
  }),historyMessage:unavailable ? 'Earlier changes are unavailable. Baselines describe the document when tracking began; they do not establish who created it.'
    : 'Recorded document changes, newest first. Each row represents a saved change.'};
}

function workflow(record,user,users,files) {
  const next=buildAction(record,user,users);
  const terminal=['approved','rejected','closed'].includes(record.status);
  const signing=['draft','supplier_action'].includes(record.status) ? false : !terminal;
  const review=record.internalReview || {};
  const stages=routeGroups(record.riskLevel,review).map(key => {
    const department=stageDepartments[key];
    const label=(departments.find(item => item.key === department)?.label || department)+(key === 'qateFinal.signoff' ? ' Final judgment' : '');
    return {key,label,steps:actions.map(action => {
      const completed=at(review,`${key}.${action}`) === true;
      const binding=record.documentControl?.signatureBindings?.[`${key}.${action}`];
      return {action,label:action[0].toUpperCase()+action.slice(1),state:completed ? 'completed'
        : signing && next.stage === key && next.signingStep === action ? 'current' : 'waiting',
      person:completed ? binding?.displayName || at(review,`${key}.${action}Name`) || null : null,
      signedAt:completed ? binding?.signedAt || at(review,`${key}.${action}Date`) || null : null};
    })};
  });
  return {progress:buildWorkflowProgress(record),nextAction:{label:next.label,message:next.message || next.label,
    stage:next.stage,department:next.department,signingStep:next.signingStep,terminal:terminal,
    people:next.people.map(person => ({displayName:person.displayName}))},stages,checks:buildChecks(record,files)};
}

async function inspectDeveloperPcn(context,user,id) {
  requireDeveloper(user);assertId(id);
  const record=await context.service.getById(id,user);
  if (!context.documents?.list || !context.authService?.repository?.listUsers || !context.service.getRevisions) {
    throw new ApiError(503,'Workflow inspection metadata is unavailable');
  }
  let files,revisions,users;
  try { [files,revisions,users]=await Promise.all([context.documents.list(id),context.service.getRevisions(id,user),context.authService.repository.listUsers()]); }
  catch (error) {
    if ([401,403,404,409].includes(error?.statusCode)) throw error;
    throw new ApiError(503,'Workflow inspection metadata is unavailable');
  }
  if (!Array.isArray(files) || !Array.isArray(users)) throw new ApiError(503,'Workflow inspection metadata is unavailable');
  const latest=await context.service.getById(id,user);
  if (!record.version || record.version !== latest.version) throw new ApiError(409,'PCN changed while loading Developer tools; reload to see the latest changes');
  return {record:{...summary(record),version:record.version},workflow:workflow(record,user,users,files),transactions:transactions(revisions,users)};
}

async function handleDeveloperTools(method,url,context,user) {
  requireDeveloper(user);
  if (method !== 'GET') throw new ApiError(405,'Method not allowed');
  if (url.searchParams.size) throw new ApiError(400,'Developer tools request does not accept selectors');
  if (url.pathname === '/api/developer/pcns') return loadDeveloperPcns(context,user);
  const match=/^\/api\/developer\/pcns\/([^/]+)\/inspect$/.exec(url.pathname);
  if (match) return inspectDeveloperPcn(context,user,match[1]);
  if (url.pathname.startsWith('/api/developer/pcns/')) throw new ApiError(400,'Invalid PCN inspection request');
  throw new ApiError(404,'API route not found');
}

module.exports={loadDeveloperPcns,inspectDeveloperPcn,handleDeveloperTools};
