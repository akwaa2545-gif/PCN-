'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../notification-settings');

const keys = ['submitted','actionRequired','updated','completed','dueSoon','overdue'];
const userId = '00000000-0000-4000-8000-000000000001';
function response(version = 'a'.repeat(64)) {
  return { schemaVersion:1, version, rules:Object.fromEntries(keys.map(key => [key, {
    enabled:true, includeDefaultRecipients:true, groupKeys:[], userIds:[], excludedUserIds:[]
  }])), options:{ types:keys.map(key => ({key,label:key,description:`${key} description`})),
    groups:[{key:'department.qaTet.prepared',label:'QA/TET Prepared',departmentKey:'qaTet',action:'prepared'},
      {key:'role.admin',label:'PCN role — Administrator',role:'admin'},{key:'role.reviewer',label:'PCN role — Reviewer',role:'reviewer'},
      {key:'role.tapbu',label:'PCN role — TaPBU',role:'tapbu'},{key:'department.gscTapbu.any',label:'GSC/TaPBU — All signing roles',departmentKey:'gscTapbu',action:null}],
    users:[{id:userId,employeeCode:'0012345',displayName:'Admin <img src=x>',email:'admin@example.test',department:'qaTet',signingStep:null,roles:['admin']}] },
  updatedAt:null, updatedBy:null };
}
function node() {
  const value = { value:'',checked:false,disabled:false,hidden:false,textContent:'',children:[],events:{},attributes:{},
    addEventListener(name,handler){this.events[name]=handler;},setAttribute(name,text){this.attributes[name]=text;},
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=[...children];},focus(){this.focused=true;} };
  Object.defineProperty(value,'innerHTML',{set(){throw new Error('Unsafe HTML rendering');}});
  return value;
}
function fixture(fetch) {
  const nodes=new Map(),calls=[],messages=[],confirmations=[];let authorized=true;
  const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const root={document:{getElementById:get,createElement:node},confirm(text){confirmations.push(text);return root.confirmResult!==false;},
    PCN_SESSION:{async fetch(url,options){calls.push({url,options});return fetch ? fetch(url,options) : response();}}};
  const controller=ui.create(root,{canUse:()=>authorized,status:(text,error)=>messages.push({text,error}),onStateChange(){},
    onDenied(){authorized=false;controller.clear();}});
  return {get,root,calls,messages,confirmations,controller,revoke(){authorized=false;controller.clear();}};
}
const change=(page,id,value)=>{page.get(id).value=value;page.get(id).events.change?.();};
const click=(page,id)=>page.get(id).events.click();

test('notification editor loads only when opened and exposes all six independent mail types',async()=>{
  const page=fixture();assert.equal(page.calls.length,0);assert.equal(page.get('notificationEditor').hidden,true);
  await page.controller.open();assert.equal(page.calls[0].url,'/api/admin/notification-preferences');
  assert.equal(page.get('notificationType').children.length,6);
  assert.equal(page.get('notificationEnabled').checked,true);assert.equal(page.get('notificationUseDefaults').checked,true);
  assert.equal(page.controller.dirty(),false);change(page,'notificationType','overdue');
  assert.equal(page.get('notificationTypeTitle').textContent,'overdue');assert.equal(page.controller.dirty(),false);
  assert.equal(page.get('notificationSave').disabled,true);
});

test('role-first view shows all six subscription rules and truthful conditional delivery status',async()=>{
  const data=response();
  data.rules.submitted={...data.rules.submitted,groupKeys:['role.admin'],includeDefaultRecipients:false};
  data.rules.actionRequired={...data.rules.actionRequired,enabled:false,groupKeys:['role.admin']};
  data.rules.completed={...data.rules.completed,includeDefaultRecipients:false,groupKeys:['role.reviewer']};
  data.rules.dueSoon={...data.rules.dueSoon,includeDefaultRecipients:false};
  const page=fixture(()=>data);await page.controller.open();
  assert.equal(page.get('notificationView').value,'group');assert.equal(page.get('notificationGroupView').hidden,false);
  assert.equal(page.get('notificationTypeView').hidden,true);assert.equal(page.get('notificationGroupRules').hidden,true);
  assert.equal(page.get('notificationOverviewGroup').children[1].value,'role.admin');
  assert.equal(page.get('notificationOverviewGroup').children[2].value,'role.reviewer');
  change(page,'notificationOverviewGroup','role.admin');assert.equal(page.get('notificationGroupRules').hidden,false);
  assert.equal(page.get('notificationOverviewTitle').textContent,'PCN role — Administrator');
  assert.equal(page.get('notificationGroupSelected-submitted').checked,true);
  assert.equal(page.get('notificationGroupSelected-submitted').attributes['aria-label'],'Include group PCN role — Administrator for submitted');
  assert.match(page.get('notificationGroupStatus-submitted').textContent,/explicitly included.*exclusions/i);
  assert.match(page.get('notificationGroupStatus-actionRequired').textContent,/off for everyone/i);
  assert.equal(page.get('notificationGroupSelected-updated').checked,false);
  assert.equal(page.get('notificationGroupCurrent-updated').textContent,'Current recipients enabled');
  assert.match(page.get('notificationGroupStatus-updated').textContent,/administrator delivery.*department/i);
  assert.match(page.get('notificationGroupStatus-completed').textContent,/overlapping groups or individual choices/i);
  assert.match(page.get('notificationGroupStatus-dueSoon').textContent,/no recipients selected/i);
  assert.equal(page.controller.dirty(),false);
});

