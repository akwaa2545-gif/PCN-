const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function fixture(options={}) {
  const id='PCN-2026-0001',version='1234567890abcdef';
  const calls=[],messages=[],notices=[],classes=new Set();
  const record={id,version,status:'draft',supplierName:'Preview supplier',internalReview:{},documentControl:{contentRevision:2}};
  const stampNodes={documentPrintIdentity:{textContent:''},documentPrintWatermark:{textContent:'',hidden:true}};
  const master={formDefinitions:{rawMaterial:{id:'rawMaterial',riskOptions:[]}},commonDocuments:[],workflowBase:[]};
  const window={location:{pathname:options.pathname || '/document-preview',search:options.search ?? `?id=${id}&version=${version}&request=1`,origin:'http://preview.test',assign:value=>calls.push(['redirect',value])},
    PCN_SESSION:{require:async()=>({user:{id:'owner',identityProvider:'employee-code',employeeCode:'0000001',roles:['admin']}}),mountProfile:()=>calls.push(['profile']),
      fetch:async(route,settings)=>{calls.push([route,settings]);if(route==='/api/master-data')return master;if(route==='/api/pcns')return [record];if(options.error)throw new Error(options.error);return {...record,...options.record};}},
    PCN_DOCUMENT_BRIDGE:{exportStamp:require('../document-bridge').exportStamp,mount:()=>{calls.push(['bridge']);return {loaded:()=>calls.push(['bridge-loaded'])};}},
    PCN_AUTO_REFRESH:{start:()=>calls.push(['auto-refresh'])}};
  window.parent=options.topLevel?window:{postMessage:(message,origin)=>messages.push({message,origin})};
  const document={addEventListener(){},getElementById:id=>stampNodes[id] || null,body:{classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)}}};
  const source=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8').replace(/\}\)\(\);\s*$/,`
    cacheElements=()=>{els.submitButton={disabled:false};};
    bindEvents=()=>{};populateSelectors=()=>{};
    loadRequestToForm=record=>{state.savedRecord=record;};
    renderAll=()=>{window.rendered={viewOnly:state.viewOnly,record:state.activeRequest};};
    showNotice=(...args)=>window.testNotices.push(args);
    window.PCN_PREVIEW_TEST={init,state,apiFetch};})();`);
  window.testNotices=notices;
  vm.runInNewContext(source,{window,document,URLSearchParams});
  return {app:window.PCN_PREVIEW_TEST,calls,messages,notices,classes,window,id,version,stampNodes};
}

test('Dedicated preview renders the exact saved version read-only without profile, workspace or polling',async()=>{
  const f=fixture();await f.app.init();
  assert.equal(f.app.state.viewOnly,true);
  assert.equal(f.window.rendered.record.id,f.id);
  assert.equal(f.classes.has('document-preview-only'),true);
  assert.equal(f.calls.some(([name])=>['profile','bridge','auto-refresh'].includes(name)),false);
  assert.deepEqual(f.calls.map(([name])=>name),['/api/master-data',`/api/pcns/${f.id}`]);
  assert.equal(f.messages.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages[0])),{origin:'http://preview.test',message:{type:'pcn-document-preview',state:'ready',id:f.id,version:f.version,request:'1'}});
});

test('Preview rejects invalid or missing identifiers before loading any record or demo',async()=>{
  for(const search of ['','?id=bad&version=1234567890abcdef','?id=PCN-2026-0001','?id=PCN-2026-0001&version=bad']){
    const f=fixture({search});await f.app.init();
    assert.equal(f.app.state.apiReady,false);
    assert.equal(f.calls.some(([name])=>name.startsWith('/api/')),false);
    assert.equal(f.messages[0]?.message.state,'error');
    assert.match(f.messages[0]?.message.message || '',/preview|version|document/i);
    assert.equal(f.messages.some(item=>item.message.state==='ready'),false);
  }
});

test('Preview refuses changed versions and mismatched record identities',async()=>{
  for(const record of [{version:'fedcba0987654321'},{id:'PCN-2026-0002'}]){
    const f=fixture({record});await f.app.init();
    assert.equal(f.app.state.apiReady,false);
    assert.equal(f.messages[0]?.message.state,'error');
    assert.equal(f.messages[0]?.message.request,'1');
    assert.equal(f.messages.some(item=>item.message.state==='ready'),false);
  }
});

test('Preview API wrapper rejects mutations even for an administrator',async()=>{
  const f=fixture();await f.app.init();const before=f.calls.length;
  await assert.rejects(f.app.apiFetch(`/api/pcns/${f.id}`,{method:'PATCH',body:'{}'}),/read.only|role|required|preview/i);
  assert.equal(f.calls.length,before);
  await f.app.apiFetch(`/api/pcns/${f.id}`);
  assert.equal(f.calls.length,before+1);
});

test('Preview read failure reports an error to the parent without a ready message',async()=>{
  const f=fixture({error:'PCN not found'});await f.app.init();
  assert.equal(f.app.state.apiReady,false);
  assert.equal(f.messages[0]?.message.state,'error');
  assert.match(f.messages[0]?.message.message || '',/PCN not found/);
});

test('Ordinary form route retains its editable initialization and never messages a parent',async()=>{
  const f=fixture({pathname:'/form.html'});await f.app.init();
  assert.equal(f.app.state.viewOnly,false);
  assert.equal(f.classes.has('document-preview-only'),false);
  for(const name of ['profile','bridge','auto-refresh'])assert.equal(f.calls.some(([call])=>call===name),true);
  assert.equal(f.calls.some(([name])=>name==='/api/pcns'),true);
  assert.equal(f.messages.length,0);
});

test('Top-level preview does not post messages to itself',async()=>{
  const f=fixture({topLevel:true});await f.app.init();
  assert.equal(f.app.state.viewOnly,true);
  assert.equal(f.messages.length,0);
});

test('Preview without an optional request token remains read-only and omits that message field',async()=>{
  const f=fixture({search:'?id=PCN-2026-0001&version=1234567890abcdef'});await f.app.init();
  assert.equal(f.app.state.viewOnly,true);
  assert.equal(f.messages[0]?.message.state,'ready');
  assert.equal(Object.hasOwn(f.messages[0].message,'request'),false);
});

test('Preview stamps its saved identity and draft watermark without mounting document controls',async()=>{
  const f=fixture();await f.app.init();
  assert.equal(f.stampNodes.documentPrintIdentity.textContent,'PCN-2026-0001 · Content revision 2 · DRAFT');
  assert.equal(f.stampNodes.documentPrintWatermark.textContent,'DRAFT');
  assert.equal(f.stampNodes.documentPrintWatermark.hidden,false);
  assert.equal(f.calls.some(([name])=>name==='bridge'),false);
});
