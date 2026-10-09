const test = require('node:test');
const assert = require('node:assert/strict');
const workspace = require('../document-workspace');

test('attachment actions require saved, clean, editable document', () => {
  const context = {record:{id:'PCN-2026-0001',version:'1',status:'Draft'},ready:true,dirty:false};
  assert.equal(workspace.canMutate(context),true);
  for (const extra of [{dirty:true},{ready:false},{viewOnly:true}]) assert.equal(workspace.canMutate({...context,...extra}),false);
  assert.equal(workspace.canMutate({...context,record:{...context.record,status:'Closed'}}),false);
  assert.equal(workspace.canMutate({...context,record:{}}),false);
});

test('only scanner-approved files permit download', () => {
  assert.equal(workspace.canDownload({scanStatus:'clean'}),true);
  for (const scanStatus of ['pendingScan','infected','failed','',undefined,'Clean']) assert.equal(workspace.canDownload({scanStatus}),false);
});

test('normalized revisions retain full values without HTML rendering', () => {
  const entry = workspace.normalizeRevision({contentRevision:3,changedBy:'User',changes:[{field:'supplier.name',before:'<script>x</script>',after:'New'}]});
  assert.equal(entry.number,3);
  assert.equal(entry.changes[0].before,'<script>x</script>');
  assert.equal(workspace.displayValue({b:false,a:2}),'a: 2; b: No');
});

test('history addresses save sequence separately from content revision', () => {
  const entry=workspace.normalizeRevision({revision:7,contentRevision:2,snapshot:{documentControl:{revisionReason:'Specification changed'}}});
  assert.equal(entry.number,7);
  assert.equal(entry.contentRevision,2);
  assert.equal(entry.reason,'Specification changed');
});

test('field values preserve zero and distinguish empty from false', () => {
  assert.equal(workspace.displayValue(0),'0');
  assert.equal(workspace.displayValue(false),'No');
  assert.equal(workspace.displayValue(null),'—');
  assert.equal(workspace.displayValue(['one','two']),'one, two');
});

test('file payload preserves metadata and optimistic version', () => {
  assert.deepEqual(workspace.filePayload({name:'report.txt',type:'text/plain',size:3},'YWJj','v1','Test report'),{fileName:'report.txt',contentType:'text/plain',base64:'YWJj',version:'v1',requirementName:'Test report'});
  assert.throws(()=>workspace.filePayload({name:'large.pdf',type:'application/pdf',size:11*1024*1024},'YQ==','v1'),/10 MiB/);
  assert.throws(()=>workspace.filePayload({name:'file.html',type:'text/html',size:3},'YWJj','v1'),/PDF/);
});

test('download filename strips path and control characters', () => {
  assert.equal(workspace.downloadName('../unsafe\\name\n.pdf'),'.._unsafe_name_.pdf');
  assert.equal(workspace.downloadName(''),'document');
});

test('history envelopes accept canonical API lists', () => {
  assert.deepEqual(workspace.asItems({items:[{id:1}]}),[{id:1}]);
  assert.deepEqual(workspace.asItems([1]),[1]);
  assert.deepEqual(workspace.asItems({revisions:[2]}),[2]);
  assert.deepEqual(workspace.asItems(null),[]);
  assert.deepEqual(workspace.asItems({items:{bad:true}}),[]);
});

test('sizes show understandable units', () => {
  assert.equal(workspace.formatSize(1024),'1.0 KiB');
  assert.equal(workspace.formatSize(2*1024*1024),'2.0 MiB');
  assert.equal(workspace.formatSize(0),'0 B');
});

function domFixture(context,apiFetch) {
  class Element {
    constructor(tag) {this.tagName=tag.toUpperCase();this.children=[];this.attributes={};this.dataset={};this.listeners=new Map();this.classList={add(){}};this.textContent='';}
    append(...children) {this.children.push(...children);}
    replaceChildren(...children) {this.children=[...children];}
    setAttribute(name,value) {this.attributes[name]=value;}
    addEventListener(name,callback) {this.listeners.set(name,callback);}
    querySelector() {return null;}
  }
  const document={createElement:tag=>new Element(tag),body:new Element('body')};
  const container=new Element('div');container.ownerDocument=document;
  const control=workspace.mount({container,getContext:()=>context.value,apiFetch});
  const text=element=>[element.textContent,...element.children.map(text)].join(' ');
  const buttons=element=>[...(element.tagName==='BUTTON' ? [element] : []),...element.children.flatMap(buttons)];
  return {control,container,text,buttons};
}

test('workspace drops an old record response after selecting another document',async()=>{
  const context={value:{record:{id:'PCN-2026-0001',version:'v1',status:'draft'},ready:true}};
  const pending=[];
  const fixture=domFixture(context,url=>new Promise(resolve=>pending.push({url,resolve})));
  const first=fixture.control.refresh();
  context.value={...context.value,record:{id:'PCN-2026-0002',version:'v2',status:'submitted'}};
  const second=fixture.control.refresh();
  for(const item of pending.slice(4))item.resolve(item.url.endsWith('/revisions') ? [{number:2,reason:'Current record'}] : {});
  await second;
  for(const item of pending.slice(0,4))item.resolve(item.url.endsWith('/revisions') ? [{number:1,reason:'Stale record'}] : {});
  await first;
  assert.match(fixture.text(fixture.container),/Current record/);
  assert.doesNotMatch(fixture.text(fixture.container),/Stale record/);
});

test('switching identity clears the prior record panel before network finishes',async()=>{
  const context={value:{record:{id:'PCN-2026-0001',version:'v1',status:'draft'},ready:true}};
  const fixture=domFixture(context,async url=>url.endsWith('/revisions') ? [{number:1,reason:'Sensitive old revision'}] : {});
  await fixture.control.refresh();
  assert.match(fixture.text(fixture.container),/Sensitive old revision/);
  context.value={...context.value,record:{id:'PCN-2026-0002',version:'v2',status:'draft'}};
  fixture.control.render();
  assert.doesNotMatch(fixture.text(fixture.container),/Sensitive old revision/);
});

test('failed services display errors rather than claiming checklist success',async()=>{
  const context={value:{record:{id:'PCN-2026-0001',version:'v1',status:'draft'},ready:true}};
  const fixture=domFixture(context,async()=>{throw new Error('Service unavailable');});
  await fixture.control.refresh();
  assert.match(fixture.text(fixture.container),/Service unavailable/);
  assert.doesNotMatch(fixture.text(fixture.container),/Required checks are complete/);
});

test('dirty document disables export and revision actions',async()=>{
  const context={value:{record:{id:'PCN-2026-0001',version:'v1',status:'draft'},ready:true,dirty:true,exportPdf(){}}};
  const fixture=domFixture(context,async url=>url.endsWith('/revisions') ? {items:[],capabilities:{canStartRevision:true}} : {});
  await fixture.control.refresh();
  const buttons=fixture.buttons(fixture.container);
  assert.equal(buttons.find(item=>item.textContent==='Print / PDF').disabled,true);
  assert.equal(buttons.find(item=>item.textContent==='Start new revision').disabled,true);
});
