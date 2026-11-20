'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { selectRuntimeFiles } = require('../scripts/package-release');
const ui = require('../system-settings');

const admin = { isActive: true, roles: ['admin'], department: 'it' };
const defaults = () => ({ schemaVersion: 1, version: 0, pendingDays: { gscTet: null, prodEngTet: 3, prodEngTa: 3, prodEngSc: 3, qaTet: 3, gscTapbu: null, qaTapbu: null, qaFinal: null }, updatedAt: null, updatedBy: null });
function fixture(fetch, user = admin) {
  const nodes = new Map(), calls = [], events = {}, confirmations = [];
  const makeNode = () => ({ value:'',checked:false,disabled:false,hidden:true,textContent:'',events:{},attributes:{},children:[],
    addEventListener(name,handler){this.events[name]=handler;},setAttribute(name,value){this.attributes[name]=value;},
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=[...children];},focus(){this.focused=true;} });
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  };
  const root = { document: { getElementById: get, createElement:makeNode }, addEventListener(name, handler) { events[name] = handler; },
    setInterval() {}, confirm(message) { confirmations.push(message); return root.confirmResult !== false; },
    PCN_SESSION: { require: async () => user ? { user } : null, mountProfile() {},
      async fetch(url, options) { calls.push({ url, options }); return fetch?.(url, options) ?? (url === '/api/session' ? { authenticated: true, user } : defaults()); } } };
  return { root, get, calls, events, confirmations };
}
function change(page, key, value) {
  page.get(`${key}Days`).value = value;
  page.get(`${key}Days`).events.input();
}
async function mountEditor(page) {
  const controller = await ui.mount(page.root);
  await controller.openReviews();
  return controller;
}

test('TA and SC review controls inherit legacy PE values and save independent eight-rule limits', async () => {
  const old = defaults(); old.pendingDays.prodEngTet = null; delete old.pendingDays.prodEngTa; delete old.pendingDays.prodEngSc;
  const page = fixture((url, options) => options?.method === 'PUT' ? JSON.parse(options.body) : old);
  const controller = await mountEditor(page);
  assert.equal(ui.RULES.length, 8);
  assert.equal(page.get('prodEngTaEnabled').checked, false);
  assert.equal(page.get('prodEngScEnabled').checked, false);
  page.get('prodEngTaEnabled').checked = true; page.get('prodEngTaEnabled').events.change();
  change(page, 'prodEngTa', '5'); await controller.save();
  const saved = JSON.parse(page.calls.find(call => call.options?.method === 'PUT').options.body);
  assert.equal(Object.keys(saved.pendingDays).length, 8);
  assert.equal(saved.pendingDays.prodEngTa, 5);
  assert.equal(saved.pendingDays.prodEngSc, null);
});

test('a partially upgraded review settings response cannot replace a complete editable snapshot', async () => {
  let response = defaults();
  const page = fixture(() => response); const controller = await mountEditor(page);
  change(page, 'prodEngTa', '8');
  response = defaults(); delete response.pendingDays.prodEngSc;
  await controller.reload(false);
  assert.equal(page.get('prodEngTaDays').value, '8');
  assert.match(page.get('settingsStatus').textContent, /invalid settings/i);
});

test('settings opens a feature chooser without loading review settings until selected', async () => {
  const page = fixture(); const controller = await ui.mount(page.root);
  assert.equal(page.get('settingsHome').hidden, false);
  assert.equal(page.get('settingsEditor').hidden, true);
  assert.equal(page.get('settingsBack').hidden, true);
  assert.equal(page.calls.length, 0);
  await controller.openReviews();
  assert.equal(page.get('settingsHome').hidden, true);
  assert.equal(page.get('settingsEditor').hidden, false);
  assert.equal(page.get('settingsBack').hidden, false);
  assert.equal(page.calls.length, 1);
  await controller.showHome();
  assert.equal(page.get('settingsHome').hidden, false);
  assert.equal(page.get('settingsEditor').hidden, true);
  assert.equal(page.get('settingsReviewLimits').focused, true);
});

const notificationDefaults = () => ({schemaVersion:1,version:'a'.repeat(64),rules:Object.fromEntries(
  ['submitted','actionRequired','updated','completed','dueSoon','overdue'].map(key=>[key,{enabled:true,includeDefaultRecipients:true,groupKeys:[],userIds:[],excludedUserIds:[]}])
),options:{types:['submitted','actionRequired','updated','completed','dueSoon','overdue'].map(key=>({key,label:key,description:key})),groups:[],users:[]}});

