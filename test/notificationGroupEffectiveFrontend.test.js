'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const ui=require('../notification-settings');
const keys=ui.KEYS,defaults=['submitted','updated','completed'];
const developer={key:'role.developer',label:'PCN role — Developer',role:'developer',defaultTypes:defaults,
  defaultModes:Object.fromEntries(keys.map(key=>[key,defaults.includes(key)?'general':'none'])),members:['dev']};
function data(){return {schemaVersion:1,version:'a'.repeat(64),rules:Object.fromEntries(keys.map(key=>[key,
  {enabled:true,includeDefaultRecipients:true,groupKeys:[],userIds:[],excludedUserIds:[]}])),
  options:{types:keys.map(key=>({key,label:key,description:`${key} description`})),groups:[developer],
    users:[{id:'dev',displayName:'Developer',email:'dev@example.test',roles:['developer'],department:'developer',signingStep:null}]}};}
function fixture(fetch){const nodes=new Map(),calls=[];let active=true;const node=()=>({value:'',checked:false,disabled:false,hidden:false,textContent:'',children:[],events:{},attributes:{},
  addEventListener(key,fn){this.events[key]=fn;},setAttribute(key,value){this.attributes[key]=value;},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},focus(){}});
  const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const root={document:{getElementById:get,createElement:node},confirm:()=>true,PCN_SESSION:{async fetch(url,options){calls.push({url,options});return fetch?fetch(url,options):data();}}};
  const controller=ui.create(root,{canUse:()=>active,status(){},onDenied(){active=false;controller.clear();}});return {get,controller,calls};}
const select=(page,id,value)=>{page.get(id).value=value;page.get(id).events.change();};
const toggle=(page,key,checked)=>{page.get(`notificationGroupSelected-${key}`).checked=checked;page.get(`notificationGroupSelected-${key}`).events.change();};

test('legacy rules load with Developer effective default checkboxes and no blanket workflow subscription',async()=>{
  const page=fixture();await page.controller.open();select(page,'notificationOverviewGroup','role.developer');
  for(const key of keys)assert.equal(page.get(`notificationGroupSelected-${key}`).checked,defaults.includes(key),key);
  assert.match(page.get('notificationGroupSummary').textContent,/3 of 6/);assert.equal(page.controller.dirty(),false);
  assert.equal(page.get('notificationGroupType-submitted').textContent,'New PCN submitted');
});

test('default Developer OFF survives save/reload and ON restores defaults without adding an extra group',async()=>{
  let saved;const page=fixture((url,options)=>{if(options?.method==='PUT'){saved=JSON.parse(options.body);return {...data(),version:'b'.repeat(64),rules:saved.rules};}return saved?{...data(),rules:saved.rules}:data();});
  await page.controller.open();select(page,'notificationOverviewGroup','role.developer');toggle(page,'submitted',false);
  assert.equal(page.get('notificationGroupSelected-submitted').checked,false);assert.equal(page.controller.dirty(),true);
  await page.controller.save();assert.deepEqual(saved.rules.submitted.excludedGroupKeys,['role.developer']);
  assert.deepEqual(saved.rules.updated.excludedGroupKeys,[]);assert.deepEqual(saved.rules.submitted.groupKeys,[]);
  await page.controller.reload();assert.equal(page.get('notificationGroupSelected-submitted').checked,false);
  toggle(page,'submitted',true);await page.controller.save();assert.deepEqual(saved.rules.submitted.excludedGroupKeys,[]);assert.deepEqual(saved.rules.submitted.groupKeys,[]);
});

test('unsaved default toggles revert cleanly and global OFF stays unchecked and disabled without enabling the type',async()=>{
  const value=data();value.rules.completed.enabled=false;let sent;const page=fixture((url,options)=>{if(options?.method==='PUT')sent=JSON.parse(options.body);return value;});
  await page.controller.open();select(page,'notificationOverviewGroup','role.developer');toggle(page,'submitted',false);toggle(page,'submitted',true);
  assert.equal(page.controller.dirty(),false);assert.equal(page.get('notificationGroupSelected-completed').checked,false);assert.equal(page.get('notificationGroupSelected-completed').disabled,true);
  toggle(page,'completed',true);assert.equal(page.get('notificationGroupSelected-completed').checked,false);assert.equal(page.controller.dirty(),false);
  await page.controller.save();assert.equal(sent,undefined);
});

