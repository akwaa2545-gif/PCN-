const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp } = require('../src/httpServer');
const { requirePrincipal } = require('../src/authHttp');
const { memoryRepository } = require('./helpers/apiHarness');

const token = 'a'.repeat(64), csrf = 'b'.repeat(64);
const user = setup => ({ id:'employee-id',employeeCode:'0012345',identityProvider:'employee-code',
  username:'0012345',roles:[],isActive:true,mustChangePassword:setup,passwordSetupRequired:setup,canChangePassword:!setup });

async function fixture(t, {setup=true,mode='employee-password'}={}) {
  const calls=[];
  const principal={user:user(setup),csrfToken:csrf,expiresAt:new Date(Date.now()+600000).toISOString()};
  const authService={authMode:mode,async session(value){return value===token?principal:null;},
    async login(body){calls.push(['login',body]);return {...principal,token};},
    async logout(){calls.push(['logout']);},async setupPassword(value,body){calls.push(['setup',value,body]);},
    async changePassword(value,body){calls.push(['change',value,body]);}};
  const server=createApp({repository:memoryRepository(),authService,publicOrigin:'http://localhost',secureCookies:false,rootDir:path.resolve(__dirname,'..')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function request(route,{method='GET',body,headers={},authenticated=true}={}) {
    const response=await fetch(origin+route,{method,headers:{...(authenticated?{cookie:`pcn_session=${token}`}:{ }),
      ...(method==='GET'?{}:{origin:'http://localhost','x-csrf-token':csrf,'content-type':'application/json'}),...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {response,body:await response.json()};
  }
  return {calls,request};
}

test('a setup-only principal cannot bypass the gate by clearing mustChangePassword',()=>{
  assert.throws(()=>requirePrincipal({user:{...user(true),mustChangePassword:false}}),error=>error.code==='PASSWORD_SETUP_REQUIRED');
  assert.equal(requirePrincipal({user:user(true)},{allowPasswordSetup:true}).employeeCode,'0012345');
  assert.throws(()=>requirePrincipal({user:user(true)},{allowPasswordSetup:true,roles:['admin']}),/permission/);
});

test('setup sessions can inspect themselves but cannot access business or profile routes',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/session')).body.data.user.passwordSetupRequired,true);
  for(const [route,method] of [['/api/pcns','GET'],['/api/profile','GET'],['/api/admin/users','GET'],
    ['/api/pcn-drafts','POST'],['/api/auth/change-password','POST']]) {
    const result=await f.request(route,{method,...(method==='POST'?{body:{}}:{})});
    assert.equal(result.response.status,403,route);assert.equal(result.body.code,'PASSWORD_SETUP_REQUIRED',route);
  }
  assert.equal(f.calls.length,0);
});

test('setup requires authentication, origin, CSRF and an exact request body',async t=>{
  const f=await fixture(t),body={newPassword:'12345678',confirmPassword:'12345678'};
  for(const options of [{authenticated:false},{headers:{origin:'http://evil.example'}},{headers:{'x-csrf-token':'wrong'}}]) {
    const result=await f.request('/api/auth/setup-password',{method:'POST',body,...options});
    assert([401,403].includes(result.response.status));
  }
  assert.equal((await f.request('/api/auth/setup-password',{method:'GET'})).response.status,405);
  assert.equal((await f.request('/api/auth/setup-password',{method:'POST',body:{...body,employeeCode:'9999999'}})).response.status,400);
  assert.equal(f.calls.length,0);
  const result=await f.request('/api/auth/setup-password',{method:'POST',body});
  assert.equal(result.response.status,200);assert.deepEqual(result.body.data,{authenticated:false,passwordSet:true});
  assert.match(result.response.headers.get('set-cookie'),/Max-Age=0/);
  assert.deepEqual(f.calls[0],['setup',token,body]);
});

test('roleless employees can change their own password with Origin and CSRF protection',async t=>{
  const f=await fixture(t,{setup:false}),body={currentPassword:'12345678',newPassword:'abcdefgh',confirmPassword:'abcdefgh'};
  const denied=await f.request('/api/auth/change-password',{method:'POST',body,headers:{'x-csrf-token':'bad'}});
  assert.equal(denied.response.status,403);assert.equal(f.calls.length,0);
  const result=await f.request('/api/auth/change-password',{method:'POST',body});
  assert.equal(result.response.status,200);assert.deepEqual(result.body.data,{authenticated:false,passwordChanged:true});
  assert.deepEqual(f.calls[0],['change',token,body]);
  assert.match(result.response.headers.get('set-cookie'),/Max-Age=0/);
});

test('employee-password login accepts the password field and exposes the public mode only',async t=>{
  const f=await fixture(t,{setup:false});
  assert.equal((await f.request('/api/auth/config')).body.data.mode,'employee-password');
  const body={employeeCode:'0012345',password:'abcd1234'};
  const result=await f.request('/api/auth/login',{method:'POST',body,authenticated:false});
  assert.equal(result.response.status,200);assert.deepEqual(f.calls[0],['login',body]);
});
