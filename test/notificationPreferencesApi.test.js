const test=require('node:test');
const assert=require('node:assert/strict');
const {startApi,memoryRepository,fakeAuthService}=require('./helpers/apiHarness');
const {notificationPreferencesView,validateNotificationPreferences}=require('../src/notificationPreferences');
const {settingsVersion}=require('../src/mailRouting');
const {ApiError}=require('../src/apiError');
const route='/api/admin/notification-preferences';
async function fixture(t,options={}) {
  const repository=memoryRepository();let settings={schemaVersion:2,groups:[],legacyGroups:[]};let saves=0;
  repository.getNotificationPreferences=async()=>notificationPreferencesView(settings,[]);
  repository.saveNotificationPreferences=async(input,actor)=>{
    const validated=validateNotificationPreferences(input,[]);
    if(input.version!==settingsVersion(settings)) throw new ApiError(409,'Notification preferences changed; reload before saving');
    settings={...settings,notificationPreferences:{schemaVersion:1,rules:validated.rules,updatedAt:'2026-11-20T03:00:00Z',updatedBy:actor}};saves++;
    return repository.getNotificationPreferences();
  };
  const app=await startApi(t,{repository,...options});
  return {...app,saves:()=>saves};
}
const body=view=>({schemaVersion:view.schemaVersion,version:view.version,rules:view.rules});
test('notification preferences API reads safe defaults and saves complete rules with full-row CAS',async t=>{
  const app=await fixture(t);const session=await app.login('admin');
  const initial=(await app.request(route,{session})).body.data;
  assert.equal(initial.options.types.length,6);assert.equal(initial.options.groups.length,36);assert.deepEqual(initial.options.users,[]);
  const changed={...body(initial),rules:{...initial.rules,submitted:{...initial.rules.submitted,enabled:false}}};
  const saved=await app.request(route,{session,method:'PUT',body:changed});
  assert.equal(saved.status,200);assert.equal(saved.body.data.rules.submitted.enabled,false);assert.equal(saved.body.data.updatedBy,'user:admin-id');
  assert.equal(saved.body.data.options.types.length,6);assert.notEqual(saved.body.data.version,initial.version);
  assert.equal((await app.request(route,{session,method:'PUT',body:changed})).status,409);assert.equal(app.saves(),1);
});
test('notification preference API enforces role, origin, CSRF, exact fields and supported methods',async t=>{
  const app=await fixture(t);const session=await app.login('admin');const supplier=await app.login('supplier');
  const input=body((await app.request(route,{session})).body.data);
  assert.equal((await app.request(route)).status,401);
  assert.equal((await app.request(route,{session:supplier})).status,403);
  for(const options of [{csrf:null},{origin:'https://evil.test'}]) assert.equal((await app.request(route,{session,method:'PUT',body:input,...options})).status,403);
  assert.equal((await app.request(`${route}?users=all`,{session})).status,400);
  assert.equal((await app.request(route,{session,method:'PATCH',body:input})).status,405);
  assert.equal((await app.request(route,{session,method:'PUT',body:{...input,options:{}}})).status,400);
  assert.equal((await app.request(route,{session,method:'PUT',body:{...input,rules:{...input.rules,unexpected:{}}}})).status,400);
  assert.equal(app.saves(),0);
});
test('valid exclusive Developer assignment can manage notification preferences',async t=>{
  const app=await fixture(t,{authService:fakeAuthService({additionalUsers:[{username:'developer',roles:['developer'],department:'developer',signingStep:null}]})});
  const session=await app.login('developer');const initial=await app.request(route,{session});
  assert.equal(initial.status,200);assert.equal((await app.request(route,{session,method:'PUT',body:body(initial.body.data)})).status,200);
});
