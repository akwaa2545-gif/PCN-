const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let now = 0, nextId = 0;
  const timers = new Map(), listeners = new Map();
  const document = { visibilityState: 'visible', addEventListener: listen, removeEventListener: unlisten };
  function listen(name, callback) { listeners.set(name, callback); }
  function unlisten(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); }
  const window = { document, addEventListener: listen, removeEventListener: unlisten,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'session-client.js'), 'utf8'), { window });
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
    now = until;
  }
  async function visible(value) {
    document.visibilityState = value ? 'visible' : 'hidden';
    listeners.get('visibilitychange')?.();
    await advance(0);
  }
  return { start: window.PCN_AUTO_REFRESH.start, advance, visible, listeners, timers };
}

test('automatic refresh begins after five seconds and serializes asynchronous work', async () => {
  const h = harness(); let calls = 0, resolve;
  const stop = h.start({ refresh: () => { calls++; return new Promise(done => { resolve = done; }); } });
  await h.advance(4999); assert.equal(calls, 0);
  await h.advance(1); assert.equal(calls, 1);
  await h.advance(30000); assert.equal(calls, 1);
  resolve(); for (let i = 0; i < 6; i++) await Promise.resolve();
  await h.advance(5000); assert.equal(calls, 2);
  stop();
});

test('hidden tabs make no requests and resume promptly when visible', async () => {
  const h = harness(); let calls = 0;
  const stop = h.start({ refresh: async () => { calls++; } });
  await h.visible(false); await h.advance(30000); assert.equal(calls, 0);
  await h.visible(true); assert.equal(calls, 1);
  await h.advance(5000); assert.equal(calls, 2); stop();
});

test('busy or draft gates skip a tick and allow later refresh', async () => {
  const h = harness(); let allowed = false, calls = 0;
  const stop = h.start({ refresh: async () => { calls++; }, canRefresh: () => allowed });
  await h.advance(10000); assert.equal(calls, 0);
  allowed = true; await h.advance(5000); assert.equal(calls, 1); stop();
});

test('failed reads back off, report the error and return to five seconds after recovery', async () => {
  const h = harness(); let calls = 0; const errors = [];
  const stop = h.start({ refresh: async () => { calls++; if (calls === 1) throw new Error('temporarily unavailable'); }, onError: error => errors.push(error.message) });
  await h.advance(5000); assert.equal(calls, 1);
  await h.advance(9999); assert.equal(calls, 1);
  await h.advance(1); assert.equal(calls, 2);
  await h.advance(5000); assert.equal(calls, 3);
  assert.deepEqual(errors, ['temporarily unavailable']); stop();
});

test('stop and pagehide remove timers/listeners and invalidate outstanding results', async () => {
  for (const action of ['stop', 'pagehide']) {
    const h = harness(); let current, resolve, calls = 0;
    const stop = h.start({ refresh: context => { calls++; current = context.isCurrent; return new Promise(done => { resolve = done; }); } });
    await h.advance(5000); assert.equal(current(), true);
    if (action === 'stop') stop(); else h.listeners.get('pagehide')();
    assert.equal(current(), false);
    resolve(); for (let i = 0; i < 6; i++) await Promise.resolve();
    await h.advance(60000); assert.equal(calls, 1);
    assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
  }
});

test('hiding during a request makes its captured result stale even after returning', async () => {
  const h = harness(); let current, resolve, calls = 0;
  const stop = h.start({ refresh: context => { calls++; current = context.isCurrent; return new Promise(done => { resolve = done; }); } });
  await h.advance(5000); const original = current;
  await h.visible(false); assert.equal(original(), false);
  await h.visible(true); assert.equal(calls, 1); assert.equal(original(), false);
  resolve(); for (let i = 0; i < 6; i++) await Promise.resolve();
  await h.advance(5000); assert.equal(calls, 2); stop();
});

test('a request finishing while hidden leaves no timer until the tab returns', async () => {
  const h = harness(); let calls = 0, resolve;
  const stop = h.start({ refresh: () => { calls++; return new Promise(done => { resolve = done; }); } });
  await h.advance(5000); await h.visible(false);
  resolve(); for (let i = 0; i < 6; i++) await Promise.resolve();
  await h.advance(60000); assert.equal(calls, 1); assert.equal(h.timers.size, 0);
  await h.visible(true); assert.equal(calls, 2); stop();
});

test('repeated failures cap retry delay at thirty seconds', async () => {
  const h = harness(); let calls = 0;
  const stop = h.start({ refresh: async () => { calls++; throw new Error('offline'); }, onError() {} });
  await h.advance(5000); assert.equal(calls, 1);
  await h.advance(10000); assert.equal(calls, 2);
  await h.advance(20000); assert.equal(calls, 3);
  await h.advance(29999); assert.equal(calls, 3);
  await h.advance(1); assert.equal(calls, 4);
  await h.advance(30000); assert.equal(calls, 5); stop();
});

test('browser back-forward cache pauses polling and resumes after pageshow', async () => {
  const h = harness(); let calls = 0;
  const stop = h.start({ refresh: async () => { calls++; } });
  h.listeners.get('pagehide')({ persisted: true });
  await h.advance(30000); assert.equal(calls, 0);
  h.listeners.get('pageshow')({ persisted: true });
  await h.advance(0); assert.equal(calls, 1); stop();
});

test('invalid scheduler configuration fails before installing a timer', () => {
  const h = harness();
  for (const options of [{}, { refresh() {}, intervalMs: 0 }, { refresh() {}, intervalMs: Infinity }, { refresh() {}, canRefresh: false }]) {
    assert.throws(() => h.start(options), /require/);
  }
  assert.equal(h.timers.size, 0);
});
