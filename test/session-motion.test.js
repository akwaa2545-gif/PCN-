const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function motion({ reduced = false, supported = true, duration = '0.16s', delay = '0s', styled = true } = {}) {
  const timers = new Map(), listeners = new Map(); let next = 0;
  const element = {
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); }
  };
  const window = {
    location: { origin: 'http://fixture.test', pathname: '/admin', search: '', hash: '' },
    matchMedia: () => ({ matches: reduced }), CSS: { supports: () => supported },
    ...(styled ? { getComputedStyle: () => ({ transitionDuration: duration, transitionDelay: delay }) } : {}),
    setTimeout(callback, milliseconds) { const id = ++next; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../session-client.js'), 'utf8'), { window, URL, Headers });
  return { api: window.PCN_UI_MOTION, element, timers, listeners,
    transition(propertyName = 'opacity', target = element) { listeners.get('transitionend')?.({ propertyName, target }); },
    expire() { const timer = [...timers.values()][0]; assert.ok(timer, 'fallback is scheduled'); timer.callback(); } };
}

test('presentation cleanup is immediate with reduced motion, unsupported transitions, no styles or zero duration', () => {
  for (const options of [{ reduced: true }, { supported: false }, { styled: false }, { duration: '0s' }]) {
    const fixture = motion(options); let completed = 0;
    const pending = fixture.api.afterExit(fixture.element, () => completed++);
    assert.equal(completed, 1); assert.equal(fixture.timers.size, 0); assert.equal(fixture.listeners.size, 0);
    pending.cancel(); assert.equal(completed, 1);
  }
});

test('presentation survives until its own opacity transition, then cleans up once and releases its timer', () => {
  const fixture = motion(); let completed = 0;
  fixture.api.afterExit(fixture.element, () => completed++);
  assert.equal(completed, 0); assert.equal(fixture.timers.size, 1);
  fixture.transition('translate'); fixture.transition('opacity', {});
  assert.equal(completed, 0, 'child transitions cannot finish the parent exit');
  fixture.transition(); fixture.transition();
  assert.equal(completed, 1); assert.equal(fixture.timers.size, 0); assert.equal(fixture.listeners.size, 0);
});

test('a bounded fallback finishes once when the browser drops transitionend', () => {
  const fixture = motion({ duration: '120ms, 0.16s', delay: '0s, 20ms' }); let completed = 0;
  fixture.api.afterExit(fixture.element, () => completed++);
  assert([...fixture.timers.values()][0].milliseconds >= 180);
  assert([...fixture.timers.values()][0].milliseconds <= 240);
  const staleCallback = [...fixture.timers.values()][0].callback;
  fixture.expire(); staleCallback(); fixture.transition();
  assert.equal(completed, 1); assert.equal(fixture.timers.size, 0); assert.equal(fixture.listeners.size, 0);
  const long = motion({ duration: '10s' }); long.api.afterExit(long.element, () => {});
  assert([...long.timers.values()][0].milliseconds <= 240, 'unexpected styles cannot delay cleanup indefinitely');
});

test('cancellation and a changed generation prevent stale cleanup after rapid reopening', () => {
  const fixture = motion(); let completed = 0;
  const pending = fixture.api.afterExit(fixture.element, () => completed++);
  const oldCallback = [...fixture.timers.values()][0].callback;
  pending.cancel(); oldCallback(); fixture.transition();
  assert.equal(completed, 0); assert.equal(fixture.timers.size, 0); assert.equal(fixture.listeners.size, 0);
  let current = true;
  fixture.api.afterExit(fixture.element, () => completed++, { current: () => current });
  current = false; fixture.expire();
  assert.equal(completed, 0, 'a newer popup owns its presentation');
});

test('invalidated synchronous cleanup also respects the generation guard', () => {
  const fixture = motion({ reduced: true }); let completed = 0;
  fixture.api.afterExit(fixture.element, () => completed++, { current: () => false });
  assert.equal(completed, 0); assert.equal(fixture.timers.size, 0);
});
