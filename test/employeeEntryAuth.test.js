const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp } = require('../src/httpServer');
const { memoryRepository } = require('./helpers/apiHarness');
const { createEmployeePasswordFixture } = require('./helpers/employeePasswordHarness');

const identification = { employeeCode:'0012345', identifyOnly:true };

test('identifying an enrolled employee returns only a password challenge without credentials or session side effects', async () => {
  for (const provider of ['employee-code', 'pcn-local']) {
    const f = await createEmployeePasswordFixture({ enrolled:true, provider, userOverrides:{ failedLoginCount:2 } });
    f.state.outage = provider === 'pcn-local';
    const before = structuredClone(f.state.users);
    assert.deepEqual(await f.service.login(identification, { ip:'identify' }), { authenticated:false, passwordRequired:true });
    assert.deepEqual(f.state.users, before);
    assert.deepEqual(f.state.passwordVerifications, []);
    assert.deepEqual(f.state.sessions, []);
    assert.deepEqual(f.state.writes, []);
    assert.deepEqual(f.state.lookups, provider === 'pcn-local' ? [] : ['0012345']);
  }
});

test('identifying a first-use employee issues only the existing ten-minute setup session', async () => {
  const f = await createEmployeePasswordFixture();
  const result = await f.service.login(identification);
  assert.equal(result.user.passwordSetupRequired, true);
  assert.equal(result.user.canChangePassword, false);
  assert.equal(Date.parse(result.expiresAt) - f.state.now, 600000);
  assert.equal(f.state.sessions[0].authenticationMethod, 'password-setup');
  assert.deepEqual(f.state.passwordVerifications, []);
});

test('identification rejects malformed or mixed phase fields and is unavailable in other auth modes', async () => {
  const f = await createEmployeePasswordFixture({ enrolled:true });
  for (const body of [
    { ...identification, identifyOnly:false }, { ...identification, identifyOnly:'true' },
    { ...identification, identifyOnly:null }, { ...identification, identifyOnly:undefined },
    { ...identification, password:'Abcd1234' }, { ...identification, remember:true },
    { ...identification, password:undefined }, { ...identification, remember:false }
  ]) await assert.rejects(f.service.login(body, { ip:JSON.stringify(body) }), { statusCode:400 });
  assert.deepEqual(f.state.sessions, []);
  assert.deepEqual(f.state.passwordVerifications, []);
  for (const authMode of ['employee-code', 'password']) {
    const other = await createEmployeePasswordFixture({ authMode });
    await assert.rejects(other.service.login(identification), { statusCode:400 });
  }
});

test('identification retains source, active-account, lockout and credential-pair checks', async () => {
  for (const userOverrides of [
    { isActive:false }, { lockoutUntil:new Date(Date.now() + 900000).toISOString() },
    { passwordSetAt:null }, { passwordHash:null }, { passwordHash:'' }
  ]) {
    const f = await createEmployeePasswordFixture({ enrolled:true, userOverrides });
    await assert.rejects(f.service.login(identification), { statusCode:401 });
    assert.deepEqual(f.state.sessions, []);
    assert.deepEqual(f.state.passwordVerifications, []);
    assert.equal(f.state.users[0].failedLoginCount, 0);
  }
  const missing = await createEmployeePasswordFixture({ enrolled:true });
  await assert.rejects(missing.service.login({ employeeCode:'9999999', identifyOnly:true }), { statusCode:401 });
  missing.state.outage = true;
  await assert.rejects(missing.service.login(identification), { statusCode:503 });
});

test('identification uses sign-in throttling while normal enrolled login still requires and verifies a password', async () => {
  const f = await createEmployeePasswordFixture({ enrolled:true });
  for (let index = 0; index < 15; index++) assert.equal((await f.service.login(identification, { ip:'same' })).passwordRequired, true);
  await assert.rejects(f.service.login(identification, { ip:'same' }), { statusCode:429 });
  assert.equal(f.state.users[0].failedLoginCount, 0);
  await assert.rejects(f.service.login({ employeeCode:'0012345' }, { ip:'normal' }), { statusCode:401 });
  assert.equal(f.state.users[0].failedLoginCount, 1);
  const result = await f.service.login({ employeeCode:'0012345', password:f.password, remember:true }, { ip:'normal' });
  assert.equal(result.user.passwordSetupRequired, false);
  assert.equal(Date.parse(result.expiresAt) - f.state.now, 30 * 86400000);
  assert.equal(f.state.users[0].failedLoginCount, 0);
  assert.equal(f.state.passwordVerifications.length, 1);
});

async function apiFixture(t, options) {
  const f = await createEmployeePasswordFixture(options);
  const server = createApp({ repository:memoryRepository(), authService:f.service, employeeDirectory:f.employeeDirectory,
    publicOrigin:'http://localhost', secureCookies:false, rootDir:path.resolve(__dirname, '..') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { body, method='POST', cookie, originHeader='http://localhost' } = {}) {
    const response = await fetch(origin + route, { method, headers:{
      ...(method === 'POST' ? { origin:originHeader, 'content-type':'application/json' } : {}),
      ...(cookie ? { cookie } : {})
    }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
    return { response, body:await response.json() };
  }
  return { ...f, request };
}

test('identification API sends an unauthenticated challenge without a cookie or profile', async t => {
  const f = await apiFixture(t, { enrolled:true });
  const result = await f.request('/api/auth/login', { body:identification });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.data, { authenticated:false, passwordRequired:true });
  assert.equal(result.response.headers.get('set-cookie'), null);
  assert.deepEqual(f.state.sessions, []);
  const session = await f.request('/api/session', { method:'GET' });
  assert.deepEqual(session.body.data, { authenticated:false });
  assert.equal((await f.request('/api/pcns', { method:'GET' })).response.status, 401);
});

test('first-use identification API creates only a setup cookie that cannot access PCNs', async t => {
  const f = await apiFixture(t);
  const result = await f.request('/api/auth/login', { body:identification });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.authenticated, true);
  assert.equal(result.body.data.user.passwordSetupRequired, true);
  const cookieHeader = result.response.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly; SameSite=Strict/);
  const maxAge = Number(/Max-Age=(\d+)/.exec(cookieHeader)?.[1]);
  assert(maxAge > 580 && maxAge <= 600);
  const cookie = cookieHeader.split(';')[0];
  assert.equal((await f.request('/api/session', { method:'GET', cookie })).body.data.user.passwordSetupRequired, true);
  const denied = await f.request('/api/pcns', { method:'GET', cookie });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.code, 'PASSWORD_SETUP_REQUIRED');
});

test('identification API enforces origin, exact fields and the public employee login route', async t => {
  const f = await apiFixture(t, { enrolled:true });
  for (const [route, options, status] of [
    ['/api/auth/login', { body:identification, originHeader:'http://evil.example' }, 403],
    ['/api/admin/login', { body:identification }, 400],
    ['/api/auth/login', { body:{ ...identification, userId:'another' } }, 400],
    ['/api/auth/login', { body:{ ...identification, password:'Abcd1234' } }, 400],
    ['/api/auth/login', { body:{ ...identification, remember:true } }, 400],
    ['/api/auth/login', { body:{ ...identification, identifyOnly:false } }, 400]
  ]) {
    const result = await f.request(route, options);
    assert.equal(result.response.status, status);
    assert.equal(result.response.headers.get('set-cookie'), null);
  }
  assert.deepEqual(f.state.sessions, []);
  assert.deepEqual(f.state.passwordVerifications, []);
  assert.equal(f.state.users[0].failedLoginCount, 0);
});