test('TaPBU current defaults are visible before adding subscriptions and distinguish updates from workflow mail',async()=>{
  const page=fixture();await page.controller.open();change(page,'notificationOverviewGroup','role.tapbu');
  for(const key of ['submitted','updated','completed']) {
    assert.equal(page.get(`notificationGroupCurrent-${key}`).textContent,'Current recipients enabled');
    assert.match(page.get(`notificationGroupStatus-${key}`).textContent,/eligible internal/i);
  }
  for(const key of ['actionRequired','dueSoon','overdue']) {
    assert.equal(page.get(`notificationGroupCurrent-${key}`).textContent,'When assigned to this review');
    assert.match(page.get(`notificationGroupStatus-${key}`).textContent,/active workflow step/i);
  }
  for(const key of keys) assert.equal(page.get(`notificationGroupSelected-${key}`).checked,false);
  assert.match(page.get('notificationGroupSummary').textContent,/6 email types enabled system-wide.*6 use current recipients.*0 additional group selections/i);
  assert.equal(page.controller.dirty(),false);assert.equal(page.calls.length,1);
  change(page,'notificationOverviewGroup','department.gscTapbu.any');
  assert.equal(page.get('notificationGroupCurrent-submitted').textContent,'Current recipients enabled');
});

test('current delivery badges honor globally off, custom-only and explicit subscription settings',async()=>{
  const data=response();
  data.rules.updated.enabled=false;
  data.rules.submitted={...data.rules.submitted,includeDefaultRecipients:false,userIds:[userId]};
  data.rules.completed.includeDefaultRecipients=false;
  data.rules.dueSoon={...data.rules.dueSoon,includeDefaultRecipients:false,groupKeys:['role.tapbu']};
  data.rules.overdue.groupKeys=['role.tapbu'];
  const page=fixture(()=>data);await page.controller.open();change(page,'notificationOverviewGroup','role.tapbu');
  assert.equal(page.get('notificationGroupCurrent-updated').textContent,'Off for everyone');
  assert.equal(page.get('notificationGroupCurrent-submitted').textContent,'Custom recipients only');
  assert.equal(page.get('notificationGroupCurrent-completed').textContent,'No recipients selected');
  assert.equal(page.get('notificationGroupCurrent-dueSoon').textContent,'Group subscription enabled');
  assert.equal(page.get('notificationGroupCurrent-overdue').textContent,'Current + group recipients');
  assert.match(page.get('notificationGroupStatus-submitted').textContent,/overlapping groups or individual choices/i);
  assert.match(page.get('notificationGroupStatus-overdue').textContent,/individual exclusions/i);
});

test('removing an additional group keeps saved current recipients visible and preserves all other rules',async()=>{
  const initial=response();initial.rules.submitted.groupKeys=['role.tapbu'];let saved;
  const page=fixture((url,options)=>{if(options?.method==='PUT'){saved=JSON.parse(options.body);return {...response('b'.repeat(64)),rules:saved.rules};}return saved ? {...response('b'.repeat(64)),rules:saved.rules}:initial;});
  await page.controller.open();change(page,'notificationOverviewGroup','role.tapbu');
  page.get('notificationGroupSelected-submitted').checked=false;page.get('notificationGroupSelected-submitted').events.change();
  assert.equal(page.get('notificationGroupCurrent-submitted').textContent,'Current recipients enabled');
  await page.controller.save();await page.controller.reload();
  assert.equal(page.get('notificationGroupCurrent-submitted').textContent,'Current recipients enabled');
  assert.equal(page.get('notificationGroupSelected-submitted').checked,false);
  assert.deepEqual(saved.rules.submitted,{...initial.rules.submitted,groupKeys:[]});
  for(const key of keys.filter(key=>key!=='submitted')) assert.deepEqual(saved.rules[key],initial.rules[key]);
});

