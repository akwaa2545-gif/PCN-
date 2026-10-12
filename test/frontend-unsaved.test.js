const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const controls = [
    {id:'supplierName',name:'supplierName',type:'text',tagName:'INPUT',value:'Supplier',checked:false,dataset:{}},
    {id:'reason',type:'textarea',tagName:'TEXTAREA',value:'Original reason',dataset:{}},
    {type:'checkbox',tagName:'INPUT',value:'on',checked:false,dataset:{internalField:'signoff.gscTet.approved'}}
  ];
  controls.forEach(control => { control.getAttribute = name => control[name] ?? null; });
  const prompts = [];
  const calls = [];
  const notices = [];
  const elements = {};
  let modalOpen = false;
  const document = {
    activeElement:null,
    addEventListener() {},
    querySelectorAll() { return controls; },
    getElementById(id) { return elements[id] || {querySelectorAll:()=>controls,setAttribute(){}}; },
    querySelector(selector) { return selector === 'dialog[open]' ? modalOpen ? {} : null : {querySelectorAll:()=>controls}; }
  };
  const element = () => {
    const listeners = new Map();
    return {
      isConnected:true,
      addEventListener(type,listener) {const set=listeners.get(type)||new Set();set.add(listener);listeners.set(type,set);},
      removeEventListener(type,listener) {listeners.get(type)?.delete(listener);},
      dispatchEvent(event) {for(const listener of [...(listeners.get(event.type)||[])]) listener(event);},
      focus() {document.activeElement=this;},
      click() {this.dispatchEvent({type:'click',preventDefault(){}});this.onclick?.();}
    };
  };
  const dialog = {...element(),open:false,returnValue:'',showModal() {this.open=true;prompts.push('Unsaved changes dialog');},close(value='') {this.open=false;this.returnValue=value;this.dispatchEvent({type:'close'});}};
  elements.pcnUnsavedDialog = dialog;
  elements.pcnKeepEditing = element();
  elements.pcnLeaveWithoutSaving = element();
  elements.appNotice = {hidden:false};
  elements.appNoticeTitle = {textContent:''};
  const window = {
    location:{href:'https://pcn.example.test/PCN-2026-0001',origin:'https://pcn.example.test',pathname:'/PCN-2026-0001',search:''},
    confirm() {throw new Error('In-page navigation must use the custom PCN dialog');},
    PCN_SESSION:{async fetch(...args) {calls.push(args);return {};}}
  };
  const source = fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8').replace(/\}\)\(\);\s*$/, `
    cacheElements();
    showNotice = (...args) => {window.TEST_NOTICES.push(args);els.appNotice.hidden=false;els.appNoticeTitle.textContent=args[1];};
    window.TEST_UNSAVED = {state,getSubmissionSnapshot,hasUnsavedChanges,markSubmissionSaved,confirmDiscardChanges,guardBeforeUnload,guardPageNavigation,advanceWorkflowStep,syncSavedRecordKeepingEdits,pollSavedRecord,reloadRemoteRecord,handleRemoteRefreshError,
      setupPoll(fetch,apply,notice) { apiFetch=fetch;applyRemoteRecord=apply;showRemoteChange=notice; },
      setPollBusy(value) { documentMutationBusy=value; },advanceLoadGeneration() { documentLoadGeneration++; }};})();`);
  window.TEST_NOTICES = notices;
  vm.runInNewContext(source,{window,document,URL,URLSearchParams});
  const app = window.TEST_UNSAVED;
  app.state.apiReady = true;
  app.markSubmissionSaved();
  return {app,controls,prompts,calls,notices,dialog,document,elements,setModalOpen(value) {modalOpen=value;},choose(value) {elements[value?'pcnLeaveWithoutSaving':'pcnKeepEditing'].click();}};
}

test('automatic record refresh applies a clean remote change and leaves a dirty baseline intact',async()=>{
  const {app,controls}=fixture();
  app.state.activeRequest={id:'PCN-2026-0001',version:'1'};
  app.state.savedRecord={...app.state.activeRequest};
  let applied=0, warned=0;
  app.setupPoll(async()=>({id:'PCN-2026-0001',version:'2'}),()=>applied++,()=>warned++);
  await app.pollSavedRecord();
  assert.equal(applied,1);
  controls[0].value='Unsaved edit';
  await app.pollSavedRecord();
  assert.equal(applied,1);
  assert.equal(warned,1);
  assert.equal(app.state.savedRecord.version,'1');
  assert.equal(controls[0].value,'Unsaved edit');
});

test('late user edits and manual saves make an in-flight automatic refresh safe',async()=>{
  for(const change of ['edit','save','busy','hidden']) {
    const {app,controls}=fixture();
    app.state.activeRequest={id:'PCN-2026-0001',version:'1'};
    app.state.savedRecord={...app.state.activeRequest};
    let resolve,applied=0;
    app.setupPoll(()=>new Promise(done=>resolve=done),()=>applied++,()=>{});
    let current=true;
    const polling=app.pollSavedRecord({isCurrent:()=>current});
    if(change==='edit')controls[0].value='Typed while loading';
    if(change==='save')app.state.savedRecord={...app.state.savedRecord,version:'3'};
    if(change==='busy')app.setPollBusy(true);
    if(change==='hidden')current=false;
    resolve({id:'PCN-2026-0001',version:'2'});
    await polling;
    assert.equal(applied,0,change);
  }
});

test('automatic refresh skips unsaved new records and unchanged payloads',async()=>{
  const {app}=fixture();let requests=0,applied=0;
  app.setupPoll(async()=>{requests++;return {id:'PCN-2026-0001',version:'1'};},()=>applied++,()=>{});
  app.state.activeRequest={};await app.pollSavedRecord();assert.equal(requests,0);
  app.state.activeRequest={id:'PCN-2026-0001',version:'1'};app.state.savedRecord={...app.state.activeRequest};
  await app.pollSavedRecord();assert.equal(requests,1);assert.equal(applied,0);
});

test('document metadata changes refresh even when the form version stays the same',async()=>{
  const {app}=fixture();let applied=0;
  app.state.activeRequest={id:'PCN-2026-0001',version:'1',documents:[]};
  app.state.savedRecord={...app.state.activeRequest};
  app.setupPoll(async()=>({...app.state.activeRequest,documents:[{name:'Latest attachment'}]}),()=>applied++,()=>{});
  await app.pollSavedRecord();assert.equal(applied,1);
});

test('stale automatic refresh rejections do not report access loss for a newer record or lifecycle',async()=>{
  for(const change of ['record','generation','baseline','hidden']) {
    const {app}=fixture();let reject;
    app.state.activeRequest={id:'PCN-2026-0001',version:'1'};app.state.savedRecord={...app.state.activeRequest};
    app.setupPoll(()=>new Promise((resolve,fail)=>reject=fail),()=>{},()=>{});
    let current=true;
    const pending=app.pollSavedRecord({isCurrent:()=>current});
    if(change==='record')app.state.activeRequest={id:'PCN-2026-0002',version:'1'};
    if(change==='generation')app.advanceLoadGeneration();
    if(change==='baseline')app.state.savedRecord={...app.state.savedRecord,version:'2'};
    if(change==='hidden')current=false;
    reject(Object.assign(new Error('Old record unavailable'),{status:404}));
    await pending;
    assert.equal(app.state.apiReady,true,change);
  }
});

test('current automatic refresh access revocation still reaches the existing error handler',async()=>{
  const {app}=fixture();const denied=Object.assign(new Error('Forbidden'),{status:403});
  app.state.activeRequest={id:'PCN-2026-0001',version:'1'};app.state.savedRecord={...app.state.activeRequest};
  app.setupPoll(async()=>{throw denied;},()=>{},()=>{});
  await assert.rejects(app.pollSavedRecord(),error=>error===denied);
});

test('stale explicit reload rejection leaves the newer record accessible',async()=>{
  for(const change of ['record','generation','baseline','hidden']) {
    const {app,notices}=fixture();let reject;
    app.state.activeRequest={id:'PCN-2026-0001',version:'1'};app.state.savedRecord={...app.state.activeRequest};
    app.setupPoll(()=>new Promise((resolve,fail)=>reject=fail),()=>{},()=>{});
    let current=true;
    const pending=app.reloadRemoteRecord({isCurrent:()=>current});
    await Promise.resolve();
    if(change==='record')app.state.activeRequest={id:'PCN-2026-0002',version:'1'};
    if(change==='generation')app.advanceLoadGeneration();
    if(change==='baseline')app.state.savedRecord={...app.state.savedRecord,version:'2'};
    if(change==='hidden')current=false;
    reject(Object.assign(new Error('Old record unavailable'),{status:404}));
    await pending;
    assert.equal(app.state.apiReady,true,change);
    assert.equal(notices.length,0,change);
  }
});

test('current explicit reload revocation disables the inaccessible record',async()=>{
  const {app,notices}=fixture();
  app.state.activeRequest={id:'PCN-2026-0001',version:'1'};app.state.savedRecord={...app.state.activeRequest};
  app.setupPoll(async()=>{throw Object.assign(new Error('Forbidden'),{status:403});},()=>{},()=>{});
  await app.reloadRemoteRecord();
  assert.equal(app.state.apiReady,false);
  assert.equal(notices[0][1],'PCN unavailable');
});

test('successful polling clears its paused notice without hiding a newer unrelated notice',async()=>{
  const {app,elements}=fixture();
  app.state.activeRequest={id:'PCN-2026-0001',version:'1'};app.state.savedRecord={...app.state.activeRequest};
  app.setupPoll(async()=>({...app.state.savedRecord}),()=>{},()=>{});
  app.handleRemoteRefreshError(new Error('Temporarily offline'));
  assert.equal(elements.appNoticeTitle.textContent,'Updates paused');
  assert.equal(elements.appNotice.hidden,false);
  await app.pollSavedRecord();
  assert.equal(elements.appNotice.hidden,true);
  app.handleRemoteRefreshError(new Error('Temporarily offline'));
  elements.appNoticeTitle.textContent='Save failed';
  await app.pollSavedRecord();
  assert.equal(elements.appNotice.hidden,false);
  assert.equal(elements.appNoticeTitle.textContent,'Save failed');
});

test('document workspace dialogs block both polling starts and in-flight record replacement',async()=>{
  const {app,setModalOpen}=fixture();let requests=0,applied=0,resolve;
  app.state.activeRequest={id:'PCN-2026-0001',version:'1'};app.state.savedRecord={...app.state.activeRequest};
  app.setupPoll(()=>{requests++;return new Promise(done=>resolve=done);},()=>applied++,()=>{});
  setModalOpen(true);
  const blocked=app.pollSavedRecord();
  if (resolve) resolve({...app.state.savedRecord});
  await blocked;
  assert.equal(requests,0,'an open upload dialog must preserve the record version');
  setModalOpen(false);
  const pending=app.pollSavedRecord();
  assert.equal(requests,1);
  setModalOpen(true);
  resolve({id:'PCN-2026-0001',version:'2'});
  await pending;
  assert.equal(applied,0,'a dialog opened during the fetch must keep its version identity');
});

function unloadEvent() {
  return {defaultPrevented:false,preventDefault() {this.defaultPrevented=true;}};
}

function clickEvent(href,options={}) {
  const link = {href,target:'',download:'',isConnected:true,clicks:0,click() {this.clicks+=1;},getAttribute(name) {return name==='href'?href:name==='target'?this.target:null;},hasAttribute(name) {return name==='download'&&Boolean(this.download);}};
  return {button:0,...options,target:{closest(selector) {return selector.includes('account-sign-out')?null:link;}},
    link,defaultPrevented:false,stopped:false,preventDefault() {this.defaultPrevented=true;},stopImmediatePropagation() {this.stopped=true;}};
}

test('unsaved document comparison detects edits and restores pristine status when reverted',()=>{
  const {app,controls} = fixture();
  assert.equal(app.hasUnsavedChanges(),false);
  controls[0].value = 'แก้ไข <supplier> 😀';
  assert.equal(app.hasUnsavedChanges(),true);
  controls[0].value = 'Supplier';
  assert.equal(app.hasUnsavedChanges(),false);
  controls[1].value = '';
  assert.equal(app.hasUnsavedChanges(),true);
  app.markSubmissionSaved();
  assert.equal(app.hasUnsavedChanges(),false);
});

test('signatures and dynamically recreated document rows count as unsaved changes',()=>{
  const {app,controls} = fixture();
  controls[2].checked = true;
  assert.equal(app.hasUnsavedChanges(),true);
  app.markSubmissionSaved();
  controls.push({tagName:'TEXTAREA',type:'textarea',value:'New condition',dataset:{},getAttribute(){return null;}});
  assert.equal(app.hasUnsavedChanges(),true);
  app.markSubmissionSaved();
  controls[3].value = 'Revised condition';
  assert.equal(app.hasUnsavedChanges(),true);
});

test('late edits survive a save while signer identity and saved baseline become canonical',()=>{
  const {app,controls}=fixture();
  controls.push({type:'text',tagName:'INPUT',value:'',dataset:{internalField:'signoff.gscTet.approvedName'}},
    {type:'text',tagName:'INPUT',value:'',dataset:{internalField:'signoff.gscTet.approvedDate'}});
  controls[2].checked=true;
  app.state.activeRequest={id:'PCN-2026-0001',internalReview:{signoff:{gscTet:{approved:true}}}};
  app.markSubmissionSaved();
  controls[1].value='Later edit';
  app.syncSavedRecordKeepingEdits({id:'PCN-2026-0001',version:'0000000000000002',status:'submitted',
    internalReview:{signoff:{gscTet:{approved:true,approvedName:'Canonical Signer',approvedDate:'2026-10-09'}}}});
  assert.equal(controls[1].value,'Later edit');
  assert.equal(controls[3].value,'Canonical Signer');
  assert.equal(app.state.loadedReview.signoff.gscTet.approved,true);
  assert.equal(app.state.activeRequest.internalReview.signoff.gscTet.approvedDate,'2026-10-09');
  assert.equal(app.hasUnsavedChanges(),true);
  controls[1].value='Original reason';
  assert.equal(app.hasUnsavedChanges(),false,'server-owned signer metadata must not create phantom edits');
});

test('disabled status, handwriting and tooltip changes are not document edits',()=>{
  const {app,controls} = fixture();
  controls[2].disabled = true;
  controls[2].title = 'Signed by Someone';
  controls[2].className = 'handwritten-signoff';
  assert.equal(app.hasUnsavedChanges(),false);
});

test('saving a submitted snapshot does not mark subsequent document edits as saved',()=>{
  const {app,controls} = fixture();
  controls[0].value = 'Submitted supplier';
  const submitted = app.getSubmissionSnapshot();
  controls[0].value = 'Later edit';
  app.markSubmissionSaved(submitted);
  assert.equal(app.hasUnsavedChanges(),true);
  controls[0].value = 'Submitted supplier';
  assert.equal(app.hasUnsavedChanges(),false);
});

test('workflow advancement cannot silently replace unsaved document values',async()=>{
  const {app,controls,calls,notices} = fixture();
  app.state.activeRequest = {id:'PCN-2026-0001',status:'submitted',version:'0000000000000001'};
  controls[1].value = 'Reason not submitted';
  await app.advanceWorkflowStep('technical_review');
  assert.equal(calls.length,0,'A workflow status PATCH would otherwise reload and discard this document');
  assert.equal(app.hasUnsavedChanges(),true);
  assert.equal(notices.at(-1)[0],'warning');
  assert.match(notices.at(-1).join(' '),/save|update/i);
});

test('loading, read-only and absent baseline documents never warn',async()=>{
  const {app,controls,prompts} = fixture();
  controls[0].value = 'Different';
  for(const change of [{apiReady:false},{apiReady:true,viewOnly:true},{viewOnly:false,savedSubmissionSnapshot:null}]) {
    Object.assign(app.state,change);
    assert.equal(app.hasUnsavedChanges(),false);
    assert.equal(await app.confirmDiscardChanges(),true);
  }
  assert.equal(prompts.length,0);
});

test('custom dialog cancellation preserves changes and explicit leave permits departure',async()=>{
  const {app,controls,prompts,dialog,choose} = fixture();
  controls[0].value = 'Changed';
  const canceled = app.confirmDiscardChanges();
  assert.equal(dialog.open,true);
  choose(false);
  assert.equal(await canceled,false);
  assert.equal(dialog.open,false);
  assert.equal(app.hasUnsavedChanges(),true);
  assert.equal(prompts.length,1);
  const accepted = app.confirmDiscardChanges();
  choose(true);
  assert.equal(await accepted,true);
  assert.equal(app.hasUnsavedChanges(),true,'A leave confirmation does not pretend edits were saved');
});

test('Escape cancels the custom warning and never discards document edits',async()=>{
  const {app,controls,dialog} = fixture();
  controls[0].value = 'Changed';
  const pending = app.confirmDiscardChanges();
  dialog.dispatchEvent({type:'cancel',preventDefault(){}});
  assert.equal(await pending,false);
  assert.equal(dialog.open,false);
  assert.equal(app.hasUnsavedChanges(),true);
});

test('repeated leave requests cannot create multiple pending discard decisions',async()=>{
  const {app,controls,prompts,choose} = fixture();
  controls[0].value = 'Changed';
  const original = app.confirmDiscardChanges();
  assert.equal(await app.confirmDiscardChanges(),false,'A second action cannot share an eventual leave authorization');
  assert.equal(prompts.length,1,'Only one warning opens at a time');
  choose(false);
  assert.equal(await original,false);
  const reopened = app.confirmDiscardChanges();
  choose(true);
  assert.equal(await reopened,true,'Closing the first dialog allows a fresh independent decision');
  assert.equal(prompts.length,2);
});

test('browser unload blocks dirty pages and a confirmed departure bypass lasts only once',()=>{
  const {app,controls} = fixture();
  const pristine = unloadEvent();
  app.guardBeforeUnload(pristine);
  assert.equal(pristine.defaultPrevented,false);
  controls[0].value = 'Changed';
  const dirty = unloadEvent();
  app.guardBeforeUnload(dirty);
  assert.equal(dirty.defaultPrevented,true);
  assert.equal(dirty.returnValue,'');
  app.state.skipNextUnload = true;
  const confirmed = unloadEvent();
  app.guardBeforeUnload(confirmed);
  assert.equal(confirmed.defaultPrevented,false);
  const later = unloadEvent();
  app.guardBeforeUnload(later);
  assert.equal(later.defaultPrevented,true);
});

test('same-tab navigation is stopped synchronously and replays once only after explicit leave',async()=>{
  const {app,controls,choose} = fixture();
  controls[0].value = 'Changed';
  const canceled = clickEvent('https://pcn.example.test/records');
  const canceledNavigation = app.guardPageNavigation(canceled);
  assert.equal(canceled.defaultPrevented,true);
  assert.equal(canceled.stopped,true);
  assert.notEqual(app.state.skipNextUnload,true);
  choose(false);
  await canceledNavigation;
  assert.equal(canceled.link.clicks,0);
  const accepted = clickEvent('https://pcn.example.test/records');
  const acceptedNavigation = app.guardPageNavigation(accepted);
  assert.equal(accepted.defaultPrevented,true);
  assert.equal(accepted.link.clicks,0);
  choose(true);
  await acceptedNavigation;
  assert.equal(accepted.link.clicks,1);
  assert.equal(app.state.skipNextUnload,true);
});

test('modified sign-out clicks still require confirmation before revoking the session',async()=>{
  const {app,controls,prompts,choose} = fixture();
  controls[0].value = 'Changed document';
  for(const modifier of ['ctrlKey','metaKey','shiftKey','altKey']) {
    const event = clickEvent('',{[modifier]:true});
    const signOut = {isConnected:true,clicks:0,click(){this.clicks+=1;}};
    event.target.closest = selector => selector === '.account-sign-out' ? signOut : null;
    const navigation = app.guardPageNavigation(event);
    assert.equal(event.defaultPrevented,true,modifier+' cannot bypass confirmation');
    assert.equal(event.stopped,true,modifier+' cannot reach the logout handler');
    assert.notEqual(app.state.skipNextUnload,true);
    choose(false);
    await navigation;
    assert.equal(signOut.clicks,0);
  }
  assert.equal(prompts.length,4);
});

test('in-page anchors, downloads and new-tab gestures do not discard the document',()=>{
  const {app,controls,prompts} = fixture();
  controls[0].value = 'Changed';
  for(const [href,options] of [
    ['https://pcn.example.test/PCN-2026-0001#workflow',{}],
    ['https://pcn.example.test/records',{ctrlKey:true}],
    ['https://pcn.example.test/records',{metaKey:true}],
    ['https://pcn.example.test/records',{shiftKey:true}],
    ['https://pcn.example.test/records',{button:1}],
    ['mailto:user@example.test',{}]
  ]) {
    const event = clickEvent(href,options);
    app.guardPageNavigation(event);
    assert.equal(event.defaultPrevented,false);
  }
  assert.equal(prompts.length,0);
});
