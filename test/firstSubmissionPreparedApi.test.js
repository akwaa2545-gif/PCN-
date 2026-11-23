const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, fakeAuthService, unsignedPayload } = require('./helpers/apiHarness');

const bindingPath = 'signoff.gscTet.prepared';
const people = [
  {username:'gsc-preparer',displayName:'Verified GSC Preparer',roles:['gsc'],department:'gscTet',signingStep:'prepared'},
  {username:'gsc-checker',displayName:'Verified GSC Checker',roles:['gsc'],department:'gscTet',signingStep:'checked'},
  {username:'developer',displayName:'Verified Developer',roles:['developer'],department:'developer',signingStep:null},
  {username:'qa-preparer',displayName:'Verified QA Preparer',roles:['qa'],department:'qaTet',signingStep:'prepared'}
];
async function setup(t) {
  let repository;
  const api=await startApi(t,{authService:fakeAuthService({additionalUsers:people}),documents:{async listForRecords(ids){
    return new Map(await Promise.all(ids.map(async id=>[id,{parentVersion:(await repository.findById(id)).version,attachments:[]}])));
  }}});
  repository=api.repository;
  return api;
}
const create = (api,session,body=unsignedPayload) => api.request('/api/pcns',{method:'POST',session,body});
const patch = (api,session,record,body) => api.request(`/api/pcns/${record.id}`,{
  method:'PATCH',session,body:{version:record.version,...body}
});

test('HTTP direct creation signs only authorized first submitters with server identity and next Checked action',async t=>{
  const api=await setup(t);
  for (const [username,name] of [['admin','admin'],['gsc-preparer','Verified GSC Preparer'],['developer','Verified Developer']]) {
    const session=await api.login(username);
    for (const documentType of ['ta','sc']) {
      const response=await create(api,session,{...unsignedPayload,documentType});
      assert.equal(response.status,201,response.text);
      const record=response.body.data, step=record.internalReview.signoff.gscTet;
      assert.equal(step.prepared,true); assert.equal(step.preparedName,name);
      assert.equal(step.preparedDate,record.updatedAt.slice(0,10));
      assert.equal(record.documentControl.signatureBindings[bindingPath].signedAt,record.updatedAt);
      assert.equal(record.documentControl.signatureBindings[bindingPath].userId,`${username}-id`);
      assert.equal(record.documentControl.signatureBindings[bindingPath].contentHash,record.documentControl.contentHash);
      const action=await api.request(`/api/pcns/${record.id}/action`,{session});
      assert.equal(action.status,200,action.text); assert.equal(action.body.data.signingStep,'checked');
    }
  }
});

test('HTTP guided drafts stay unsigned and editable until first submission, including a pure Checked preflight',async t=>{
  const api=await setup(t),session=await api.login('gsc-preparer');
  const creationBody={clientDraftKey:'50000000-0000-4000-8000-000000000201',document:unsignedPayload};
  const created=await api.request('/api/pcn-drafts',{method:'POST',session,body:creationBody});
  assert.equal(created.status,201,created.text);
  const draft=created.body.data.record;
  assert.notEqual(draft.internalReview.signoff?.gscTet?.prepared,true);
  const edit=await api.request(`/api/pcn-drafts/${draft.id}`,{method:'PATCH',session,
    body:{version:draft.version,document:{reason:'A completed draft remains editable'}}});
  assert.equal(edit.status,200,edit.text);
  const before=await api.repository.findById(draft.id);
  const preflight=await api.request(`/api/pcn-drafts/${draft.id}/preflight`,{method:'POST',session,body:{version:before.version}});
  assert.equal(preflight.status,200,preflight.text); assert.equal(preflight.body.data.nextAction.signingStep,'checked');
  assert.deepEqual(await api.repository.findById(draft.id),before);
  assert.deepEqual(api.messages,[],'Drafts and preflight never queue mail');
  const submitted=await patch(api,session,before,{status:'submitted'});
  assert.equal(submitted.status,200,submitted.text);
  const saved=submitted.body.data;
  assert.equal(saved.internalReview.signoff.gscTet.prepared,true);
  assert.equal(saved.internalReview.signoff.gscTet.preparedName,'Verified GSC Preparer');
  const bindings=structuredClone(saved.documentControl.signatureBindings);
  const repeated=await patch(api,session,saved,{status:'submitted'});
  assert.equal(repeated.status,200,repeated.text); assert.deepEqual(repeated.body.data.documentControl.signatureBindings,bindings);
  const replay=await api.request('/api/pcn-drafts',{method:'POST',session,body:creationBody});
  assert.equal(replay.status,201,replay.text); assert.equal(replay.body.data.reused,true);
  assert.equal(replay.body.data.record.version,repeated.body.data.version);
  assert.deepEqual(replay.body.data.record.documentControl.signatureBindings,bindings);
});

test('HTTP unrelated or wrong-step creators cannot gain a GSC Prepared signature, including spoofed submissions',async t=>{
  const api=await setup(t);
  for (const username of ['supplier','gsc-checker','qa-preparer']) {
    const session=await api.login(username);
    const created=await create(api,session);
    assert.equal(created.status,201,created.text);
    assert.notEqual(created.body.data.internalReview.signoff?.gscTet?.prepared,true);
    assert.equal(created.body.data.documentControl.signatureBindings[bindingPath],undefined);
    const forged=await create(api,session,{...unsignedPayload,internalReview:{signoff:{gscTet:{prepared:true,preparedName:'Fake GSC'}}}});
    assert.equal(forged.status,403,forged.text);
  }
  const preparer=await api.login('gsc-preparer');
  const badIdentity=await create(api,preparer,{...unsignedPayload,internalReview:{signoff:{gscTet:{preparedName:'Fake GSC'}}}});
  assert.equal(badIdentity.status,400,badIdentity.text);
  const wrongStep=await create(api,preparer,{...unsignedPayload,internalReview:{signoff:{gscTet:{checked:true}}}});
  assert.equal(wrongStep.status,403,wrongStep.text);
});

test('HTTP failed completion and stale submission cannot persist an automatic signature or outbox job',async t=>{
  const api=await setup(t),session=await api.login('admin');
  const created=await create(api,session,{...unsignedPayload,status:'draft',reason:''});
  assert.equal(created.status,201,created.text); const draft=created.body.data;
  const failed=await patch(api,session,draft,{status:'submitted'});
  assert.equal(failed.status,400,failed.text);
  assert.deepEqual(await api.repository.findById(draft.id),draft);
  const fixed=await patch(api,session,draft,{reason:'Ready to submit'});
  assert.equal(fixed.status,200,fixed.text);
  const stale=await patch(api,session,draft,{status:'submitted'});
  assert.equal(stale.status,409,stale.text);
  const current=await api.repository.findById(draft.id);
  assert.equal(current.status,'draft'); assert.notEqual(current.internalReview.signoff?.gscTet?.prepared,true);
  assert.deepEqual(api.messages,[]);
});
