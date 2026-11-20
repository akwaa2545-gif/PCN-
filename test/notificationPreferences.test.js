const test = require('node:test');
const assert = require('node:assert/strict');
const { TYPES, GROUPS, defaultNotificationPreferences, readNotificationPreferences, validateNotificationPreferences,
  classifyNotification, eligibleNotificationRecipient, selectNotificationRecipients, filterNotificationRecipients,notificationPreferencesView } = require('../src/notificationPreferences');

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (n, changes = {}) => ({ id:id(n), employeeCode:String(n).padStart(7,'0'), isActive:true,
  identityProvider:'employee-code', department:'gscTet', signingStep:'prepared', roles:['gsc'],
  email:`user${n}@example.test`, mailDirectoryId:`directory-${n}`, mailVerifiedAt:'2026-11-20T00:00:00Z',
  mailProfile:{id:`directory-${n}`,email:`user${n}@example.test`,displayName:`User ${n}`}, ...changes });
const record = { id:'T-20112601', status:'submitted', ownerUserId:id(9) };
const policy = (key, changes) => { const value=defaultNotificationPreferences(); return {...value,rules:{...value.rules,[key]:{...value.rules[key],...changes}}}; };
const input = value => ({schemaVersion:1,version:'a'.repeat(64),rules:value.rules});

test('notification preferences default to all six existing audiences without sharing mutable objects',()=>{
  const value=readNotificationPreferences({schemaVersion:2,groups:[]});
  assert.equal(TYPES.length,6);assert.equal(GROUPS.length,36);
  for(const type of TYPES) assert.deepEqual(value.rules[type.key],{enabled:true,includeDefaultRecipients:true,groupKeys:[],userIds:[],excludedUserIds:[]});
  value.rules.submitted.userIds.push(id(1));assert.deepEqual(defaultNotificationPreferences().rules.submitted.userIds,[]);
});

test('preference validation rejects unexpected fields, incomplete rules, malformed versions and ambiguous audiences',()=>{
  const body=input(defaultNotificationPreferences());
  assert.deepEqual(validateNotificationPreferences(body).rules,body.rules);
  for(const invalid of [{...body,extra:true},{...body,version:'bad'},{...body,schemaVersion:2},
    {...body,rules:{...body.rules,submitted:undefined}},
    input(policy('submitted',{enabled:'true'})),input(policy('submitted',{groupKeys:['department.unknown.prepared']})),
    input(policy('submitted',{userIds:['not-an-id']})),input(policy('submitted',{userIds:[id(1),id(1)]})),
    input(policy('submitted',{userIds:[id(1)],excludedUserIds:[id(1)]})),
    input(policy('submitted',{groupKeys:['department.gscTet.any','department.gscTet.any']}))]) {
    assert.throws(()=>validateNotificationPreferences(invalid),{statusCode:400});
  }
  assert.throws(()=>validateNotificationPreferences(input(policy('submitted',{userIds:[id(2)]})),[user(1)]),{statusCode:400});
});

test('PCN role groups include Administrator and Developer as distinct audiences',()=>{
  const admin=user(1,{roles:['ADMIN'],department:'it',signingStep:null});
  const developer=user(2,{roles:['developer'],department:'developer',signingStep:null});
  const invalidDeveloper=user(3,{roles:['developer','qa'],department:'qaTet',signingStep:'prepared'});
  assert.equal(GROUPS.find(group=>group.key==='role.admin').label,'PCN role — Administrator');
  assert.equal(GROUPS.find(group=>group.key==='role.developer').label,'PCN role — Developer');
  for(const [groupKey,expected] of [['role.admin',[admin.email]],['role.developer',[developer.email]]]) {
    const settings={notificationPreferences:policy('submitted',{includeDefaultRecipients:false,groupKeys:[groupKey]})};
    assert.doesNotThrow(()=>validateNotificationPreferences(input(settings.notificationPreferences)));
    assert.deepEqual(selectNotificationRecipients(settings,'submitted',{record,users:[admin,developer,invalidDeveloper]}).recipients.map(entry=>entry.email),expected);
  }
});

