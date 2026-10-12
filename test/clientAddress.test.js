const test = require('node:test');
const assert = require('node:assert/strict');
const { getClientAddress, parseTrustProxy } = require('../src/clientAddress');
const { ApiRateLimiter } = require('../src/apiRateLimit');
const { createApp } = require('../src/httpServer');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, TEST_NEW_PASSWORD } = require('./helpers/apiHarness');
const { readServerConfig } = require('../server');

function request(remoteAddress, headers = {}, rawHeaders) {
  return Object.freeze({ method: 'GET', socket: Object.freeze({ remoteAddress }), headers: Object.freeze(headers), rawHeaders });
}

test('proxy trust is disabled by default and arbitrary trust values fail closed', () => {
  for (const value of [undefined, '', 'off', 'false', '0']) assert.equal(parseTrustProxy(value), false);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  for (const value of ['true', '1', '*', 'all', '127.0.0.1', true]) assert.throws(() => parseTrustProxy(value), /TRUST_PROXY/);
  const req = request('127.0.0.1', { 'x-pcn-client-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.8' });
  assert.equal(getClientAddress(req), '127.0.0.1');
  assert.equal(getClientAddress(req, { trustProxy: true }), '127.0.0.1');
});

test('an untrusted peer cannot choose its client IP even when loopback trust is enabled', () => {
  for (const value of ['203.0.113.7', ['bad', 'bad'], 'x'.repeat(1000)]) {
    assert.equal(getClientAddress(request('192.0.2.17', { 'x-pcn-client-ip': value }), { trustProxy: 'loopback' }), '192.0.2.17');
  }
});

test('explicit loopback proxies forward one valid IP without mutating the request', () => {
  for (const proxy of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    const req = request(proxy, { 'x-pcn-client-ip': '203.0.113.7' }, ['X-PCN-Client-IP', '203.0.113.7']);
    assert.equal(getClientAddress(req, { trustProxy: 'loopback' }), '203.0.113.7');
    assert.equal(req.socket.remoteAddress, proxy);
  }
  assert.equal(getClientAddress(request('::1', { 'x-pcn-client-ip': '2001:db8::7' }), { trustProxy: 'loopback' }), '2001:db8::7');
});

test('trusted proxy rejects absent, duplicated, oversized and non-IP client headers', () => {
  const invalid = [undefined, '', 'unknown', '192.0.2.1, 192.0.2.2', '192.0.2.1:443', 'https://192.0.2.1', 'x'.repeat(65), ['192.0.2.1'], '192.0.2.999'];
  for (const value of invalid) assert.throws(() => getClientAddress(request('127.0.0.1', { 'x-pcn-client-ip': value }), { trustProxy: 'loopback' }), { statusCode: 400 });
  assert.throws(() => getClientAddress(request('127.0.0.1', { 'x-pcn-client-ip': '192.0.2.1' }, ['X-PCN-Client-IP', '192.0.2.1', 'x-pcn-client-ip', '192.0.2.1']), { trustProxy: 'loopback' }), { statusCode: 400 });
  assert.throws(() => getClientAddress(request('127.0.0.1', { 'x-forwarded-for': '192.0.2.1', forwarded: 'for=192.0.2.1' }), { trustProxy: 'loopback' }), { statusCode: 400 });
});

test('rate limiter isolates verified proxy clients while default calls ignore forwarded headers', () => {
  const limiter = new ApiRateLimiter({ requests: 1 });
  const req = request('127.0.0.1', { 'x-pcn-client-ip': '192.0.2.1' });
  limiter.check(req, { clientAddress: getClientAddress(req, { trustProxy: 'loopback' }) });
  limiter.check(req, { clientAddress: '192.0.2.2' });
  assert.throws(() => limiter.check(req, { clientAddress: '192.0.2.1' }), { statusCode: 429 });
  const direct = new ApiRateLimiter({ requests: 1 });
  direct.check(req);
  assert.throws(() => direct.check(request('127.0.0.1', { 'x-pcn-client-ip': '192.0.2.2' })), { statusCode: 429 });
});

