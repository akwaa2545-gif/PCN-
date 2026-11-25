const crypto = require('node:crypto');
const { ApiError } = require('./apiError');
const { departments, actions, isDeveloperAssignment } = require('./signingPermissions');
const { assertRecordAccess, isInternal } = require('./workflowAccess');
const { emailList } = require('./integrationService');
const { managedRecipient } = require('./userMailRouting');

const TYPES = Object.freeze([
  {key:'submitted',label:'PCN submitted',description:'Updates when a draft is submitted for review.'},
  {key:'actionRequired',label:'Action requests',description:'Requests for the next workflow action.'},
  {key:'updated',label:'Document updates',description:'Information about saved PCN changes.'},
  {key:'completed',label:'Completed documents',description:'Updates when a PCN is closed or rejected.'},
  {key:'dueSoon',label:'Due soon',description:'Reminders before an active review deadline.'},
  {key:'overdue',label:'Overdue',description:'Alerts after an active review deadline passes.'}
].map(Object.freeze));
const roleGroups = [
  ['admin','Administrator'], ['developer','Developer'], ['reviewer','Reviewer'], ['gsc','GSC'],
  ['productionengineering','Production Engineering'], ['qa','QA'], ['tapbu','TaPBU'], ['supplier','Supplier']
].map(([role,label])=>Object.freeze({key:`role.${role}`,role,departmentKey:null,action:null,label:`PCN role — ${label}`}));
const GROUPS = Object.freeze([...roleGroups,...departments.flatMap(department => [null,...actions].map(action => Object.freeze({
  key:`department.${department.key}.${action || 'any'}`, departmentKey:department.key, action,
  label:`${department.label} — ${action ? action[0].toUpperCase()+action.slice(1) : 'All signing roles'}`
})))]);
const ruleKeys = ['enabled','includeDefaultRecipients','groupKeys','userIds','excludedUserIds'];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const versionPattern = /^[0-9a-f]{64}$/;
const exact = (value,keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
const canonicalId = value => typeof value === 'string' ? value.toLowerCase() : '';

function defaultNotificationPreferences() {
  return {schemaVersion:1,rules:Object.fromEntries(TYPES.map(type=>[type.key,{
    enabled:true,includeDefaultRecipients:true,groupKeys:[],userIds:[],excludedUserIds:[]
  }])),updatedAt:null,updatedBy:null};
}

function stringArray(value,allowed,label,limit=500) {
  if (!Array.isArray(value) || value.length>limit || value.some(entry=>typeof entry !== 'string' || !allowed(entry))) {
    throw new ApiError(400,`Invalid notification ${label}`);
  }
  const values=value.map(entry=>label.startsWith('group ') ? entry : canonicalId(entry));
  if (new Set(values).size!==values.length) throw new ApiError(400,`Duplicate notification ${label}`);
  return values;
}

function validatedRules(rules,{preserveEmptyExclusions=false}={}) {
  if (!exact(rules,TYPES.map(type=>type.key))) throw new ApiError(400,'All six notification types are required');
  return Object.fromEntries(TYPES.map(({key})=>{
    const rule=rules[key];
    if ((!exact(rule,ruleKeys) && !exact(rule,[...ruleKeys,'excludedGroupKeys'])) || typeof rule.enabled !== 'boolean' || typeof rule.includeDefaultRecipients !== 'boolean') {
      throw new ApiError(400,`Invalid ${key} notification rule`);
    }
    const groupKeys=stringArray(rule.groupKeys,value=>GROUPS.some(group=>group.key===value),'group selection',GROUPS.length);
    const excludedGroupKeys=Object.hasOwn(rule,'excludedGroupKeys')
      ? stringArray(rule.excludedGroupKeys,value=>GROUPS.some(group=>group.key===value),'group exclusion',GROUPS.length) : [];
    if (groupKeys.some(group=>excludedGroupKeys.includes(group))) throw new ApiError(400,'A notification group cannot be included and excluded');
    const userIds=stringArray(rule.userIds,value=>uuid.test(value),'user selection');
    const excludedUserIds=stringArray(rule.excludedUserIds,value=>uuid.test(value),'user exclusion');
    if (userIds.some(id=>excludedUserIds.includes(id))) throw new ApiError(400,'A notification recipient cannot be included and excluded');
    return [key,{enabled:rule.enabled,includeDefaultRecipients:rule.includeDefaultRecipients,groupKeys,userIds,excludedUserIds,
      ...(excludedGroupKeys.length || preserveEmptyExclusions && Object.hasOwn(rule,'excludedGroupKeys') ? {excludedGroupKeys} : {})}];
  }));
}

function verifiedIdentity(user) {
  if (!user || user.isActive !== true || !['employee-code','pcn-local'].includes(user.identityProvider)
    || !uuid.test(user.id || '') || !user.mailVerifiedAt || !user.mailDirectoryId
    || user.mailProfile?.id !== user.mailDirectoryId) return null;
  try {
    const email=emailList(user.email);
    if (email.includes(';') || email.toLowerCase()!==String(user.mailProfile.email).toLowerCase()) return null;
    return {email,userId:canonicalId(user.id),directoryId:user.mailDirectoryId,
      department:user.department || null,signingStep:user.signingStep || null};
  } catch { return null; }
}

function validateNotificationPreferences(input,users) {
  if (!exact(input,['schemaVersion','version','rules']) || input.schemaVersion!==1 || typeof input.version!=='string' || !versionPattern.test(input.version)) {
    throw new ApiError(400,'Notification settings require schemaVersion 1, a current version and all rules');
  }
  const rules=validatedRules(input.rules,{preserveEmptyExclusions:true});
  if (users !== undefined) {
    const eligible=new Set(users.filter(verifiedIdentity).map(user=>canonicalId(user.id)));
    const known=new Set(users.filter(user=>uuid.test(user.id || '') && ['employee-code','pcn-local'].includes(user.identityProvider)).map(user=>canonicalId(user.id)));
    if (Object.values(rules).some(rule=>rule.userIds.some(id=>!eligible.has(id)) || rule.excludedUserIds.some(id=>!known.has(id)))) {
      throw new ApiError(400,'Choose active users with verified email addresses; reload notification settings');
    }
  }
  return {schemaVersion:1,version:input.version,rules};
}

function readNotificationPreferences(settings={}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new ApiError(503,'Saved notification settings are invalid');
  const stored=Object.hasOwn(settings,'notificationPreferences') ? settings.notificationPreferences
    : settings.schemaVersion===1 && Object.hasOwn(settings,'rules') ? settings : undefined;
  if (stored===undefined && !Object.hasOwn(settings,'notificationPreferences')) return defaultNotificationPreferences();
  try {
    if (!stored || Array.isArray(stored) || typeof stored !== 'object' || stored.schemaVersion!==1
      || Reflect.ownKeys(stored).some(key=>!['schemaVersion','rules','updatedAt','updatedBy'].includes(key))) throw new Error('Invalid policy');
    if (stored.updatedAt != null && (typeof stored.updatedAt !== 'string' || !Number.isFinite(Date.parse(stored.updatedAt)))) throw new Error('Invalid date');
    if (stored.updatedBy != null && (typeof stored.updatedBy !== 'string' || stored.updatedBy.length>256)) throw new Error('Invalid actor');
    return {schemaVersion:1,rules:validatedRules(stored.rules),updatedAt:stored.updatedAt || null,updatedBy:stored.updatedBy || null};
  } catch { throw new ApiError(503,'Saved notification preferences are invalid'); }
}

function groupMatches(user,group) {
  if (group.role==='developer') return user?.isActive===true && isDeveloperAssignment(user)
    && Array.isArray(user.roles) && user.roles.length===1 && typeof user.roles[0]==='string'
    && user.roles[0].toLowerCase()==='developer';
  if (group.role) return (Array.isArray(user?.roles) ? user.roles : []).some(role=>
    typeof role==='string' && role.replace(/[^a-z]/gi,'').toLowerCase()===group.role);
  return group.departmentKey===user?.department && (!group.action || group.action===user.signingStep);
}

function groupOptions(settings,users) {
  const verified=users.filter(verifiedIdentity);
  const signingKeys=GROUPS.filter(group=>group.departmentKey && group.action).map(group=>group.key);
  const legacyKeys=['signoff.gscTet','signoff.prodEngTet','signoff.qaTet','tapbu.gsc','tapbu.qa','qateFinal.signoff','supplierNotification'];
  const currentGroups=Array.isArray(settings?.groups) ? settings.groups : [];
  const legacyGroups=settings?.schemaVersion===2 ? (Array.isArray(settings.legacyGroups) ? settings.legacyGroups : []) : currentGroups;
  const canonical=settings?.schemaVersion===2 ? currentGroups.filter(group=>signingKeys.includes(group.key)) : [];
  const actionGroups=[...canonical,...(settings?.schemaVersion===2 ? currentGroups.filter(group=>group.key==='supplierNotification') : []),
    ...legacyGroups.filter(group=>legacyKeys.includes(group.key))];
  const emailsFor=groups=>new Set(groups.flatMap(group=>{
    try {return emailList(group.emails || '').split(';').map(email=>email.trim().toLowerCase()).filter(Boolean);} catch {return [];}
  }));
  const actionEmails=emailsFor(actionGroups),deadlineEmails=emailsFor(canonical);
  const modeForUser=user=>{
    const administrator=Array.isArray(user.roles) && user.roles.some(role=>typeof role==='string' && role.trim().toLowerCase()==='admin');
    if (administrator) return departments.some(department=>department.key===user.department) ? 'departmentEvents' : 'none';
    return isInternal(user) ? 'general' : 'ownPcns';
  };
  return GROUPS.map(group=>{
    const members=verified.filter(user=>groupMatches(user,group));
    const defaultModes=Object.fromEntries(TYPES.map(type=>[type.key,'none']));
    const modes=[...new Set(members.map(modeForUser).filter(mode=>mode!=='none'))];
    const generalMode=members.length ? modes.length>1 ? 'conditional' : modes[0] || 'none'
      : group.role ? group.role==='admin' ? 'departmentEvents' : group.role==='supplier' ? 'ownPcns' : 'general' : 'none';
    for (const type of ['submitted','updated','completed']) defaultModes[type]=generalMode;
    const assigned=members.some(managedRecipient);
    for (const type of ['actionRequired','dueSoon','overdue']) {
      const emails=type==='actionRequired' ? actionEmails : deadlineEmails;
      const routing=members.some(user=>emails.has(verifiedIdentity(user).email.toLowerCase()));
      defaultModes[type]=assigned ? 'assigned' : routing ? 'routing' : 'none';
    }
    return {...group,members:members.map(user=>canonicalId(user.id)),
      defaultTypes:TYPES.filter(type=>defaultModes[type.key]!=='none').map(type=>type.key),defaultModes};
  });
}

function notificationPreferencesView(settings,users=[]) {
  return {...readNotificationPreferences(settings),version:hash(settings),options:{types:TYPES,groups:groupOptions(settings,users),
    users:users.filter(verifiedIdentity).map(user=>({id:canonicalId(user.id),employeeCode:user.employeeCode || '',
      displayName:user.displayName || user.mailProfile?.displayName || user.mailProfile?.name || user.employeeCode || 'PCN user',
      email:verifiedIdentity(user).email,department:user.department || null,signingStep:user.signingStep || null,
      roles:Array.isArray(user.roles) ? [...user.roles] : []}))}};
}

function assertGroupExclusionCompatibility(input,settings) {
  const previous=readNotificationPreferences(settings);
  if (TYPES.some(type=>previous.rules[type.key].excludedGroupKeys?.length
    && !Object.hasOwn(input.rules?.[type.key] || {},'excludedGroupKeys'))) {
    throw new ApiError(409,'Group notification controls changed; reload notification settings before saving');
  }
}

function classifyNotification(before,record) {
  if (['closed','rejected'].includes(record?.status) && before?.status!==record.status) return 'completed';
  if (record?.status==='submitted' && (!before || before.status==='draft')) return 'submitted';
  return 'updated';
}

function eligibleNotificationRecipient(user,record) {
  const identity=verifiedIdentity(user);
  if (!identity || !record) return null;
  try { assertRecordAccess(record,user); return {...identity,source:'custom'}; } catch { return null; }
}

function defaultEntries(value) {
  return (Array.isArray(value) ? value : [value]).flatMap(entry=>{
    if (typeof entry === 'string') return entry.split(/[;,]/).map(email=>({email:email.trim()})).filter(entry=>entry.email);
    return entry && typeof entry.email === 'string' ? [entry] : [];
  });
}

function selectNotificationRecipients(settings,type,{record,users=[],defaultRecipients=[]}={}) {
  const rule=readNotificationPreferences(settings).rules[type];
  if (!rule) throw new ApiError(400,'Invalid notification type');
  if (!rule.enabled) return {enabled:false,recipients:[]};
  const selected=users.map(user=>({user,recipient:eligibleNotificationRecipient(user,record)})).filter(entry=>entry.recipient);
  const defaults=rule.includeDefaultRecipients ? defaultEntries(defaultRecipients).map(entry=>{
    const email=emailList(entry.email);
    if (email.includes(';')) throw new ApiError(400,'Invalid notification recipient');
    const match=users.map(verifiedIdentity).find(identity=>identity?.email.toLowerCase()===email.toLowerCase());
    return {...entry,...match,email,source:'default',...(entry.userId ? {userId:canonicalId(entry.userId)} : {})};
  }) : [];
  const custom=selected.filter(({user,recipient})=>rule.userIds.includes(recipient.userId)
    || rule.groupKeys.some(key=>groupMatches(user,GROUPS.find(group=>group.key===key)))).map(entry=>entry.recipient);
  const excludedEmails=new Set(users.filter(user=>rule.excludedUserIds.includes(canonicalId(user.id))).flatMap(user=>{
    try { const email=emailList(user.email); return email.includes(';') ? [] : [email.toLowerCase()]; } catch { return []; }
  }));
  const includedEmails=new Set(selected.filter(({recipient})=>rule.userIds.includes(recipient.userId)).map(({recipient})=>recipient.email.toLowerCase()));
  const groupExcludedEmails=new Set(users.filter(user=>verifiedIdentity(user)
    && (rule.excludedGroupKeys || []).some(key=>groupMatches(user,GROUPS.find(group=>group.key===key))))
    .map(user=>verifiedIdentity(user).email.toLowerCase()));
  const recipients=[...defaults,...custom].filter(entry=>!rule.excludedUserIds.includes(canonicalId(entry.userId))
    && !excludedEmails.has(entry.email.toLowerCase())
    && (!groupExcludedEmails.has(entry.email.toLowerCase()) || includedEmails.has(entry.email.toLowerCase())));
  return {enabled:true,recipients:recipients.filter((entry,index,list)=>list.findIndex(other=>other.email.toLowerCase()===entry.email.toLowerCase())===index)};
}

function filterNotificationRecipients(settings,type,savedRecipients,context={}) {
  const current=selectNotificationRecipients(settings,type,context);
  if (!current.enabled) return current;
  const recipients=defaultEntries(savedRecipients).flatMap(saved=>{
    if (saved.source!==undefined && !['default','custom'].includes(saved.source)) return [];
    if (saved.source==='custom' && (!uuid.test(saved.userId || '') || typeof saved.directoryId!=='string' || !saved.directoryId)) return [];
    const recipient=current.recipients.find(entry=>entry.email.toLowerCase()===saved.email.toLowerCase());
    if (!recipient) return [];
    if (saved.userId) {
      if (saved.source==='custom' && canonicalId(recipient.userId)!==canonicalId(saved.userId)) return [];
      const user=(context.users || []).find(user=>canonicalId(user.id)===canonicalId(saved.userId));
      const identity=saved.source==='custom' ? eligibleNotificationRecipient(user,context.record) : verifiedIdentity(user);
      if (!identity || identity.directoryId!==saved.directoryId || identity.email.toLowerCase()!==saved.email.toLowerCase()) return [];
    }
    return [{...recipient,...saved,email:recipient.email}];
  });
  return {enabled:true,recipients:recipients.filter((entry,index,list)=>list.findIndex(other=>other.email.toLowerCase()===entry.email.toLowerCase())===index)};
}

module.exports={TYPES,GROUPS,defaultNotificationPreferences,readNotificationPreferences,
  normalizeNotificationPreferences:readNotificationPreferences,validateNotificationPreferences,notificationPreferencesView,
  assertGroupExclusionCompatibility,
  classifyNotification,classifyNotificationType:classifyNotification,eligibleNotificationRecipient,
  selectNotificationRecipients,filterNotificationRecipients};
