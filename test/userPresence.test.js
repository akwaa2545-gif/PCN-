const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService, hashToken } = require('../src/authService');
const { UserPresence } = require('../src/userPresence');

function fixture() {
  let time = Date.parse('2026-10-15T08:00:00Z');
  const user = { id:'one', username:'one', roles:['admin'], identityProvider:'password', isActive:true, securityStamp:'stamp' };
  const state = { users:[user], sessions:[] };
  const repository = {
    async getUserById(id) { return state.users.find(item => item.id === id); },
    async saveSession(value) { state.sessions = [...state.sessions,value]; },
    async getSession(hash) { return state.sessions.find(item => item.tokenHash === hash); },
    async revokeSession(hash) { state.sessions = state.sessions.map(item => item.tokenHash === hash ? {...item,revokedAt:new Date(time)} : item); }
  };
  const service = new AuthService(repository,{authMode:'password',clock:() => new Date(time)});
  return { service,state,user,repository,advance:ms => {time += ms;},now:() => time };
}

test('presence starts offline, successful session issue makes it online, and inactivity expires at 90 seconds',async () => {
  const f = fixture();
  assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'offline'}]);
  const login = await f.service.issueSession(f.user);
  assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'online'}]);
  f.advance(89999);
  assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'online'}]);
  f.advance(1);
  assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'offline'}]);
  assert.ok(await f.service.session(login.token));
  assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'online'}]);
});

test('one session logging out preserves another, while logout of the last session is immediately offline',async () => {
  const f = fixture();
  const first = await f.service.issueSession(f.user);
  const second = await f.service.issueSession(f.user);
  await f.service.logout(first.token);
  assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'online'}]);
  await f.service.logout(second.token);
  assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'offline'}]);
});

for (const invalidation of ['revoked','stamp','disabled','expired','invalid-expiry','missing']) {
  test(`presence revalidates ${invalidation} sessions without waiting for the employee heartbeat`,async () => {
    const f = fixture();
    const login = await f.service.issueSession(f.user);
    if (invalidation === 'revoked') f.state.sessions = f.state.sessions.map(item => ({...item,revokedAt:new Date(f.now())}));
    if (invalidation === 'stamp') f.state.users = f.state.users.map(item => ({...item,securityStamp:'changed'}));
    if (invalidation === 'disabled') f.state.users = f.state.users.map(item => ({...item,isActive:false}));
    if (invalidation === 'expired') f.state.sessions = f.state.sessions.map(item => ({...item,expiresAt:new Date(f.now()).toISOString()}));
    if (invalidation === 'invalid-expiry') f.state.sessions = f.state.sessions.map(item => ({...item,expiresAt:'bad-date'}));
    if (invalidation === 'missing') f.state.sessions = [];
    assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'offline'}]);
    assert.equal(await f.service.session(login.token),null);
  });
}

test('admin projection never refreshes another user and a failed authentication does not preserve presence',async () => {
  const f = fixture();
  const login = await f.service.issueSession(f.user);
  f.advance(60000);
  await f.service.userPresence(f.state.users);
  f.advance(30000);
  assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'offline'}]);
  f.state.users = f.state.users.map(item => ({...item,securityStamp:'new'}));
  assert.equal(await f.service.session(login.token),null);
  assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'offline'}]);
});

test('bounded tracker evicts old sessions, ignores malformed or expired sessions and prunes at expiry',() => {
  let time = 1000;
  const presence = new UserPresence({clock:() => time,maxSessions:2});
  const session = {userId:'one',securityStamp:'stamp',expiresAt:new Date(10000).toISOString()};
  presence.touch('a'.repeat(64),session);
  time = 2000;
  presence.touch('b'.repeat(64),session);
  presence.touch('c'.repeat(64),session);
  assert.deepEqual(presence.candidates().map(item => item.tokenHash),['b'.repeat(64),'c'.repeat(64)]);
  presence.touch('raw-token',session);
  presence.touch('d'.repeat(64),{...session,expiresAt:'bad'});
  presence.touch('e'.repeat(64),{...session,expiresAt:new Date(time)});
  assert.equal(presence.candidates().length,2);
  time = 10000;
  assert.deepEqual(presence.candidates(),[]);
});

test('batch validation uses only observed sessions and exposes only an online/offline status',async () => {
  const f = fixture();
  const login = await f.service.issueSession(f.user);
  const calls = [];
  f.repository.validPresenceSessions = async (entries,now) => {
    calls.push({entries,now});
    return f.state.sessions;
  };
  assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'online'}]);
  assert.equal(calls[0].entries[0].tokenHash,hashToken(login.token));
  assert.equal(JSON.stringify(calls[0]).includes(login.token),false);
  f.repository.validPresenceSessions = async () => [];
  assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'offline'}]);
  assert.deepEqual(f.service.presence.candidates(),[]);
});

for (const provider of ['employee-code','pcn-local']) {
  test(`${provider} final successful authentication refreshes presence and source failure clears it`,async () => {
    const f = fixture();
    const user = {...f.user,identityProvider:provider,employeeCode:'0012345',normalizedEmployeeCode:'0012345'};
    f.state.users = [user];
    f.service.authMode = 'employee-code';
    f.service.employeeDirectory = {async getByCode() { return {employeeCode:'0012345',displayName:'Employee',isActive:true}; }};
    const login = await f.service.issueSession(user);
    f.advance(90000);
    assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'offline'}]);
    assert.ok(await f.service.session(login.token));
    assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'online'}]);
    if (provider === 'employee-code') {
      f.service.employeeDirectory = {async getByCode() {throw new Error('source unavailable');}};
      await assert.rejects(f.service.session(login.token),error => error.statusCode === 503);
      assert.deepEqual(await f.service.userPresence(f.state.users),[{status:'offline'}]);
    }
  });
}

test('user listing protects presence behind Administrator access and returns no session or credential fields',async t => {
  const {createApp} = require('../src/httpServer');
  const {memoryRepository} = require('./helpers/apiHarness');
  const f = fixture();
  f.state.users = [...f.state.users,{...f.user,id:'ordinary',username:'ordinary',roles:['supplier'],securityStamp:'ordinary-stamp'}];
  f.repository.listUsers = async () => f.state.users.map(user => ({...user,securityStamp:'private',passwordHash:'private',tokenHash:'private'}));
  const app = createApp({repository:memoryRepository(),authService:f.service,authMode:'password',secureCookies:false});
  await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => {app.close(resolve);app.closeAllConnections();}));
  const url = `http://127.0.0.1:${app.address().port}/api/admin/users`;
  assert.equal((await fetch(url)).status,401);
  const ordinary = await f.service.issueSession(f.state.users[1]);
  assert.equal((await fetch(url,{headers:{cookie:`pcn_session=${ordinary.token}`}})).status,403);
  const admin = await f.service.issueSession(f.user);
  const response = await fetch(url,{headers:{cookie:`pcn_session=${admin.token}`}});
  assert.equal(response.status,200);
  const body = await response.json();
  assert.deepEqual(body.data.map(user => user.presence),[{status:'online'},{status:'online'}]);
  for (const user of body.data) {
    for (const key of ['securityStamp','passwordHash','tokenHash','sessionId','csrfToken']) assert.equal(Object.hasOwn(user,key),false);
  }
  assert.equal(JSON.stringify(body).includes(admin.token),false);
  assert.equal(JSON.stringify(body).includes(ordinary.token),false);
});