test('all PCN role selectors retain verification, access, exclusions and old department rules',()=>{
  const roles=['reviewer','gsc','productionengineering','qa','tapbu','supplier'];
  for(const role of roles) {
    const owner=user(9,{roles:[role],department:null,signingStep:null});
    const inactive=user(2,{roles:[role],isActive:false});
    const unverified=user(3,{roles:[role],mailVerifiedAt:null});
    const settings={notificationPreferences:policy('updated',{includeDefaultRecipients:false,groupKeys:[`role.${role}`]})};
    assert.deepEqual(selectNotificationRecipients(settings,'updated',{record,users:[owner,inactive,unverified]}).recipients.map(entry=>entry.email),[owner.email]);
    const excluded={notificationPreferences:policy('updated',{includeDefaultRecipients:false,groupKeys:[`role.${role}`],excludedUserIds:[owner.id]})};
    assert.deepEqual(selectNotificationRecipients(excluded,'updated',{record,users:[owner]}).recipients,[]);
  }
  const foreignSupplier=user(1,{roles:['supplier']});
  assert.deepEqual(selectNotificationRecipients({notificationPreferences:policy('updated',{includeDefaultRecipients:false,groupKeys:['role.supplier']})},'updated',{record,users:[foreignSupplier]}).recipients,[]);
});

test('queued role-group notifications remove former role members without adding new members',()=>{
  const admin=user(1,{roles:['admin'],department:'it',signingStep:null});
  const newcomer=user(2,{roles:['admin'],department:'it',signingStep:null});
  const settings={notificationPreferences:policy('submitted',{includeDefaultRecipients:false,groupKeys:['role.admin']})};
  const saved=selectNotificationRecipients(settings,'submitted',{record,users:[admin]}).recipients;
  assert.deepEqual(filterNotificationRecipients(settings,'submitted',saved,{record,users:[admin,newcomer]}).recipients.map(entry=>entry.email),[admin.email]);
  assert.deepEqual(filterNotificationRecipients(settings,'submitted',saved,{record,users:[{...admin,roles:['reviewer']},newcomer]}).recipients,[]);
});

test('corrupt saved preferences fail closed while absence preserves legacy settings',()=>{
  for(const invalid of [true,[],null,'settings']) assert.throws(()=>readNotificationPreferences(invalid),{statusCode:503});
  for(const notificationPreferences of [null,{},[],{schemaVersion:1,rules:{}},
    {...defaultNotificationPreferences(),extra:true},policy('updated',{userIds:['bad']})]) {
    assert.throws(()=>readNotificationPreferences({notificationPreferences}),{statusCode:503});
  }
  assert.equal(readNotificationPreferences({notificationPreferences:defaultNotificationPreferences()}).rules.updated.enabled,true);
  assert.equal(classifyNotification(null,record),'submitted');
  assert.equal(classifyNotification({...record,status:'draft'},record),'submitted');
  assert.equal(classifyNotification(record,{...record,status:'closed'}),'completed');
  assert.equal(classifyNotification(record,{...record,status:'rejected'}),'completed');
  assert.equal(classifyNotification(record,{...record,materialName:'new'}),'updated');
});

test('inactive exclusions suppress manual default contacts and remain valid while options expose verified users only',()=>{
  const users=[user(1,{isActive:false}),user(2,{mailVerifiedAt:null}),user(3)];
  const preferences=policy('updated',{excludedUserIds:[id(1),id(2)]});
  assert.deepEqual(validateNotificationPreferences(input(preferences),users).rules.updated.excludedUserIds,[id(1),id(2)]);
  assert.deepEqual(selectNotificationRecipients({notificationPreferences:preferences},'updated',{record,users,
    defaultRecipients:'user1@example.test; user2@example.test; manual@example.test'}).recipients.map(entry=>entry.email),['manual@example.test']);
  const view=notificationPreferencesView({notificationPreferences:preferences},users);
  assert.deepEqual(view.options.users.map(entry=>entry.id),[id(3)]);
  for(const field of ['mailProfile','mailDirectoryId','passwordHash','securityStamp','photo']) assert.equal(Object.hasOwn(view.options.users[0],field),false);
});

