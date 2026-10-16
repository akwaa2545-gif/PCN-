const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/httpServer');
const { enforceSameOrigin, developmentLoopbackOrigins } = require('../src/authHttp');
const { readServerConfig } = require('../server');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, TEST_NEW_PASSWORD } = require('./helpers/apiHarness');

const publicOrigin = 'http://10.249.160.21:3000';
const aliases = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'];

async function fixture(t, runtimeEnvironment = 'development', overrides = {}) {
  const configuration = readServerConfig({ HOST: '0.0.0.0', PUBLIC_ORIGIN: publicOrigin,
    ...(runtimeEnvironment === null ? {} : { NODE_ENV: runtimeEnvironment }),
    ...(runtimeEnvironment === 'production' ? { HOST: '127.0.0.1', TRUST_PROXY: 'loopback', ALLOW_INTERNAL_HTTP: 'true' } : {}) });
  const app = createApp({ repository: memoryRepository(), authService: fakeAuthService(), ...configuration, ...overrides });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return (route, { origin = aliases[0], host = 'localhost:3000', body = {}, headers = {}, method = 'POST' } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.address().port, path: route, method,
      headers: { host, 'content-type': 'application/json',
        ...(configuration.trustProxy ? { 'x-pcn-client-ip': '192.0.2.7' } : {}),
        ...(origin === null ? {} : { origin }), ...headers } }, res => {
      let content = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { content += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(content) }));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : JSON.stringify(body));
  });
}

const loginBody = { username: 'admin', password: TEST_PASSWORD };

test('development LAN configuration also accepts matching localhost login without changing public origin', async t => {
  const configuration = readServerConfig({ NODE_ENV: 'development', HOST: '0.0.0.0', PUBLIC_ORIGIN: publicOrigin });
  assert.equal(configuration.publicOrigin, publicOrigin);
  const request = await fixture(t);
  for (const origin of [publicOrigin, ...aliases]) {
    const response = await request('/api/auth/login', { origin, host: new URL(origin).host, body: loginBody });
    assert.equal(response.status, 200, origin);
    assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(response.headers['set-cookie'][0], /; Secure/);
  }
  assert.equal(configuration.runtimeEnvironment, 'development');
});

test('development aliases are frozen, fixed by canonical scheme and port, and require exact Host', () => {
  const allowed = developmentLoopbackOrigins(publicOrigin, 'development');
  assert.deepEqual(allowed, aliases);
  assert.equal(Object.isFrozen(allowed), true);
  assert.deepEqual(developmentLoopbackOrigins('https://pcn.example:8443', 'development'),
    ['https://localhost:8443', 'https://127.0.0.1:8443', 'https://[::1]:8443']);
  assert.deepEqual(developmentLoopbackOrigins('http://pcn.example', 'development'),
    ['http://localhost', 'http://127.0.0.1', 'http://[::1]']);
  for (const environment of [undefined, '', 'test', 'production', 'Development']) {
    assert.deepEqual(developmentLoopbackOrigins(publicOrigin, environment), []);
  }
  for (const origin of aliases) {
    enforceSameOrigin({ headers: { origin, host: new URL(origin).host } }, publicOrigin, allowed);
    for (const host of [undefined, 'evil.example:3000', '10.249.160.21:3000', 'localhost:3001']) {
      assert.throws(() => enforceSameOrigin({ headers: { origin, host } }, publicOrigin, allowed), { statusCode: 403 });
    }
  }
});

test('development login rejects cross-host, other ports and schemes, malformed and missing origins', async t => {
  const request = await fixture(t);
  const rejected = [
    { origin: 'http://evil.example:3000', host: 'evil.example:3000' },
    { origin: 'http://localhost:3001', host: 'localhost:3001' },
    { origin: 'https://localhost:3000' },
    { origin: 'http://localhost:3000/', host: 'localhost:3000' },
    { origin: 'http://localhost.evil.example:3000', host: 'localhost.evil.example:3000' },
    { origin: 'http://127.0.0.2:3000', host: '127.0.0.2:3000' },
    { origin: 'http://localhost:3000', host: '10.249.160.21:3000' },
    { origin: 'http://127.0.0.1:3000', host: 'localhost:3000' },
    { origin: 'null' }, { origin: null }, { origin: 'not-an-origin' },
    { origin: 'http://localhost:3000/path' },
    { origin: 'http://user@localhost:3000' }
  ];
  for (const entry of rejected) {
    const response = await request('/api/auth/login', { ...entry, body: loginBody,
      headers: { 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'http' } });
    assert.equal(response.status, 403, JSON.stringify(entry));
    assert.equal(response.body.error, 'Request origin is not allowed');
  }
});

test('production and unspecified environments keep exact canonical origin even if request Host is loopback', async t => {
  for (const runtimeEnvironment of ['production', 'test', '', null]) {
    const request = await fixture(t, runtimeEnvironment, { secureCookies: false });
    assert.equal((await request('/api/auth/login', { body: loginBody })).status, 403, runtimeEnvironment);
    assert.equal((await request('/api/auth/login', { origin: publicOrigin, body: loginBody })).status, 200, runtimeEnvironment);
  }
});

test('localhost authenticated writes and logout retain CSRF validation in development', async t => {
  const request = await fixture(t);
  const login = await request('/api/auth/login', { body: { username: 'temporary', password: TEST_PASSWORD } });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const csrfToken = login.body.data.csrfToken;
  const change = { currentPassword: TEST_PASSWORD, newPassword: TEST_NEW_PASSWORD };
  assert.equal((await request('/api/auth/change-password', { body: change, headers: { cookie } })).status, 403);
  assert.equal((await request('/api/auth/change-password', { body: change, headers: { cookie, 'x-csrf-token': csrfToken } })).status, 200);
  const second = await request('/api/auth/login', { body: loginBody });
  const sessionCookie = second.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request('/api/auth/logout', { headers: { cookie: sessionCookie } })).status, 403);
  const logout = await request('/api/auth/logout', { headers: { cookie: sessionCookie, 'x-csrf-token': second.body.data.csrfToken } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
});