test('Notifications uses the feature chooser, shared Reload and Back without loading review limits',async()=>{
  const page=fixture(url=>url==='/api/admin/notification-preferences'?notificationDefaults():undefined);
  const controller=await ui.mount(page.root);assert.equal(page.calls.length,0);
  await controller.openNotifications();
  assert.equal(page.get('settingsHome').hidden,true);assert.equal(page.get('notificationEditor').hidden,false);
  assert.equal(page.get('settingsEditor').hidden,true);assert.equal(page.get('notificationTitle').focused,true);
  assert.equal(page.get('settingsReload').hidden,false);assert.equal(page.get('settingsBack').hidden,false);
  await controller.reload();assert.equal(page.calls.length,2);
  controller.showHome();assert.equal(page.get('notificationEditor').hidden,true);
  assert.equal(page.get('settingsNotifications').focused,true);assert.equal(page.get('settingsHome').hidden,false);
});

test('notification drafts share unload/discard guards and losing access clears the editor',async()=>{
  const page=fixture(url=>url==='/api/session'?{authenticated:false}:notificationDefaults());
  const controller=await ui.mount(page.root);await controller.openNotifications();
  page.get('notificationEnabled').checked=false;page.get('notificationEnabled').events.change();
  let prevented=false;page.events.beforeunload({preventDefault(){prevented=true;}});assert.equal(prevented,true);
  page.root.confirmResult=false;controller.showHome();assert.equal(page.get('notificationEditor').hidden,false);
  await controller.checkAccess();assert.equal(page.get('notificationEditor').hidden,true);
  assert.equal(page.get('notificationUserPicker').children.length,0);assert.equal(page.get('settingsHome').hidden,true);
  await controller.openNotifications();assert.equal(page.calls.length,2);
});

test('All settings preserves drafts when discard is cancelled and reloads fresh after discarding', async () => {
  const page = fixture(); const controller = await mountEditor(page);
  change(page, 'qaTet', '9'); page.root.confirmResult = false;
  controller.showHome();
  assert.equal(page.get('settingsEditor').hidden, false);
  assert.equal(page.get('qaTetDays').value, '9');
  page.root.confirmResult = true; controller.showHome();
  assert.equal(page.get('settingsHome').hidden, false);
  let prevented = false; page.events.beforeunload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  await controller.openReviews();
  assert.equal(page.get('qaTetDays').value, '3');
  assert.equal(page.calls.length, 2);
});

test('busy review loads prevent navigation and revocation hides the feature chooser', async () => {
  let resolve;
  const page = fixture(url => url === '/api/session' ? { authenticated: false } : new Promise(done => { resolve = done; }));
  const controller = await ui.mount(page.root);
  const pending = controller.openReviews();
  controller.showHome(); await controller.openReviews();
  assert.equal(page.get('settingsHome').hidden, true);
  assert.equal(page.calls.length, 1);
  await controller.checkAccess(); resolve(defaults()); await pending;
  assert.equal(page.get('settingsHome').hidden, true);
  assert.equal(page.get('settingsBack').hidden, true);
  assert.equal(page.get('settingsEditor').hidden, true);
  await controller.openReviews(); controller.showHome();
  assert.equal(page.get('settingsHome').hidden, true);
});

test('settings access requires active Admin or valid exclusive Developer assignment', () => {
  assert.equal(ui.canManage(admin), true);
  assert.equal(ui.canManage({ ...admin, roles: ['admin', 'developer'] }), true);
  const developer = { isActive: true, roles: ['developer'], department: 'developer', signingStep: null };
  assert.equal(ui.canManage(developer), true);
  for (const user of [null, { ...admin, isActive: false }, { ...admin, roles: ['qa'] }, { ...developer, roles: ['developer', 'qa'] }, { ...developer, department: 'it' }, { ...developer, signingStep: 'prepared' }]) assert.equal(ui.canManage(user), false);
});

test('an initial session network failure offers Reload without claiming authorization denial', async () => {
  const page = fixture(); let offline = true;
  page.root.PCN_SESSION.require = async () => { if (offline) throw new Error('Offline'); return { user: admin }; };
  const controller = await ui.mount(page.root);
  assert.equal(page.get('settingsEditor').hidden, true);
  assert.equal(page.get('settingsReload').disabled, false);
  assert.match(page.get('settingsStatus').textContent, /Unable to verify.*Reload/);
  offline = false; await controller.reload();
  assert.equal(page.get('settingsHome').hidden, false);
  assert.equal(page.get('settingsEditor').hidden, true);
  await controller.openReviews();
  assert.equal(page.get('settingsEditor').hidden, false);
  assert.equal(page.get('qaTetDays').value, '3');
});