test('group edits and type edits share a draft while preserving global flags and unrelated choices',async()=>{
  let saved;const data=response();
  data.rules.submitted={...data.rules.submitted,groupKeys:['role.admin','department.qaTet.prepared'],userIds:[userId]};
  data.rules.actionRequired={...data.rules.actionRequired,enabled:false,includeDefaultRecipients:false,excludedUserIds:[userId]};
  const page=fixture((url,options)=>{if(options?.method==='PUT'){saved=JSON.parse(options.body);return {...response('b'.repeat(64)),rules:saved.rules};}return data;});
  await page.controller.open();change(page,'notificationOverviewGroup','role.admin');
  page.get('notificationGroupSelected-submitted').checked=false;page.get('notificationGroupSelected-submitted').events.change();
  page.get('notificationGroupSelected-actionRequired').checked=true;page.get('notificationGroupSelected-actionRequired').events.change();
  assert.equal(page.controller.dirty(),true);assert.match(page.get('notificationGroupStatus-actionRequired').textContent,/off for everyone/i);
  click(page,'notificationGroupConfigure-submitted');assert.equal(page.get('notificationView').value,'type');
  assert.equal(page.get('notificationType').value,'submitted');assert.equal(page.get('notificationTypeView').hidden,false);
  change(page,'notificationGroupPicker','role.admin');click(page,'notificationAddGroup');
  change(page,'notificationView','group');assert.equal(page.get('notificationGroupSelected-submitted').checked,true);
  await page.controller.save();
  assert.deepEqual(saved.rules.submitted,{...data.rules.submitted,groupKeys:[...data.rules.submitted.groupKeys].sort()});
  assert.deepEqual(saved.rules.actionRequired,{...data.rules.actionRequired,groupKeys:['role.admin']});
  assert.deepEqual(saved.rules.updated,data.rules.updated);assert.equal(page.controller.dirty(),false);
  assert.equal(page.get('notificationOverviewGroup').value,'role.admin');
});

test('group-first conflict/reload preserves the selected view and clears memberships on authorization loss',async()=>{
  const conflict=new Error('Changed');conflict.status=409;
  const page=fixture((url,options)=>{if(options?.method==='PUT')throw conflict;return response();});
  await page.controller.open();change(page,'notificationOverviewGroup','role.admin');
  page.get('notificationGroupSelected-updated').checked=true;page.get('notificationGroupSelected-updated').events.change();
  await page.controller.save();assert.equal(page.get('notificationGroupSelected-updated').checked,true);
  page.root.confirmResult=false;await page.controller.reload();assert.equal(page.calls.length,2);
  page.root.confirmResult=true;await page.controller.reload();assert.equal(page.get('notificationGroupSelected-updated').checked,false);
  assert.equal(page.get('notificationView').value,'group');assert.equal(page.get('notificationOverviewGroup').value,'role.admin');
  page.revoke();assert.equal(page.get('notificationOverviewGroup').children.length,0);
  assert.equal(page.get('notificationOverviewTitle').textContent,'');assert.equal(page.get('notificationGroupRules').hidden,true);
  for(const key of keys){assert.equal(page.get(`notificationGroupSelected-${key}`).checked,false);assert.equal(page.get(`notificationGroupStatus-${key}`).textContent,'');assert.equal(page.get(`notificationGroupSelected-${key}`).attributes['aria-label'],'Include group');}
});