test('saved custom selections cannot transfer to another selected identity sharing the same email',()=>{
  const first=user(1),second=user(2,{email:first.email,mailProfile:{id:'directory-2',email:first.email}});
  const settings={notificationPreferences:policy('updated',{includeDefaultRecipients:false,userIds:[id(1)]})};
  const saved=selectNotificationRecipients(settings,'updated',{record,users:[first,second]}).recipients;
  const switched={notificationPreferences:policy('updated',{includeDefaultRecipients:false,userIds:[id(2)]})};
  assert.deepEqual(filterNotificationRecipients(switched,'updated',saved,{record,users:[first,second]}).recipients,[]);
});

test('custom recipients require active verified employee identities and actual PCN read access',()=>{
  assert.equal(eligibleNotificationRecipient(user(1),record).email,'user1@example.test');
  assert.equal(eligibleNotificationRecipient(user(2,{roles:[],department:null,signingStep:null}),record).email,'user2@example.test');
  assert.equal(eligibleNotificationRecipient(user(9,{roles:['supplier'],department:null}),record).email,'user9@example.test');
  for(const changes of [{isActive:false},{identityProvider:'password'},{mailVerifiedAt:null},{mailDirectoryId:null},
    {mailProfile:{id:'different',email:'user1@example.test'}},{email:'other@example.test'},
    {roles:['supplier'],department:null}]) assert.equal(eligibleNotificationRecipient(user(1,changes),record),null);
});

test('default routing, custom department/step/user picks and exclusions combine without duplicate addresses',()=>{
  const users=[user(1),user(2,{signingStep:'checked'}),user(3,{department:'qaTet',roles:['qa']})];
  const settings={notificationPreferences:policy('actionRequired',{groupKeys:['department.gscTet.prepared'],userIds:[id(3)],excludedUserIds:[id(2)]})};
  const result=selectNotificationRecipients(settings,'actionRequired',{record,users,defaultRecipients:'manual@example.test; user2@example.test; user1@example.test'});
  assert.equal(result.enabled,true);
  assert.deepEqual(result.recipients.map(entry=>entry.email).sort(),['manual@example.test','user1@example.test','user3@example.test']);
  const only=selectNotificationRecipients({notificationPreferences:policy('updated',{includeDefaultRecipients:false,groupKeys:['department.gscTet.any']})},'updated',{record,users,defaultRecipients:'manual@example.test'});
  assert.deepEqual(only.recipients.map(entry=>entry.email).sort(),['user1@example.test','user2@example.test']);
  assert.deepEqual(selectNotificationRecipients({notificationPreferences:policy('overdue',{enabled:false})},'overdue',{record,users,defaultRecipients:'manual@example.test'}),{enabled:false,recipients:[]});
});

test('pending preference filtering only removes saved recipients and revalidates identities and current policy',()=>{
  const users=[user(1),user(2)];
  const settings={notificationPreferences:policy('updated',{includeDefaultRecipients:false,userIds:[id(1)]})};
  const saved=selectNotificationRecipients(settings,'updated',{record,users}).recipients;
  for(const invalid of [{email:'user1@example.test',source:'custom'},{...saved[0],directoryId:null},{...saved[0],source:'unknown'}]) {
    assert.deepEqual(filterNotificationRecipients(settings,'updated',[invalid],{record,users}).recipients,[]);
  }
  const expanded={notificationPreferences:policy('updated',{includeDefaultRecipients:false,userIds:[id(1),id(2)]})};
  assert.deepEqual(filterNotificationRecipients(expanded,'updated',saved,{record,users}).recipients.map(entry=>entry.email),['user1@example.test']);
  assert.deepEqual(filterNotificationRecipients(expanded,'updated',saved,{record,users:[user(1,{mailDirectoryId:'new-directory',mailProfile:{id:'new-directory',email:'user1@example.test'}})]}).recipients,[]);
  assert.deepEqual(filterNotificationRecipients({notificationPreferences:policy('updated',{enabled:false})},'updated',saved,{record,users}).recipients,[]);
  assert.deepEqual(filterNotificationRecipients({},'updated',[{email:'manual@example.test'}],{record,users,defaultRecipients:'manual@example.test'}).recipients.map(entry=>entry.email),['manual@example.test']);
});
