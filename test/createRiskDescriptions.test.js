'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const ui=require('../create');
const master={formDefinitions:{rawMaterial:{riskOptions:[{risk:'RL2',text:'Raw material specification change'},{risk:'RL2',text:'New raw material supplier'},
  {risk:'RL3',text:'Restricted substance change'},{risk:'RL2',text:'Disabled old wording',enabled:false}]},packaging:{riskOptions:[{risk:'RL2',text:'Packaging specification change'}]}}};
function fixture(){
  const nodes=new Map(),all=[],documentEvents={},windowEvents={},changes=[];let active=null;
  function element(tag='div'){const item={tagName:tag.toUpperCase(),id:'',value:'',textContent:'',hidden:false,disabled:false,style:{},attributes:{},children:[],events:{},scrollTop:0,
    setAttribute(key,value){this.attributes[key]=value;},getAttribute(key){return this.attributes[key]??null;},removeAttribute(key){delete this.attributes[key];},
    append(...children){this.children.push(...children);},appendChild(child){this.children.push(child);},replaceChildren(...children){this.children=children;},
    addEventListener(key,fn){this.events[key]=fn;},removeEventListener(key){delete this.events[key];},dispatchEvent(event){this.events[event.type]?.(event);return true;},
    focus(){active=this;},contains(target){return this===target||this.children.some(child=>child.contains(target));},matches(){return this.disabledByFieldset===true;},
    getBoundingClientRect(){return this.bounds||{top:150,bottom:190,left:100,right:400,width:300,height:40};}};all.push(item);return item;}
  const get=id=>{const dynamic=all.find(node=>node.id===id);if(dynamic)return dynamic;if(!nodes.has(id)){const node=element();node.id=id;nodes.set(id,node);}return nodes.get(id);};
  const root={innerWidth:900,innerHeight:800,Event:class{constructor(type){this.type=type;}},addEventListener(key,fn){windowEvents[key]=fn;},removeEventListener(key){delete windowEvents[key];},
    document:{getElementById:get,createElement:element,addEventListener(key,fn){documentEvents[key]=fn;},removeEventListener(key){delete documentEvents[key];},get activeElement(){return active;}}};
  const native=get('riskLevel');native.value='RL2';native.setAttribute('aria-describedby','riskLevelHelp riskLevelError');native.setAttribute('aria-invalid','true');
  native.addEventListener('change',()=>changes.push(native.value));
  const picker=ui.createRiskPicker(root);picker.render(master,{changeForm:'rawMaterial',riskLevel:'RL2'},false);
  const key=value=>get('riskLevelTrigger').events.keydown({key:value,preventDefault(){}});
  return {root,get,picker,key,changes,documentEvents,windowEvents};
}

test('risk descriptions preserve current or pinned form wording, enabled filtering and full text without invented meanings',()=>{
  const before=JSON.stringify(master);assert.deepEqual(ui.riskDescriptions(master,'rawMaterial','RL2'),['Raw material specification change','New raw material supplier']);
  assert.deepEqual(ui.riskDescriptions(master,'packaging','RL2'),['Packaging specification change']);assert.deepEqual(ui.riskDescriptions(master,'packaging','RL0'),[]);
  assert.deepEqual(ui.riskDescriptions(master,'missing','RL3'),[]);assert.equal(JSON.stringify(master),before);
  const text='A'.repeat(92)+'😀'+'A'.repeat(406),latest={formDefinitions:{rawMaterial:{riskOptions:[{risk:'RL2',text}]}}};
  assert.equal(ui.riskDescriptions(latest,'rawMaterial','RL2')[0],text);assert.equal(ui.riskDescriptions(master,'rawMaterial','RL2')[0],'Raw material specification change');
});

test('collapsed picker shows only the code, while its popup has four code headers and all full configured descriptions',()=>{
  const f=fixture();assert.equal(f.get('riskLevelValue').textContent,'RL2');assert.equal(f.get('riskLevelOptions').hidden,true);
  f.get('riskLevelTrigger').events.click();assert.equal(f.get('riskLevelOptions').hidden,false);assert.equal(f.get('riskLevelTrigger').getAttribute('aria-expanded'),'true');
  for(const code of ['RL3','RL2','RL1','RL0'])assert.equal(f.get(`riskLevelHeading-${code}`).textContent,code);
  assert.deepEqual(f.get('riskLevelDescriptions-RL2').children.map(item=>item.textContent),['Raw material specification change','New raw material supplier']);
  assert.match(f.get('riskLevelDescriptions-RL0').textContent,/No change descriptions configured/);assert.deepEqual(f.changes,[]);
});