test('groups and individual Receive/Exclude choices save exact rules without granting signing access',async()=>{
  let saved;
  const page=fixture((url,options)=>{if(options?.method==='PUT'){saved=JSON.parse(options.body);return {...response('b'.repeat(64)),rules:saved.rules};}return response();});
  await page.controller.open();page.get('notificationUseDefaults').checked=false;page.get('notificationUseDefaults').events.change();
  change(page,'notificationGroupPicker','department.qaTet.prepared');click(page,'notificationAddGroup');
  change(page,'notificationUserPicker',userId);click(page,'notificationIncludeUser');
  change(page,'notificationUserPicker',userId);click(page,'notificationExcludeUser');
  assert.equal(page.controller.dirty(),true);assert.equal(page.get('notificationSave').disabled,false);
  await page.controller.save();
  assert.deepEqual(Object.keys(saved).sort(),['rules','schemaVersion','version']);assert.equal(saved.version,'a'.repeat(64));
  assert.deepEqual(saved.rules.submitted,{enabled:true,includeDefaultRecipients:false,groupKeys:['department.qaTet.prepared'],userIds:[],excludedUserIds:[userId]});
  assert.deepEqual(saved.rules.updated,response().rules.updated);assert.equal(page.controller.dirty(),false);
  assert.equal(page.get('notificationSave').disabled,true);
});

test('empty custom audience is clearly reported and user search renders labels as text',async()=>{
  const page=fixture();await page.controller.open();
  page.get('notificationUseDefaults').checked=false;page.get('notificationUseDefaults').events.change();
  assert.match(page.get('notificationAudienceSummary').textContent,/no recipients/i);
  page.get('notificationUserSearch').value='0012345';page.get('notificationUserSearch').events.input();
  assert.equal(page.get('notificationUserPicker').children.length,2);
  assert.match(page.get('notificationUserPicker').children[1].textContent,/<img src=x>/);
  page.get('notificationUserSearch').value='nobody';page.get('notificationUserSearch').events.input();
  assert.equal(page.get('notificationUserPicker').children.length,1);
});

test('a stale save preserves edits and reload requires discard confirmation',async()=>{
  const conflict=new Error('Changed');conflict.status=409;
  const page=fixture((url,options)=>{if(options?.method==='PUT')throw conflict;return response();});
  await page.controller.open();page.get('notificationEnabled').checked=false;page.get('notificationEnabled').events.change();
  await page.controller.save();assert.equal(page.get('notificationEnabled').checked,false);assert.equal(page.controller.dirty(),true);
  assert.match(page.messages.at(-1).text,/changed.*reload/i);
  page.root.confirmResult=false;await page.controller.reload();assert.equal(page.calls.length,2);
  page.root.confirmResult=true;await page.controller.reload();assert.equal(page.get('notificationEnabled').checked,true);
  assert.equal(page.controller.dirty(),false);
});

test('invalid partial responses cannot replace an existing notification draft',async()=>{
  let next=response();const page=fixture(()=>next);await page.controller.open();
  page.get('notificationEnabled').checked=false;page.get('notificationEnabled').events.change();
  next=response();delete next.rules.overdue;await page.controller.reload(false);
  assert.equal(page.get('notificationEnabled').checked,false);assert.equal(page.controller.dirty(),true);
  assert.match(page.messages.at(-1).text,/invalid.*settings/i);
});

test('permission revocation clears choices and prevents a late response from restoring identities',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const page=fixture(()=>pending);
  const opening=page.controller.open();assert.equal(page.controller.isBusy(),true);
  page.revoke();finish(response());await opening;
  assert.equal(page.get('notificationEditor').hidden,true);assert.equal(page.get('notificationUserPicker').children.length,0);
  assert.equal(page.get('notificationUserSearch').value,'');assert.equal(page.controller.dirty(),false);
  await page.controller.open();assert.equal(page.calls.length,1);
});

test('authorization failure hides loaded notifications and clears cached user labels',async()=>{
  const denied=new Error('Forbidden');denied.status=403;
  const page=fixture((url,options)=>{if(options?.method==='PUT')throw denied;return response();});
  await page.controller.open();page.get('notificationEnabled').checked=false;page.get('notificationEnabled').events.change();
  await page.controller.save();assert.equal(page.get('notificationEditor').hidden,true);
  assert.equal(page.get('notificationUserPicker').children.length,0);assert.equal(page.get('notificationSelectedUsers').children.length,0);
  assert.equal(page.get('notificationSave').disabled,true);
});

test('busy saves block duplicate requests and discarded in-flight replies stay hidden',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const page=fixture((url,options)=>options?.method==='PUT'?pending:response());await page.controller.open();
  page.get('notificationEnabled').checked=false;page.get('notificationEnabled').events.change();
  const saving=page.controller.save();await page.controller.save();assert.equal(page.calls.length,2);
  assert.equal(page.get('notificationFields').disabled,true);page.controller.clear();finish(response('c'.repeat(64)));await saving;
  assert.equal(page.get('notificationEditor').hidden,true);assert.equal(page.get('notificationUserPicker').children.length,0);
});
