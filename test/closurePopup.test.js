const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture({savedStatus = 'closed', refreshFails = false, saveFails = false} = {}) {
  const elements = new Map();
  const calls = [], notices = [], updates = [];
  const formControls = [{disabled:false}, {disabled:false}];
  const classes = new Set();
  const document = {activeElement:null, addEventListener() {},
    body:{classList:{contains:key=>classes.has(key),add:key=>classes.add(key),remove:key=>classes.delete(key)}},
    querySelectorAll:()=>formControls,
    getElementById(id) {
      if (!elements.has(id)) {
        const listeners = new Map();
        const element = {hidden:false, disabled:false, isConnected:true, textContent:'', open:false,
          addEventListener(type, fn) { const list=listeners.get(type)||new Set();list.add(fn);listeners.set(type,list); },
          removeEventListener(type, fn) {listeners.get(type)?.delete(fn);},
          dispatch(type, data={}) {for (const fn of [...(listeners.get(type)||[])]) fn({type,...data});},
          focus() {document.activeElement=this;},
          showModal() {this.open=true;this.shown=(this.shown||0)+1;},
          close() {this.open=false;this.dispatch('close');}
        };
        elements.set(id, element);
      }
      return elements.get(id);
    }
  };
  const saved = {id:'PCN-2026-0001',status:savedStatus,version:'2',internalReview:{}};
  const window = {location:{pathname:'/form.html'},history:{replaceState(){}},PCN_SESSION:{fetch:async(route, options={})=>{
    calls.push({route,options});
    if (options.method) {if(saveFails)throw new Error('Save rejected');return saved;}
    if(refreshFails)throw new Error('List temporarily unavailable');
    return [saved];
  }}};
  const source = fs.readFileSync(require.resolve('../app.js'),'utf8').replace(/\}\)\(\);\s*$/, `
    cacheElements();
    updateStateFromForm=()=>{};
    getSubmissionSnapshot=()=> 'snapshot';
    hasUnsavedChanges=()=>false;
    toApiPayload=request=>request;
    loadRequestToForm=record=>{state.savedRecord=record;};
    refreshPcns=async()=>{if(window.TEST_REFRESH_FAILS) throw new Error('List temporarily unavailable');state.activeRequest=window.TEST_SAVED;};
    renderAll=()=>renderDocumentEditability();
    showNotice=(...args)=>window.TEST_NOTICES.push(args);
    showSaveError=error=>window.TEST_NOTICES.push(['error','Save failed',error.message]);
    showToast=(...args)=>window.TEST_NOTICES.push(args);
    showUpdateSuccess=id=>window.TEST_UPDATES.push(id);
    window.TEST_APP={state,submitActiveRequest,renderDocumentEditability,showClosedDialog};})();`);
  Object.assign(window,{TEST_REFRESH_FAILS:refreshFails,TEST_SAVED:saved,TEST_NOTICES:notices,TEST_UPDATES:updates});
  vm.runInNewContext(source,{window,document,URLSearchParams});
  const app=window.TEST_APP;
  app.state.apiReady=true;
  app.state.activeRequest={id:saved.id,status:'qa_review',version:'1',internalReview:{}};
  app.state.savedRecord={...app.state.activeRequest};
  // This fixture starts with an already-loaded document; its pinned master is cached.
  app.state.recordMasters.set(`${saved.id}:legacy`, {formDefinitions:require('../src/masterData').formDefinitions});
  return {app,document,get:id=>document.getElementById(id),calls,notices,updates,formControls};
}

test('successful closed save opens closure dialog once without another write or update overlay',async()=>{
  const f=fixture();
  assert.equal(f.get('pcnClosedDialog').open,false);
  await f.app.submitActiveRequest();
  assert.equal(f.app.state.activeRequest.status,'closed');
  assert.equal(f.get('pcnClosedDialog').open,true);
  assert.equal(f.get('pcnClosedCode').textContent,'PCN-2026-0001');
  assert.equal(f.document.activeElement,f.get('pcnClosedContinue'));
  assert.equal(f.calls.filter(call=>call.options.method==='PATCH').length,1);
  assert.equal(f.updates.length,0);
  assert.equal(f.get('submitButton').disabled,true);
  assert.equal(f.get('saveDraftButton').hidden,true);
  assert.ok(f.formControls.every(control=>control.disabled));
  await f.app.submitActiveRequest();
  assert.equal(f.calls.filter(call=>call.options.method==='PATCH').length,1);
  assert.equal(f.get('pcnClosedDialog').shown,1);
});

test('closure response stays authoritative when records refresh fails and reports a refresh warning',async()=>{
  const f=fixture({refreshFails:true});
  await f.app.submitActiveRequest();
  assert.equal(f.app.state.activeRequest.status,'closed');
  assert.equal(f.get('pcnClosedDialog').open,true);
  assert.ok(f.notices.some(item=>item[0]==='warning'&&/refresh/i.test(item[1]+' '+item[2])));
  assert.ok(!f.notices.some(item=>item[1]==='Save failed'));
});

test('ordinary saves, failed saves and loaded closed documents do not open closure popup',async()=>{
  for (const options of [{savedStatus:'qa_review'},{saveFails:true}]) {
    const f=fixture(options);
    await f.app.submitActiveRequest();
    assert.equal(f.get('pcnClosedDialog').open,false);
  }
  const f=fixture();
  f.app.state.activeRequest.status='closed';
  f.app.renderDocumentEditability();
  await f.app.submitActiveRequest();
  assert.equal(f.get('pcnClosedDialog').open,false);
  assert.equal(f.calls.length,0);
});

test('closure dialog traps its actions, closes with Escape and returns focus to a usable control',()=>{
  const f=fixture();
  f.get('submitButton').disabled=true;
  f.get('formAdminLink').focus();
  f.app.showClosedDialog('PCN-2026-0001');
  let prevented=false;
  f.get('pcnClosedRecords').focus();
  f.get('pcnClosedDialog').dispatch('keydown',{key:'Tab',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(f.document.activeElement,f.get('pcnClosedContinue'));
  f.get('pcnClosedDialog').dispatch('cancel',{preventDefault(){}});
  assert.equal(f.get('pcnClosedDialog').open,false);
  assert.equal(f.document.activeElement,f.get('formAdminLink'));
  f.app.showClosedDialog('PCN-2026-0001');
  f.get('pcnClosedContinue').dispatch('click');
  assert.equal(f.get('pcnClosedDialog').open,false);
});

test('closure markup has named modal, explanatory text and a working closed-records destination',()=>{
  const html=fs.readFileSync(require.resolve('../form.html'),'utf8');
  assert.match(html,/<dialog[^>]*id="pcnClosedDialog"[^>]*aria-labelledby="pcnClosedTitle"[^>]*aria-describedby="pcnClosedDescription"/);
  assert.match(html,/id="pcnClosedRecords"[^>]*href="\/admin\?documents=closed#records"/);
});