test('keyboard navigation previews without mutation; Escape, Tab, outside click and current-code commit preserve the existing category',()=>{
  const f=fixture();f.get('riskLevelTrigger').events.click();f.key('Home');assert.equal(f.get('riskLevelTrigger').getAttribute('aria-activedescendant'),'riskLevelOption-RL3');
  f.key('Escape');assert.equal(f.get('riskLevel').value,'RL2');assert.equal(f.get('riskLevelOptions').hidden,true);
  f.key('ArrowDown');f.key('End');f.key('Tab');assert.equal(f.get('riskLevel').value,'RL2');
  f.get('riskLevelTrigger').events.click();f.key('End');f.documentEvents.pointerdown({target:{}});assert.equal(f.get('riskLevelOptions').hidden,true);
  f.get('riskLevelTrigger').events.click();f.get('riskLevelOption-RL2').events.click();assert.deepEqual(f.changes,[]);
  assert.equal(f.root.document.activeElement,f.get('riskLevelTrigger'));
});

test('Enter/Space and option clicks commit only changed risk codes through the existing native change event',()=>{
  const f=fixture();f.key('Home');f.key('Enter');assert.equal(f.get('riskLevel').value,'RL3');assert.deepEqual(f.changes,['RL3']);
  f.key('End');f.key(' ');assert.equal(f.get('riskLevel').value,'RL0');assert.deepEqual(f.changes,['RL3','RL0']);
  f.get('riskLevelTrigger').events.click();f.get('riskLevelOption-RL1').events.click();assert.deepEqual(f.changes,['RL3','RL0','RL1']);
  assert.equal(f.get('riskLevelValue').textContent,'RL1');assert.equal(f.get('riskLevelOptions').hidden,true);
});

test('visible trigger mirrors validation and disabled fieldsets; error help survives validation updates',()=>{
  const f=fixture(),trigger=f.get('riskLevelTrigger');assert.equal(trigger.getAttribute('aria-describedby'),'riskLevelHelp riskLevelError');assert.equal(trigger.getAttribute('aria-invalid'),'true');
  ui.describeField(f.get('riskLevel'),'riskLevel','riskLevelError',trigger);assert.equal(trigger.getAttribute('aria-describedby'),'riskLevelHelp riskLevelError');
  ui.describeField(f.get('riskLevel'),'riskLevel',null,trigger);assert.equal(trigger.getAttribute('aria-describedby'),'riskLevelHelp');
  f.picker.setDisabled(true);trigger.events.click();assert.equal(trigger.disabled,true);assert.equal(f.get('riskLevelOptions').hidden,true);
  f.picker.setDisabled(false);trigger.disabledByFieldset=true;trigger.events.click();assert.equal(f.get('riskLevelOptions').hidden,true);
});

test('popup stays within the viewport near its bottom and resize or page scroll cancels without committing',()=>{
  const f=fixture();f.root.innerWidth=320;f.root.innerHeight=600;f.get('riskLevelTrigger').bounds={top:530,bottom:575,left:30,right:290,width:260,height:45};
  f.get('riskLevelTrigger').events.click();const popup=f.get('riskLevelOptions');assert.ok(Number.parseFloat(popup.style.top)<530);
  assert.ok(Number.parseFloat(popup.style.left)>=0);assert.ok(Number.parseFloat(popup.style.width)<=320);assert.ok(Number.parseFloat(popup.style.maxHeight)<=530);
  f.windowEvents.resize();assert.equal(popup.hidden,true);assert.deepEqual(f.changes,[]);
  f.get('riskLevelTrigger').events.click();f.root.scrollY=30;f.documentEvents.scroll({target:{}});assert.equal(popup.hidden,true);
});

test('queued opening scroll does not dismiss the popup when its anchor has not moved',()=>{
  const f=fixture();f.get('riskLevelTrigger').events.click();f.documentEvents.scroll({target:{}});
  assert.equal(f.get('riskLevelOptions').hidden,false);
  f.get('riskLevelTrigger').bounds={top:120,bottom:160,left:100,right:400,width:300,height:40};f.documentEvents.scroll({target:{}});
  assert.equal(f.get('riskLevelOptions').hidden,true);assert.deepEqual(f.changes,[]);
});
