const test = require('node:test');
const assert = require('node:assert/strict');
const { getClientAddress, parseTrustProxy } = require('../src/clientAddress');
const { ApiRateLimiter } = require('../src/apiRateLimit');
const { createApp } = require('../src/httpServer');
const { memoryRepository, fakeAuthService, TEST_PASSWORD } = require('./helpers/apiHarness');
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
  assert.throws(() => readServerConfig({ HOST: 'not a host' }), /HOST/);
  assert.throws(() => readServerConfig({ TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  assert.throws(() => readServerConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://192.0.2.44:8443' }), /HTTPS/);
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