test('day validation accepts only bounded whole decimal days or disabled null', () => {
  for (const value of ['1', '365', '12']) assert.equal(ui.dayValue(true, value), Number(value));
  assert.equal(ui.dayValue(false, 'invalid'), null);
  for (const value of ['', '0', '366', '-1', '1.5', '1e2', ' 3 ', 'Infinity']) assert.throws(() => ui.dayValue(true, value), /whole number.*1.*365/);
});

test('denied sessions never fetch settings and keep the editor hidden', async () => {
  for (const user of [null, { ...admin, roles: ['qa'] }]) {
    const page = fixture(() => { throw new Error('must not fetch'); }, user);
    await ui.mount(page.root);
    assert.equal(page.calls.length, 0);
    assert.equal(page.get('settingsEditor').hidden, true);
    assert.equal(page.get('settingsHome').hidden, true);
    assert.match(page.get('settingsStatus').textContent, /Administrator access required/);
  }
});

test('all eight controls load defaults and save only the exact versioned payload once', async () => {
  let resolve;
  const page = fixture((url, options) => options?.method === 'PUT' ? new Promise(done => { resolve = done; }) : defaults());
  const controller = await mountEditor(page);
  assert.equal(page.get('settingsEditor').hidden, false);
  for (const { key } of ui.RULES) {
    assert.equal(page.get(`${key}Enabled`).checked, defaults().pendingDays[key] !== null);
    assert.equal(page.get(`${key}Days`).disabled, defaults().pendingDays[key] === null);
  }
  change(page, 'qaTet', '7');
  assert.equal(page.get('settingsSave').disabled, false);
  const pending = controller.save(); await controller.save();
  const writes = page.calls.filter(call => call.options?.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].options.body), { schemaVersion: 1, version: 0, pendingDays: { ...defaults().pendingDays, qaTet: 7 } });
  resolve({ ...defaults(), version: 1, pendingDays: { ...defaults().pendingDays, qaTet: 7 }, updatedBy: 'Admin Tester', updatedAt: '2026-10-21T02:00:00Z' }); await pending;
  assert.match(page.get('settingsSaved').textContent, /Admin Tester/);
  assert.equal(page.get('settingsSave').disabled, true);
});

test('invalid field focuses the error and prevents PUT', async () => {
  const page = fixture(); const controller = await mountEditor(page);
  change(page, 'qaTet', '1.5'); await controller.save();
  assert.equal(page.get('qaTetDays').focused, true);
  assert.equal(page.get('qaTetDays').attributes['aria-invalid'], 'true');
  assert.match(page.get('qaTetError').textContent, /whole number/);
  assert.equal(page.calls.filter(call => call.options?.method === 'PUT').length, 0);
});

test('conflict and network failures preserve drafts and warn before reload discards edits', async () => {
  let failure = Object.assign(new Error('Stale version'), { status: 409 });
  const page = fixture((url, options) => { if (options?.method === 'PUT') throw failure; return defaults(); });
  const controller = await mountEditor(page); change(page, 'qaTet', '8');
  await controller.save(); assert.match(page.get('settingsStatus').textContent, /changed.*Reload/i);
  assert.equal(page.get('qaTetDays').value, '8');
  failure = new Error('Network unavailable'); await controller.save();
  assert.equal(page.get('qaTetDays').value, '8');
  page.root.confirmResult = false; await controller.reload();
  assert.equal(page.get('qaTetDays').value, '8'); assert.equal(page.confirmations.length, 1);
  let prevented = false; page.events.beforeunload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  page.root.confirmResult = true; await controller.reload(); assert.equal(page.get('qaTetDays').value, '3');
  prevented = false; page.events.beforeunload({ preventDefault() { prevented = true; } }); assert.equal(prevented, false);
});

test('reload network failure preserves edits and load failure allows retry', async () => {
  let fail = true;
  const page = fixture(() => { if (fail) throw new Error('Offline'); return defaults(); });
  const controller = await mountEditor(page); assert.equal(page.get('settingsEditor').hidden, true);
  fail = false; await controller.reload(); change(page, 'qaTet', '9');
  fail = true; await controller.reload(); assert.equal(page.get('qaTetDays').value, '9');
});

test('revocation clears protected content and a late save cannot restore it', async () => {
  let resolve;
  const page = fixture((url, options) => {
    if (url === '/api/session') return { authenticated: true, user: { ...admin, roles: ['qa'] } };
    if (options?.method === 'PUT') return new Promise(done => { resolve = done; });
    return defaults();
  });
  const controller = await mountEditor(page); change(page, 'qaTet', '7'); const pending = controller.save();
  await controller.checkAccess(); resolve({ ...defaults(), version: 1 }); await pending;
  assert.equal(page.get('settingsEditor').hidden, true);
  assert.equal(page.get('qaTetDays').value, ''); assert.equal(page.get('settingsSaved').textContent, '');
  assert.match(page.get('settingsStatus').textContent, /Administrator access required/);
});

