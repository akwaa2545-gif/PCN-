const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { AuthService } = require('../src/authService');

const secret = crypto.randomBytes(24).toString('hex');
const password = crypto.randomBytes(24).toString('hex');
const encoded = `fixture:${secret}`;
function fixture(provider = 'employee-code', options = {}) {
  const code = '1234567';
  const profile = { employeeCode:code, displayName:'Developer person', sourceDepartment:'IT', jobTitle:'Engineer', isActive:true };
  const state = { user:{ id:'dev-user', username:code, employeeCode:code, normalizedEmployeeCode:code,
    identityProvider:provider, roles:['developer'], department:'developer', isActive:true,
    securityStamp:'stamp', passwordHash:`fixture:${password}`, failedLoginCount:0 }, sessions:[], failures:0, resets:0, checks:[] };
  const repository = {
    async getUserByEmployeeCode() { return state.user; },
    async getUserByLogin() { return state.user; },
    async getUserById() { return state.user; },
    async saveSession(session) { state.sessions = [...state.sessions, session]; },
    async getSession(hash) { return state.sessions.find(s => s.tokenHash === hash); },
    async recordLoginFailure() {
      state.failures += 1;
      state.user = { ...state.user, failedLoginCount:state.failures,
        lockoutUntil:state.failures >= 5 ? new Date(Date.now()+900000).toISOString() : null };
    },
    async resetLoginFailures() { state.resets += 1; state.user = {...state.user,failedLoginCount:0,lockoutUntil:null}; }
  };
  const service = new AuthService(repository, { authMode:provider === 'password' ? 'password' : 'employee-code',
    employeeDirectory:{async getByCode() { if(state.onLookup) await state.onLookup(); return state.profile === undefined ? profile : state.profile; }},
    developerPasswordHash:encoded, passwordHasher:async value=>`fixture:${value}`,
    passwordVerifier:async(hash,value)=>{ state.checks = [...state.checks,{hash,value}]; if(state.onVerify) await state.onVerify(hash); return hash===`fixture:${value}`; }, ...options });
  const body = provider==='password' ? {username:code,password} : {employeeCode:code};
  return {state,service,body};
}

for (const provider of ['employee-code','pcn-local','password']) {
  test(`${provider} Developer requires a separate password on every sign-in before session creation`, async()=>{
    const {state,service,body}=fixture(provider);
    await assert.rejects(service.login(body), error=>error.statusCode===401&&error.code==='DEVELOPER_PASSWORD_REQUIRED');
    assert.equal(state.sessions.length,0);
    assert.equal(state.failures,0);
    await assert.rejects(service.login({...body,developerPassword:crypto.randomBytes(8).toString('hex')}), error=>error.statusCode===401&&!error.code);
    assert.equal(state.sessions.length,0);
    assert.equal(state.failures,1);
    const login=await service.login({...body,developerPassword:secret});
    assert.deepEqual(login.user.roles,['developer']);
    assert.equal(state.sessions.length,1);
    assert.equal(state.resets,1);
    assert.equal((await service.session(login.token)).user.id,'dev-user');
    await assert.rejects(service.login(body), error=>error.code==='DEVELOPER_PASSWORD_REQUIRED');
    assert.equal(state.sessions.length,1);
  });
  test(`${provider} Developer fails closed with unavailable configuration; ordinary users still sign in`,async()=>{
    const {state,service,body}=fixture(provider,{developerPasswordHash:undefined});
    await assert.rejects(service.login({...body,developerPassword:secret}),error=>error.statusCode===503);
    assert.equal(state.sessions.length,0);
    state.user={...state.user,roles:['qa'],department:'qaTet'};
    assert.ok((await service.login(body)).token);
  });
  test(`${provider} Developer validates challenge size and locks account after failed attempts from different addresses`,async()=>{
    const {state,service,body}=fixture(provider);
    for(const developerPassword of [123,{},null,'x'.repeat(129)]) {
      await assert.rejects(service.login({...body,developerPassword}),error=>error.statusCode===400);
    }
    for(let i=0;i<5;i++) await assert.rejects(service.login({...body,developerPassword:crypto.randomBytes(8).toString('hex')},{ip:`address-${i}`}),error=>error.statusCode===401);
    assert.equal(state.failures,5);
    await assert.rejects(service.login({...body,developerPassword:secret},{ip:'another-address'}),error=>error.statusCode===401);
    assert.equal(state.sessions.length,0);
  });
}

