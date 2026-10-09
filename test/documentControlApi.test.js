const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, unsignedPayload, fakeAuthService } = require('./helpers/apiHarness');
const { meaningfulUpdate } = require('../src/notificationUpdates');

test('revision metadata alone is silent while actual document content retains notifications', () => {
  const before={status:'submitted',supplierName:'Supplier'};
  assert.deepEqual(meaningfulUpdate(before,{...before,documentControl:{contentRevision:2,signatureBindings:{}}}),[]);
  assert.deepEqual(meaningfulUpdate(before,{...before,supplierName:'Changed',documentControl:{contentRevision:2}}),['Supplier']);
});

test('document workspace read APIs authorize record access before files and user directory access', async t => {
  let listed = 0;
  const authService=fakeAuthService({additionalUsers:[{username:'assigned',displayName:'Approver',employeeCode:'001',email:'private@example.test',roles:['gsc'],department:'gscTet',signingStep:'approved'}]});
  const api=await startApi(t,{authService,documents:{async list(){listed++;return []}}});
  const supplier=await api.login('supplier');
  const other=await api.login('other');
  const admin=await api.login('admin');
  const created=await api.request('/api/pcns',{method:'POST',session:supplier,body:{...unsignedPayload,status:'draft'}});
  const code=created.body.data.id;
  for(const endpoint of ['checks','action','documents','revisions']) {
    assert.equal((await api.request(`/api/pcns/${code}/${endpoint}`,{session:other})).status,404);
    assert.equal((await api.request(`/api/pcns/${code}/${endpoint}`)).status,401);
  }
  assert.equal(listed,0);
  const checks=await api.request(`/api/pcns/${code}/checks`,{session:supplier});
  assert.equal(checks.status,200);
  assert.equal(checks.body.data.ready,true);
  const action=await api.request(`/api/pcns/${code}/action`,{session:supplier});
  assert.equal(action.body.data.stage,'supplier_submission');
  assert.equal(action.body.data.people.some(person=>person.displayName==='Approver'),false);
  assert.equal((await api.request(`/api/pcns/${code}/documents`,{session:admin})).status,200);
});

test('action APIs return exact assigned people with no email or credentials', async t => {
  const api=await startApi(t,{authService:fakeAuthService({additionalUsers:[
    {username:'assigned',displayName:'Approver',employeeCode:'001',email:'private@example.test',roles:['gsc'],department:'gscTet',signingStep:'approved'},
    {username:'other-step',displayName:'Checker',roles:['gsc'],department:'gscTet',signingStep:'checked'}]})});
  const admin=await api.login('admin');
  const created=await api.request('/api/pcns',{method:'POST',session:admin,body:unsignedPayload});
  const response=await api.request(`/api/pcns/${created.body.data.id}/action`,{session:admin});
  assert.equal(response.status,200);
  assert.deepEqual(response.body.data.people,[{displayName:'Approver',employeeCode:'001'}]);
  assert.equal(response.body.data.field,'internalReview.signoff.gscTet.approved');
  assert.equal(response.body.data.canAct,true);
});

test('preview serves clean supported content inline with sandbox policy and rejects active content', async t => {
  let type='application/pdf';
  const id='00000000-0000-4000-8000-000000000001';
  const api=await startApi(t,{documents:{async get(){return {ContentType:type,FileName:'example.pdf',Bytes:Buffer.from('%PDF-1.4')}}}});
  const admin=await api.login('admin');
  const created=await api.request('/api/pcns',{method:'POST',session:admin,body:unsignedPayload});
  const route=`/api/pcns/${created.body.data.id}/documents/${id}/preview`;
  const response=await api.request(route,{session:admin});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-disposition'),/^inline;/);
  assert.match(response.headers.get('content-security-policy'),/sandbox/);
  assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');
  type='image/svg+xml';
  assert.equal((await api.request(route,{session:admin})).status,415);
});

test('revision creation requires version, whitelist fields and an administrator', async t => {
  const api=await startApi(t);
  const admin=await api.login('admin');
  const supplier=await api.login('supplier');
  const created=await api.request('/api/pcns',{method:'POST',session:supplier,body:{...unsignedPayload,status:'draft'}});
  const code=created.body.data.id;
  assert.equal((await api.request(`/api/pcns/${code}/revisions`,{method:'POST',session:supplier,body:{version:created.body.data.version,reason:'Correction'}})).status,403);
  assert.equal((await api.request(`/api/pcns/${code}/revisions`,{method:'POST',session:admin,body:{reason:'Correction'}})).status,400);
  assert.equal((await api.request(`/api/pcns/${code}/revisions`,{method:'POST',session:admin,body:{version:created.body.data.version,reason:'Correction',status:'closed'}})).status,400);
});