test('disabled limits save as null and reenabling restores an editable calendar-day value', async () => {
  const page = fixture((url, options) => options?.method === 'PUT' ? { ...defaults(), ...JSON.parse(options.body), version: 1 } : defaults());
  const controller = await mountEditor(page);
  page.get('qaTetEnabled').checked = false; page.get('qaTetEnabled').events.change();
  assert.equal(page.get('qaTetDays').disabled, true);
  await controller.save();
  assert.equal(JSON.parse(page.calls.find(call => call.options?.method === 'PUT').options.body).pendingDays.qaTet, null);
  page.get('qaTetEnabled').checked = true; page.get('qaTetEnabled').events.change();
  assert.equal(page.get('qaTetDays').disabled, false);
  assert.equal(page.get('qaTetDays').value, '3');
});

test('API permission failures clear the form on save or reload', async () => {
  for (const action of ['save', 'reload']) {
    let deny = false;
    const page = fixture(() => { if (deny) throw Object.assign(new Error('Forbidden'), { status: 403 }); return defaults(); });
    const controller = await mountEditor(page); change(page, 'qaTet', '8'); deny = true;
    await controller[action]();
    assert.equal(page.get('settingsEditor').hidden, true);
    assert.equal(page.get('qaTetDays').value, '');
    assert.equal(page.get('settingsSave').disabled, true);
  }
});

test('session checking preserves edits on network errors but clears them for an expired session', async () => {
  let error = new Error('Offline');
  const page = fixture(url => { if (url === '/api/session') throw error; return defaults(); });
  const controller = await mountEditor(page); change(page, 'qaTet', '8');
  await page.events.focus(); assert.equal(page.get('qaTetDays').value, '8');
  assert.match(page.get('settingsStatus').textContent, /Unable to verify/);
  error = Object.assign(new Error('Expired'), { status: 401 });
  await controller.checkAccess(); assert.equal(page.get('settingsEditor').hidden, true);
});

test('late reload responses cannot restore access and malformed responses preserve loaded edits', async () => {
  let result = defaults();
  const page = fixture(url => url === '/api/session' ? { authenticated: false } : result);
  const controller = await mountEditor(page); change(page, 'qaTet', '8');
  result = { ...defaults(), pendingDays: { ...defaults().pendingDays, qaTet: 900 } };
  await controller.reload(); assert.equal(page.get('qaTetDays').value, '8');
  assert.match(page.get('settingsStatus').textContent, /invalid settings/);
  let resolve; result = new Promise(done => { resolve = done; });
  const pending = controller.reload(); await controller.checkAccess(); resolve(defaults()); await pending;
  assert.equal(page.get('settingsEditor').hidden, true);
  assert.equal(page.get('qaTetDays').value, '');
});

test('settings assets are accessible, linked and allowed in runtime packages', () => {
  const files = ['system-settings.html', 'system-settings.js', 'system-settings.css'];
  assert.deepEqual(selectRuntimeFiles(files), files.sort());
  const html = fs.readFileSync('system-settings.html', 'utf8');
  for (const { key, label } of ui.RULES) {
    assert.ok(html.includes(label));
    assert.ok(html.includes(`for="${key}Enabled"`)); assert.ok(html.includes(`for="${key}Days"`));
  }
  assert.match(html, /aria-live="polite"/);
  assert.match(fs.readFileSync('admin.html', 'utf8'), /id="adminSystemSettingsLink"[^>]*href="\/system-settings"[^>]*hidden/);
  for (const file of files) assert.ok(fs.readFileSync('scripts/deploy-pcn-release.ps1', 'utf8').includes(`'${file}'`));
  const server = fs.readFileSync('src/httpServer.js', 'utf8');
  for (const file of files) assert.ok(server.includes(`'${file}'`));
  assert.match(server, /route === '\/system-settings'/);
});

test('System Settings route and its runtime assets serve through the static allowlist', async t => {
  const { createApp } = require('../src/httpServer');
  const app = createApp({ service: {}, authService: {} });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const origin = `http://127.0.0.1:${app.address().port}`;
  for (const [route, type] of [['/system-settings', 'text/html'], ['/system-settings.js', 'text/javascript'], ['/system-settings.css', 'text/css']]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok((await response.text()).length);
    const head = await fetch(origin + route, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  }
});