test('server binds loopback by default and accepts the approved HTTPS origin with port', () => {
  const defaults = readServerConfig({});
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.port, 3000);
  assert.equal(defaults.trustProxy, false);
  const approved = readServerConfig({ HOST: '127.0.0.1', TRUST_PROXY: 'loopback', PORT: '3000', NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://192.0.2.44:8443' });
  assert.equal(approved.publicOrigin, 'https://192.0.2.44:8443');
  assert.equal(approved.trustProxy, 'loopback');
  assert.equal(approved.secureCookies, true);
  assert.equal(approved.sessionCookieName, 'pcn_session');
  assert.throws(() => readServerConfig({ HOST: 'not a host' }), /HOST/);
  assert.throws(() => readServerConfig({ TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  assert.throws(() => readServerConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://192.0.2.44:8443' }), /HTTPS/);
});

test('production internal HTTP requires explicit opt-in, a private literal origin and loopback proxy', () => {
  const baseline = { HOST: '127.0.0.1', TRUST_PROXY: 'loopback', NODE_ENV: 'production', ALLOW_INTERNAL_HTTP: 'true' };
  for (const origin of ['http://10.0.0.1:8080', 'http://172.16.0.1:8080', 'http://172.31.255.254:8080', 'http://192.168.0.1:8080']) {
    const result = readServerConfig({ ...baseline, PUBLIC_ORIGIN: origin });
    assert.equal(result.publicOrigin, origin);
    assert.equal(result.secureCookies, false);
    assert.equal(result.sessionCookieName, 'pcn_session_http');
  }
  for (const origin of ['http://172.15.255.255:8080', 'http://172.32.0.1:8080', 'http://192.169.0.1:8080', 'http://8.8.8.8:8080', 'http://127.0.0.1:8080', 'http://localhost:8080', 'http://pcn.internal:8080', 'https://172.30.77.137:8443']) {
    assert.throws(() => readServerConfig({ ...baseline, PUBLIC_ORIGIN: origin }), /internal HTTP/i, origin);
  }
  for (const host of ['0.0.0.0', '172.30.77.137', '::']) assert.throws(() => readServerConfig({ ...baseline, HOST: host, PUBLIC_ORIGIN: 'http://172.30.77.137:8080' }), /loopback/);
  for (const proxy of [undefined, 'off', 'false']) assert.throws(() => readServerConfig({ ...baseline, TRUST_PROXY: proxy, PUBLIC_ORIGIN: 'http://172.30.77.137:8080' }), /loopback/);
  for (const value of [null, true, 'TRUE', '1', ' true ', 'yes', '']) assert.throws(() => readServerConfig({ ...baseline, ALLOW_INTERNAL_HTTP: value, PUBLIC_ORIGIN: 'http://172.30.77.137:8080' }), /ALLOW_INTERNAL_HTTP/);
  assert.throws(() => readServerConfig({ ...baseline, ALLOW_INTERNAL_HTTP: 'false', PUBLIC_ORIGIN: 'http://172.30.77.137:8080' }), /HTTPS/);
});

test('server origins reject credentials, noncanonical addresses and extra URL components', () => {
  const baseline = { HOST: '127.0.0.1', TRUST_PROXY: 'loopback', NODE_ENV: 'production', ALLOW_INTERNAL_HTTP: 'true' };
  for (const origin of [null, {}, 17, '', 'not a URL', ' http://172.30.77.137:8080', 'http://172.30.77.137:8080/', 'http://172.30.77.137:8080/path', 'http://172.30.77.137:8080?x=y', 'http://172.30.77.137:8080#x', 'http://user:password@172.30.77.137:8080', 'http://0xac1e4d89:8080', 'http://2887667081:8080', 'http://172.030.77.137:8080', 'ftp://172.30.77.137:8080', 'http://172.30.77.137:70000']) {
    assert.throws(() => readServerConfig({ ...baseline, PUBLIC_ORIGIN: origin }), /PUBLIC_ORIGIN/, String(origin));
  }
});

async function server(t, overrides = {}) {
  const origin = 'https://192.0.2.44:8443';
  const ips = [];
  const auth = fakeAuthService();
  const app = createApp({ repository: memoryRepository(), authService: { ...auth, async login(body, info) { ips.push(info.ip); return auth.login(body, info); } }, publicOrigin: origin, secureCookies: true, ...overrides });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return { ips, origin, base: `http://127.0.0.1:${app.address().port}` };
}

test('HTTP proxy client address reaches login throttling and keeps HTTPS Origin checks intact', async t => {
  const s = await server(t, { trustProxy: 'loopback' });
  const headers = { 'content-type': 'application/json', origin: s.origin, 'x-pcn-client-ip': '203.0.113.8' };
  const body = JSON.stringify({ username: 'admin', password: TEST_PASSWORD });
  const login = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers, body });
  assert.equal(login.status, 200);
  assert.deepEqual(s.ips, ['203.0.113.8']);
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  const rejected = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers: { ...headers, origin: 'http://192.0.2.44:8443', 'x-forwarded-proto': 'https' }, body });
  assert.equal(rejected.status, 403);
  assert.equal(s.ips.length, 1);
});

test('internal HTTP login, session and logout use a separate cookie and retain origin and CSRF checks', async t => {
  const configuration = readServerConfig({ HOST: '127.0.0.1', TRUST_PROXY: 'loopback', NODE_ENV: 'production', ALLOW_INTERNAL_HTTP: 'true', PUBLIC_ORIGIN: 'http://172.30.77.137:8080' });
  const s = await server(t, configuration);
  const headers = { 'content-type': 'application/json', origin: configuration.publicOrigin, 'x-pcn-client-ip': '172.30.76.21' };
  const wrongOrigin = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers: { ...headers, origin: 'https://172.30.77.137:8080', 'x-forwarded-proto': 'http' }, body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
  assert.equal(wrongOrigin.status, 403);
  const login = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /^pcn_session_http=/);
  assert.match(cookie, /; HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(cookie, /; Secure/);
  const identity = (await login.json()).data;
  const sessionHeaders = { ...headers, cookie: `pcn_session=old-secure-cookie; ${cookie.split(';')[0]}` };
  const session = await fetch(`${s.base}/api/session`, { headers: sessionHeaders });
  assert.equal((await session.json()).data.authenticated, true);
  const oldOnly = await fetch(`${s.base}/api/session`, { headers: { ...headers, cookie: 'pcn_session=old-secure-cookie' } });
  assert.equal((await oldOnly.json()).data.authenticated, false);
  assert.equal((await fetch(`${s.base}/api/auth/logout`, { method: 'POST', headers: sessionHeaders, body: '{}' })).status, 403);
  assert.equal((await fetch(`${s.base}/api/auth/logout`, { method: 'POST', headers: { ...sessionHeaders, origin: 'http://172.30.76.21:7000', 'x-csrf-token': identity.csrfToken }, body: '{}' })).status, 403);
  const logout = await fetch(`${s.base}/api/auth/logout`, { method: 'POST', headers: { ...sessionHeaders, 'x-csrf-token': identity.csrfToken }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /^pcn_session_http=;.*HttpOnly; SameSite=Strict; Max-Age=0$/);
  const expired = await fetch(`${s.base}/api/session`, { headers: sessionHeaders });
  assert.equal((await expired.json()).data.authenticated, false);
});

test('internal HTTP password maintenance clears the configured cookie and revokes the session', async t => {
  const configuration = readServerConfig({ HOST: '127.0.0.1', TRUST_PROXY: 'loopback', NODE_ENV: 'production', ALLOW_INTERNAL_HTTP: 'true', PUBLIC_ORIGIN: 'http://172.30.77.137:8080' });
  const s = await server(t, configuration);
  const headers = { 'content-type': 'application/json', origin: configuration.publicOrigin, 'x-pcn-client-ip': '172.30.76.21' };
  const login = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'temporary', password: TEST_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = (await login.json()).data;
  const changed = await fetch(`${s.base}/api/auth/change-password`, { method: 'POST', headers: { ...headers, cookie, 'x-csrf-token': session.csrfToken }, body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: TEST_NEW_PASSWORD }) });
  assert.equal(changed.status, 200);
  assert.match(changed.headers.get('set-cookie'), /^pcn_session_http=;.*HttpOnly; SameSite=Strict; Max-Age=0$/);
  const expired = await fetch(`${s.base}/api/session`, { headers: { ...headers, cookie } });
  assert.equal((await expired.json()).data.authenticated, false);
});

test('HTTP limiter separates trusted proxy clients and rejects malformed client metadata', async t => {
  const s = await server(t, { trustProxy: 'loopback', rateLimiter: new ApiRateLimiter({ requests: 1 }) });
  async function health(value) { return fetch(`${s.base}/api/health`, { headers: { 'x-pcn-client-ip': value } }); }
  assert.equal((await health('203.0.113.1')).status, 200);
  assert.equal((await health('203.0.113.2')).status, 200);
  assert.equal((await health('203.0.113.1')).status, 429);
  assert.equal((await health('203.0.113.3, 203.0.113.4')).status, 400);
});

test('HTTP default mode cannot evade limits by changing custom client-IP headers', async t => {
  const s = await server(t, { rateLimiter: new ApiRateLimiter({ requests: 1 }) });
  assert.equal((await fetch(`${s.base}/api/health`, { headers: { 'x-pcn-client-ip': '203.0.113.1' } })).status, 200);
  assert.equal((await fetch(`${s.base}/api/health`, { headers: { 'x-pcn-client-ip': '203.0.113.2' } })).status, 429);
});