test('group ON works while current recipients are off, and unrelated type edits preserve an existing group block',async()=>{
  const value=data();value.rules.submitted.includeDefaultRecipients=false;value.rules.updated.excludedGroupKeys=['role.developer'];let sent;
  const page=fixture((url,options)=>{if(options?.method==='PUT'){sent=JSON.parse(options.body);return {...value,rules:sent.rules};}return value;});
  await page.controller.open();select(page,'notificationOverviewGroup','role.developer');toggle(page,'submitted',true);assert.equal(page.get('notificationGroupSelected-submitted').checked,true);
  page.get('notificationGroupConfigure-completed').events.click();page.get('notificationEnabled').checked=false;page.get('notificationEnabled').events.change();await page.controller.save();
  assert.deepEqual(sent.rules.submitted.groupKeys,['role.developer']);assert.equal(sent.rules.submitted.includeDefaultRecipients,false);assert.deepEqual(sent.rules.updated.excludedGroupKeys,['role.developer']);
});

test('conditional defaults and individual overrides appear accurately; Details can remove a group block immediately',async()=>{
  const value=data();value.options.groups[0]={...developer,defaultTypes:[...defaults,'actionRequired'],defaultModes:{...developer.defaultModes,actionRequired:'routing'}};
  value.rules.updated.excludedUserIds=['dev'];value.rules.completed.userIds=['dev'];
  const page=fixture(()=>value);await page.controller.open();select(page,'notificationOverviewGroup','role.developer');
  assert.equal(page.get('notificationGroupSelected-actionRequired').checked,true);assert.match(page.get('notificationGroupCurrent-actionRequired').textContent,/mail routing/i);
  assert.match(page.get('notificationGroupStatus-updated').textContent,/1 individual exclusion/i);assert.match(page.get('notificationGroupStatus-completed').textContent,/1 individual receive override/i);
  toggle(page,'submitted',false);page.get('notificationGroupConfigure-submitted').events.click();
  const chip=page.get('notificationExcludedGroups').children[0];assert.ok(chip);assert.equal(chip.children.at(-1).textContent,'Remove block');chip.children.at(-1).events.click();
  assert.equal(page.get('notificationGroupSelected-submitted').checked,true);
});

test('actual backend mixed-membership metadata parses and describes conditional delivery instead of rejecting the settings',async()=>{
  const {notificationPreferencesView}=require('../src/notificationPreferences');
  const users=[['qa'],['admin'],[]].map((roles,index)=>{const id=`00000000-0000-4000-8000-00000000000${index+1}`,email=`member${index}@example.test`;
    return {id,employeeCode:`000000${index+1}`,isActive:true,identityProvider:'employee-code',department:'qaTet',signingStep:index===0?'prepared':null,roles,
      email,mailDirectoryId:`directory-${index}`,mailVerifiedAt:'2026-11-24T00:00:00Z',mailProfile:{id:`directory-${index}`,email,displayName:`Member ${index}`}};});
  const response=notificationPreferencesView({},users),page=fixture(()=>response);await page.controller.open();select(page,'notificationOverviewGroup','department.qaTet.any');
  assert.equal(page.get('notificationGroupSelected-submitted').checked,true);assert.equal(page.get('notificationGroupCurrent-submitted').textContent,'Conditional delivery');
  assert.match(page.get('notificationGroupStatus-submitted').textContent,/each member/i);
});

test('removing an extra group in Details keeps its current default recipients enabled',async()=>{
  const response=data();response.rules.submitted.groupKeys=['role.developer'];const page=fixture(()=>response);await page.controller.open();select(page,'notificationOverviewGroup','role.developer');
  page.get('notificationGroupConfigure-submitted').events.click();page.get('notificationSelectedGroups').children[0].children.at(-1).events.click();
  assert.equal(page.get('notificationGroupSelected-submitted').checked,true);assert.equal(page.get('notificationGroupCurrent-submitted').textContent,'General updates');
});
