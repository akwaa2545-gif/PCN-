const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectDeveloperPcn, loadDeveloperPcns } = require('../src/developerTools');
const developer = { id:'dev', roles:['developer'], department:'developer', signingStep:null, isActive:true };
const record = {id:'PCN-2026-0001',version:'0000000000000001',status:'gsc_review',riskLevel:'RL0',supplierName:'Supplier',materialName:'Material',ownerUserId:'private-owner',internalReview:{signoff:{gscTet:{prepared:true,preparedName:'Historical name',preparedDate:'2026-10-15'}}},documentControl:{signatureBindings:{'signoff.gscTet.prepared':{displayName:'Recorded signer',signedAt:'2026-10-15T00:00:00Z',contentHash:'private-hash'}}}};
function fixture(options={}) {
 let reads=0;
 return {service:{async list(){return [structuredClone(record)];},async getById(){reads++;return {...structuredClone(record),...(options.race&&reads>1?{version:'0000000000000002'}:{})};},async getRevisions(){return options.revisions||[{revision:2,contentRevision:1,actor:'user:writer',createdAt:'2026-10-15',status:'gsc_review',isBaseline:false,changes:[{path:'supplierName',before:'Old',after:'Supplier'},{path:'version',before:'1',after:'2'},{path:'documentControl.contentHash',before:null,after:'private-hash'},{path:'ownerUserId',before:null,after:'private-owner'},{path:'documentControl.revisionReason',before:null,after:'Correct material'},{path:'documentAttachments',before:[],after:[{fileName:'evidence.pdf',scanStatus:'clean',storagePath:'private-path',base64:'private-bytes'}]}]},{revision:1,contentRevision:1,actor:'Legacy baseline',status:'draft',isBaseline:true,createdAt:'2026-10-14',changes:[]}];}},documents:{async list(){return [];}},authService:{repository:{async listUsers(){return [{id:'writer',displayName:'Writer',email:'private-mail@example.test',passwordHash:'private-password'}];}}}};
}
test('inspection reports actual Prepared Checked Approved signatures and safe transaction history',async()=>{
 const result=await inspectDeveloperPcn(fixture(),developer,record.id);
 assert.deepEqual(result.workflow.stages[0].steps.map(x=>[x.action,x.state]),[['prepared','completed'],['checked','current'],['approved','waiting']]);
 assert.equal(result.workflow.stages[0].steps[0].person,'Recorded signer');
 assert.equal(result.workflow.nextAction.signingStep,'checked');
 assert.equal(result.transactions.items[0].actor,'Writer');
 assert.equal(result.transactions.items[0].actorReference,'user:writer');
 assert.deepEqual(result.transactions.items.map(x=>x.revision),[2,1]);
 assert.match(result.transactions.historyMessage,/earlier.*unavailable/i);
 assert.ok(result.transactions.items[0].changes.some(x=>x.path==='documentControl.revisionReason'));
 const text=JSON.stringify(result);for(const secret of ['private-owner','private-hash','private-path','private-bytes','private-password','private-mail'])assert.equal(text.includes(secret),false,secret);
});
test('listing has only safe selected record fields',async()=>{const result=await loadDeveloperPcns(fixture(),developer);assert.equal(result.items.length,1);assert.equal('ownerUserId'in result.items[0],false);assert.equal('internalReview'in result.items[0],false);});
test('only active exclusive Developer assignment may use direct tools',async()=>{
 for(const user of [undefined,{...developer,roles:['admin']},{...developer,roles:['developer','admin']},{...developer,roles:['deve-loper']},{...developer,department:'it'},{...developer,isActive:false},{...developer,isActive:undefined}])await assert.rejects(()=>inspectDeveloperPcn(fixture(),user,record.id),e=>e.statusCode===403);
});
test('version sandwich rejects mixed inspection and missing metadata fails truthfully',async()=>{
 await assert.rejects(()=>inspectDeveloperPcn(fixture({race:true}),developer,record.id),e=>e.statusCode===409);
 for(const missing of ['documents','authService']){const context=fixture();delete context[missing];await assert.rejects(()=>inspectDeveloperPcn(context,developer,record.id),e=>e.statusCode===503);}
 const unavailable=fixture();unavailable.service.getRevisions=async()=>{throw Error('database error with private details');};await assert.rejects(()=>inspectDeveloperPcn(unavailable,developer,record.id),e=>e.statusCode===503&&!e.message.includes('private'));
});
test('empty or discontinuous history is explicitly incomplete; unknown recorded actor is retained',async()=>{
 const context=fixture({revisions:[{revision:4,actor:'user:deleted-user',status:'draft',changes:[],isBaseline:false}]});const result=await inspectDeveloperPcn(context,developer,record.id);
 assert.equal(result.transactions.items[0].actor,'user:deleted-user');assert.match(result.transactions.historyMessage,/unavailable/i);
 context.service.getRevisions=async()=>[];assert.match((await inspectDeveloperPcn(context,developer,record.id)).transactions.historyMessage,/unavailable/i);
});
test('draft and terminal workflows never invent a current signing step',async()=>{
 for(const status of ['draft','rejected','closed','approved']){const context=fixture();context.service.getById=async()=>({...record,status});const result=await inspectDeveloperPcn(context,developer,record.id);assert.equal(result.workflow.stages.flatMap(x=>x.steps).filter(x=>x.state==='current').length,0);}
});
test('TaPBU no-need removes skipped groups while signing names fall back to recorded fields',async()=>{
 const context=fixture();context.service.getById=async()=>({...record,riskLevel:'RL2',documentControl:{},internalReview:{...record.internalReview,tapbu:{noNeed:true}}});
 const result=await inspectDeveloperPcn(context,developer,record.id);
 assert.equal(result.workflow.stages.length,4);assert.equal(result.workflow.stages.some(stage=>stage.key.startsWith('tapbu.')),false);
 assert.equal(result.workflow.stages[0].steps[0].person,'Historical name');assert.equal(result.workflow.stages[0].steps[0].signedAt,'2026-10-15');
});
test('malformed histories fail and nested attachment secrets never escape',async()=>{
 for(const revisions of [[{revision:0,changes:[]}],[{revision:1,changes:null}],[{revision:1,changes:[null]}]])await assert.rejects(()=>inspectDeveloperPcn(fixture({revisions}),developer,record.id),e=>e.statusCode===503);
 const context=fixture({revisions:[{revision:1,changes:[{path:'documentAttachments.0.storagePath',before:'hidden',after:'private-path'},{path:'comments',before:[],after:[{comment:'Useful comment',email:'private-mail',passwordHash:'private-password'}]}]}]});
 const result=await inspectDeveloperPcn(context,developer,record.id);const changes=result.transactions.items[0].changes;
 assert.equal(changes.length,1);assert.deepEqual(changes[0].after,[{comment:'Useful comment'}]);
});
test('signature transaction labels describe department and signing step',async()=>{
 const context=fixture({revisions:[{revision:1,changes:[{path:'internalReview.signoff.gscTet.preparedName',before:'',after:'Signer'},{path:'internalReview.signoff.qaTet.checkedDate',before:'',after:'2026-10-15'}]}]});
 const result=await inspectDeveloperPcn(context,developer,record.id);
 assert.deepEqual(result.transactions.items[0].changes.map(change=>change.label),['GSC/TET / Prepared by','QA/TET / Checked date']);
});
