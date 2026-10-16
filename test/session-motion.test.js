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
  return { api: window.PCN_UI_MOTION, window, element, timers, listeners,
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

function visibilityMotion({ reduced = false, animatable = true } = {}) {
  const fixture = motion({ supported: false, reduced });
  const classes = new Set(), animations = [];
  fixture.element.hidden = true; fixture.element.inert = true;
  fixture.element.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  fixture.element.style = { removeProperty() {}, setProperty() {} };
  if (animatable) fixture.element.animate = (frames, options) => {
    let resolve; const listeners = new Map();
    const animation = { finished: new Promise(done => { resolve = done; }), frames, options, cancelled: false,
      addEventListener(name, callback) { listeners.set(name, callback); },
      cancel() { this.cancelled = true; },
      finish() { resolve(); this.onfinish?.(); listeners.get('finish')?.(); } };
    animations.push(animation); return animation;
  };
  return { ...fixture, classes, animations };
}
const flushMotion = () => new Promise(setImmediate);

test('managed dropdown visibility animates without discrete CSS and closes logically before presentation finishes', async () => {
  const fixture = visibilityMotion();
  fixture.api.setVisible(fixture.element, true);
  assert.equal(fixture.element.hidden, false); assert.equal(fixture.element.inert, false);
  assert.equal(fixture.animations.length, 1, 'ordinary WAAPI works when allow-discrete is unsupported');
  fixture.animations[0].finish(); await flushMotion(); assert.equal(fixture.classes.size, 0);
  fixture.api.setVisible(fixture.element, false);
  assert.equal(fixture.element.hidden, true); assert.equal(fixture.element.inert, true);
  assert.equal(fixture.animations.length, 2); assert(fixture.classes.size > 0, 'presentation remains while closed controls are inert');
  fixture.animations[1].finish(); await flushMotion(); assert.equal(fixture.classes.size, 0);
});

test('rapid close/reopen cancels stale dropdown animation completion without hiding the reopened menu', async () => {
  const fixture = visibilityMotion();
  fixture.api.setVisible(fixture.element, true); fixture.animations[0].finish(); await flushMotion();
  fixture.api.setVisible(fixture.element, false); const oldExit = fixture.animations.at(-1);
  fixture.api.setVisible(fixture.element, true); const newEntry = fixture.animations.at(-1);
  assert.equal(oldExit.cancelled, true, 'reopening cancels the obsolete exit');
  oldExit.finish(); await flushMotion();
  assert.equal(fixture.element.hidden, false); assert.equal(fixture.element.inert, false);
  newEntry.finish(); await flushMotion();
  assert.equal(fixture.element.hidden, false); assert.equal(fixture.classes.size, 0);
});

test('managed dropdowns remain immediate with reduced motion or without a browser animation API', () => {
  for (const options of [{ reduced: true }, { animatable: false }]) {
    const fixture = visibilityMotion(options);
    fixture.api.setVisible(fixture.element, true);
    assert.equal(fixture.element.hidden, false); assert.equal(fixture.element.inert, false);
    fixture.api.setVisible(fixture.element, false);
    assert.equal(fixture.element.hidden, true); assert.equal(fixture.element.inert, true);
    assert.equal(fixture.animations.length, 0); assert.equal(fixture.classes.size, 0);
  }
});
