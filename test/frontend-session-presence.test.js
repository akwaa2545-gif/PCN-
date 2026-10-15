const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const authenticated = { authenticated: true, user: { id: 'viewer', roles: ['qa'] }, csrfToken: 'current-token' };
const success = data => ({ status: 200, body: { success: true, data } });
function presenceClient(responses) {
  const calls = []; const timers = new Map(); const documentEvents = {}; const windowEvents = {}; let timerId = 0;
  const document = { visibilityState: 'visible', addEventListener(name, callback) { documentEvents[name] = callback; } };
  const window = { document, navigator: { onLine: true }, location: { origin: 'http://pcn.example', pathname: '/admin', search: '', hash: '', assign() {} },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(name, callback) { windowEvents[name] = callback; } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../session-client.js'), 'utf8'), { window, document, URL, Headers,
    async fetch(url, options) { calls.push({ url, options }); let response = responses.shift(); if (typeof response === 'function') response = await response();
      if (response instanceof Error) throw response;
      assert.ok(response, `unexpected request ${url}`);
      return { ok: response.status < 400, status: response.status, json: async () => response.body };
    } });
  return { api: window.PCN_SESSION, calls, timers, document, window,
    async tick() { const [id, timer] = [...timers.entries()][0] || []; assert.ok(timer, 'heartbeat is scheduled'); timers.delete(id); await timer.callback(); },
    event(name, event = {}) { return (documentEvents[name] || windowEvents[name])?.(event); } };
}

test('authenticated load and login schedule exactly one thirty-second GET session heartbeat', async () => {
  const c = presenceClient([success(authenticated), success(authenticated), success(authenticated), success(authenticated)]);
  await c.api.load(); await c.api.load();
  await c.api.fetch('/api/auth/login', { method: 'POST', body: '{}' });
  assert.equal(c.timers.size, 1);
  assert.equal([...c.timers.values()][0].delay, 30000);
  await c.tick();
  assert.equal(c.calls.at(-1).url, '/api/session');
  assert.equal(c.calls.at(-1).options.method, 'GET');
  assert.equal(c.calls.at(-1).options.credentials, 'same-origin');
  assert.equal(c.timers.size, 1);
});

test('heartbeat never overlaps during visible and online events and retries transient failures quietly', async () => {
  let complete;
  const c = presenceClient([success(authenticated), () => new Promise(resolve => { complete = resolve; }), new Error('network unavailable'), success(authenticated)]);
  await c.api.load();
  const pending = c.tick(); await new Promise(setImmediate);
  c.event('visibilitychange'); c.event('online');
  assert.equal(c.calls.length, 2); assert.equal(c.timers.size, 0);
  complete(success(authenticated)); await pending;
  assert.equal(c.timers.size, 1);
  await c.tick(); assert.equal(c.timers.size, 1, 'transient failure keeps a single retry scheduled');
  await c.tick(); assert.equal(c.timers.size, 1);
});

test('heartbeat pauses hidden offline and pagehide without logging out; resumes visible online and BFCache pageshow', async () => {
  const c = presenceClient([success(authenticated), success(authenticated), success(authenticated)]);
  await c.api.load();
  c.document.visibilityState = 'hidden'; c.event('visibilitychange'); assert.equal(c.timers.size, 0);
  c.document.visibilityState = 'visible'; c.event('visibilitychange'); assert.equal([...c.timers.values()][0].delay, 0);
  c.window.navigator.onLine = false; c.event('offline'); assert.equal(c.timers.size, 0);
  c.window.navigator.onLine = true; c.event('online'); await c.tick();
  c.event('pagehide', { persisted: true }); assert.equal(c.timers.size, 0);
  assert.equal(c.calls.some(call => call.url === '/api/auth/logout'), false);
  c.event('pageshow', { persisted: true }); await c.tick();
  assert.equal(c.calls.filter(call => call.url === '/api/session').length, 3);
});

test('authentication loss stops heartbeat and clears stale CSRF for subsequent sign-in', async () => {
  const c = presenceClient([success(authenticated), { status: 401, body: { success: false, error: 'Session expired' } }, success({})]);
  await c.api.load(); await c.tick();
  assert.equal(c.timers.size, 0);
  c.event('online'); assert.equal(c.timers.size, 0);
  await c.api.fetch('/api/auth/login', { method: 'POST', body: '{}' });
  assert.equal(c.calls.at(-1).options.headers.has('x-csrf-token'), false);
});

test('logout stops heartbeat and ignores an old in-flight authenticated reply', async () => {
  let complete;
  const c = presenceClient([success(authenticated), () => new Promise(resolve => { complete = resolve; }), success({}), success({})]);
  await c.api.load(); const pending = c.tick(); await new Promise(setImmediate);
  await c.api.logout();
  complete(success(authenticated)); await pending;
  assert.equal(c.timers.size, 0);
  c.event('online'); assert.equal(c.timers.size, 0);
  await c.api.fetch('/api/auth/login', { method: 'POST', body: '{}' });
  assert.equal(c.calls.at(-1).options.headers.has('x-csrf-token'), false);
});
