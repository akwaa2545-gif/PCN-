const test=require('node:test');const assert=require('node:assert/strict');
const {startApi,fakeAuthService,unsignedPayload}=require('./helpers/apiHarness');
const users=[{username:'dev',roles:['developer'],department:'developer',signingStep:null},{username:'mixed',roles:['developer','admin'],department:'developer',signingStep:null},{username:'wrongdepartment',roles:['developer'],department:'it',signingStep:null},{username:'inactive',roles:['developer'],department:'developer',signingStep:null,isActive:false}];
test('Developer tools API is read-only and available exclusively to Developer sessions',async t=>{
 const api=await startApi(t,{authService:fakeAuthService({additionalUsers:users}),documents:{async list(){return [];}}});
 const dev=await api.login('dev');const admin=await api.login('admin');
 const created=await api.request('/api/pcns',{method:'POST',session:admin,body:unsignedPayload});assert.equal(created.status,201);
 const id=created.body.data.id;
 for(const path of ['/api/developer/pcns',`/api/developer/pcns/${id}/inspect`]){
  assert.equal((await api.request(path)).status,401);
  for(const name of ['admin','supplier','mixed','wrongdepartment','inactive'])assert.equal((await api.request(path,{session:await api.login(name)})).status,403,name);
  assert.equal((await api.request(path,{session:dev})).status,200);
  for(const method of ['POST','PATCH','DELETE','HEAD'])assert.equal((await api.request(path,{method,session:dev,body:method==='HEAD'?undefined:{}})).status,405,method);
  assert.equal((await api.request(`${path}?user=admin`,{session:dev})).status,400);
 }
 assert.equal((await api.request('/api/developer/pcns/PCN-2026-9999/inspect',{session:dev})).status,404);
 for(const id of ['bad','PCN-2026-1','PCN-2026-0001%2Fextra'])assert.equal((await api.request(`/api/developer/pcns/${id}/inspect`,{session:dev})).status,400);
 assert.equal(api.messages.length,0);
});