test('Developer challenge is disclosed only after identity and active account verification',async()=>{
  for(const patch of [{isActive:false},{normalizedEmployeeCode:'another'}]) {
    const {state,service,body}=fixture();state.user={...state.user,...patch};
    await assert.rejects(service.login(body),error=>error.statusCode===401&&!error.code);
    assert.equal(state.sessions.length,0);
  }
  const {state,service,body}=fixture();state.profile=null;
  await assert.rejects(service.login(body),error=>error.statusCode===401&&!error.code);
  assert.equal(state.sessions.length,0);
});

test('Developer session issuance cannot bypass password proof and configuration removal invalidates existing sessions',async()=>{
  const {state,service,body}=fixture('pcn-local');
  await assert.rejects(service.issueSession(state.user),error=>error.statusCode===401);
  const login=await service.login({...body,developerPassword:secret});
  service.developerPasswordHash=undefined;
  assert.equal(await service.session(login.token),null);
});

test('concurrent account change during Developer password verification cannot issue a stale session',async()=>{
  for(const provider of ['employee-code','pcn-local','password']) {
    const {state,service,body}=fixture(provider);
    state.onVerify=async hash=>{ if(hash===encoded) state.user={...state.user,roles:['qa'],securityStamp:'changed'}; };
    await assert.rejects(service.login({...body,developerPassword:secret}),error=>error.statusCode===401);
    assert.equal(state.sessions.length,0);
  }
});

test('Developer session re-read rejects a concurrent grant or configuration loss',async()=>{
  const {state,service,body}=fixture();const login=await service.login({...body,developerPassword:secret});
  state.onLookup=async()=>{service.developerPasswordHash=undefined;};
  assert.equal(await service.session(login.token),null);
});

test('Developer sessions require service-owned proof and are invalid after restart or credential rotation',async()=>{
  const {state,service,body}=fixture('pcn-local');
  const login=await service.login({...body,developerPassword:secret});
  const restarted=fixture('pcn-local');restarted.state.user=state.user;restarted.state.sessions=[...state.sessions];
  assert.equal(await restarted.service.session(login.token),null);
  service.developerPasswordHash=`fixture:${crypto.randomBytes(24).toString('hex')}`;
  assert.equal(await service.session(login.token),null);
  await assert.rejects(service.issueSession(state.user,false,true),error=>error.statusCode===401);
});

test('malformed Developer assignments never authenticate or reuse a session',async()=>{
  for(const assignment of [{department:'it'},{roles:['developer','admin']},{signingStep:'checked'}]) {
    const {state,service,body}=fixture('pcn-local');
    const login=await service.login({...body,developerPassword:secret});
    state.user={...state.user,...assignment};
    assert.equal(await service.session(login.token),null);
    await assert.rejects(service.login({...body,developerPassword:secret}),error=>error.statusCode===401);
  }
});

test('ordinary remembered session cannot gain Developer access through an unstamped legacy role change',async()=>{
  const {state,service,body}=fixture('pcn-local');state.user={...state.user,roles:['qa'],department:'qaTet'};
  const login=await service.login(body);
  state.user={...state.user,roles:['developer'],department:'developer'};
  assert.equal(await service.session(login.token),null);
});

test('legacy password user creation rejects unpaired Developer access and linking a privileged account is blocked',async()=>{
  const {service,body}=fixture('password');
  await assert.rejects(service.createUser({username:body.username,password,roles:['developer']}),error=>error.statusCode===400);
  await assert.rejects(service.linkEmployee({userId:'dev-user',employeeCode:body.username}),error=>error.statusCode===409);
});

test('Developer lockout added during password verification fails closed',async()=>{
  const {state,service,body}=fixture('pcn-local');
  state.onVerify=async()=>{state.user={...state.user,lockoutUntil:new Date(Date.now()+900000).toISOString()};};
  await assert.rejects(service.login({...body,developerPassword:secret}),error=>error.statusCode===401);
  assert.equal(state.sessions.length,0);
});

test('ordinary account promoted during login failure reset must sign in with the Developer challenge',async()=>{
  const {state,service,body}=fixture('password');state.user={...state.user,roles:['qa'],department:'qaTet'};
  service.repository.resetLoginFailures=async()=>{state.user={...state.user,roles:['developer'],department:'developer'};};
  await assert.rejects(service.login(body),error=>error.statusCode===401);
  assert.equal(state.sessions.length,0);
});

test('Developer identity relinked while login completes cannot create a session for stale identity',async()=>{
  for(const patch of [{identityProvider:'password'},{employeeCode:'7654321',normalizedEmployeeCode:'7654321'}]) {
    const {state,service,body}=fixture('pcn-local');
    service.repository.resetLoginFailures=async()=>{state.user={...state.user,...patch};};
    await assert.rejects(service.login({...body,developerPassword:secret}),error=>error.statusCode===401);
    assert.equal(state.sessions.length,0);
  }
});
