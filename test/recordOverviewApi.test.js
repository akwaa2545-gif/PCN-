const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, fakeAuthService, unsignedPayload } = require('./helpers/apiHarness');
const viewer={username:'viewer',roles:[],isActive:true,employeeCode:'1234567',identityProvider:'employee-code'};

test('overview is scoped, read-only, and available to verified employee viewers', async t=>{
  const calls=[];
  const api=await startApi(t,{authService:fakeAuthService({additionalUsers:[viewer,{...viewer,username:'disabled',isActive:false}]}),
    documents:{async listForRecords(ids){calls.push(ids);return new Map(ids.map(id=>[id,{attachments:[]}]));}}});
  const supplier=await api.login('supplier');const other=await api.login('other');
  const own=await api.request('/api/pcns',{method:'POST',session:supplier,body:unsignedPayload});
  const foreign=await api.request('/api/pcns',{method:'POST',session:other,body:unsignedPayload});
  const supplierResult=await api.request('/api/pcns/overview',{session:supplier});
  assert.equal(supplierResult.status,200);
  assert.deepEqual(supplierResult.body.data.items.map(item=>item.id),[own.body.data.id]);
  assert.deepEqual(calls[0],[own.body.data.id]);
  const session=await api.login('viewer');
  const result=await api.request('/api/pcns/overview',{session});
  assert.equal(result.status,200); assert.equal(result.body.data.items.length,2);
  assert.equal(result.body.data.items.every(item=>item.dashboard.action.canAct===false),true);
  assert.deepEqual(calls[1],[own.body.data.id,foreign.body.data.id]);
  assert.equal((await api.request('/api/pcns/overview')).status,401);
  assert.equal((await api.request('/api/pcns/overview',{session:await api.login('disabled')})).status,403);
  assert.equal((await api.request('/api/pcns/overview',{method:'POST',session,body:{}})).status,403);
  assert.equal((await api.request('/api/pcns/overview',{method:'POST',session:supplier,body:{}})).status,405);
  assert.equal((await api.request('/api/pcns',{session:supplier})).body.data.length,1);
  assert.deepEqual(api.messages,[]);
});
