const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { usersPage, verifiedMail } = require('./helpers/users-page');

function portal(fetch) {
  const source = fs.readFileSync(require.resolve('../admin.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'render = () => window.renders++; renderNotificationSettings = () => window.routingRenders++; window.TEST = { state, els, canAutoRefresh, refreshQuietly, startBusy };})();');
  const window = { location: { hash: '#records' }, renders: 0, routingRenders: 0, PCN_SESSION: { fetch } };
  vm.runInNewContext(source, { window, document: { addEventListener() {}, querySelector: () => null, activeElement: null } });
  window.TEST.state.user = { roles: ['admin'] };
  window.TEST.state.isLoading = false;
  window.TEST.els.adminRemoveDialog = { hidden: true };
  window.TEST.els.notificationRecipientDialog = { open: false };
  return { ...window.TEST, window };
}

test('quiet records poll keeps selection and filters, renders changes only and uses only list/progress GETs', async () => {
  const calls = [];
  const record = { id: 'PCN1', status: 'draft' };
  const page = portal(async url => { calls.push(url); return url.endsWith('/progress') ? { status: 'new' } : [record]; });
  page.state.pcns = [record]; page.state.selected = record; page.state.progress = { status: 'new' };
  page.state.filters.search = 'keep';
  await page.refreshQuietly();
  assert.equal(page.window.renders, 0);
  page.state.pcns = [{ ...record, status: 'old' }];
  await page.refreshQuietly();
  assert.equal(page.window.renders, 1);
  assert.equal(page.state.selected.id, 'PCN1');
  assert.equal(page.state.filters.search, 'keep');
  assert.deepEqual([...new Set(calls)], ['/api/pcns', '/api/pcns/PCN1/progress']);
});

test('routing polling preserves drafts and open dialogs, and discards responses after a manual action begins', async () => {
  let resolve;
  const page = portal(() => new Promise(done => { resolve = done; }));
  page.state.view = 'mail'; page.state.hasMailChanges = true;
  assert.equal(page.canAutoRefresh(), false);
  page.state.hasMailChanges = false; page.els.notificationRecipientDialog.open = true;
  assert.equal(page.canAutoRefresh(), false);
  page.els.notificationRecipientDialog.open = false;
  const before = page.state.notificationSettings;
  const poll = page.refreshQuietly();
  page.startBusy('routingReload', 'Loading', false);
  resolve({ groups: [], version: 'new' }); await poll;
  assert.equal(page.state.notificationSettings, before);
  assert.equal(page.window.routingRenders, 0);
});

test('records transient failures retain data, permission failures clear protected data', async () => {
  let status = 500;
  const page = portal(async () => { throw Object.assign(new Error('unavailable'), { status }); });
  page.state.pcns = [{ id: 'keep' }];
  await assert.rejects(page.refreshQuietly());
  assert.equal(page.state.pcns.length, 1);
  status = 403;
  await assert.rejects(page.refreshQuietly());
  assert.equal(page.state.pcns.length, 0);
  assert.equal(page.canAutoRefresh(), false);
});

test('quiet routing reads only settings and renders changed saved recipients without a full page render', async () => {
  const calls = [];
  const settings = { groups: [{ key: 'supplierNotification', emails: 'new@example.test' }], version: 'new' };
  const page = portal(async url => { calls.push(url); return settings; });
  page.state.view = 'mail';
  await page.refreshQuietly(); await page.refreshQuietly();
  assert.deepEqual(calls, ['/api/notification-settings', '/api/notification-settings']);
  assert.equal(page.window.routingRenders, 1);
  assert.equal(page.window.renders, 0);
});

test('poll responses are discarded when the scheduler invalidates their visible-page context', async () => {
  const page = portal(async () => [{ id: 'new' }]);
  page.state.pcns = [{ id: 'keep' }];
  await page.refreshQuietly({ isCurrent: () => false });
  assert.equal(page.state.pcns[0].id, 'keep');
  assert.equal(page.window.renders, 0);
});

const account = { id: 'one', employeeCode: '1234567', displayName: 'Person', roles: ['qa'], department: 'qaTet', signingStep: 'checked', identityProvider: 'employee-code', isActive: true, version: '0011223344556677', mailProfile: verifiedMail };
test('Users polls changed data without resetting filters; unchanged polls retain rows and dialog suppresses polls', async () => {
  let users = [account];
  const page = await usersPage(users, { fetch(url) { if (url === '/api/admin/users') return users; } });
  assert.ok(page.autoRefresh);
  const originalRow = page.firstUserRow();
  await page.autoRefresh.refresh();
  assert.equal(page.firstUserRow(), originalRow);
  page.element('usersSearchFilter').value = 'person';
  users = [{ ...account, displayName: 'Person updated' }];
  await page.autoRefresh.refresh();
  assert.equal(page.element('usersSearchFilter').value, 'person');
  assert.notEqual(page.firstUserRow(), originalRow);
  page.openCreate();
  assert.equal(page.autoRefresh.canRefresh(), false);
});

test('Users rejects transient failures for backoff while preserving rows and discards in-flight data after dialog opens', async () => {
  let pending;
  const page = await usersPage([account], { fetch(url) { if (pending && url === '/api/admin/users') return pending; } });
  const row = page.firstUserRow();
  pending = Promise.reject(new Error('offline'));
  await assert.rejects(page.autoRefresh.refresh());
  assert.equal(page.firstUserRow(), row);
  let resolve; pending = new Promise(done => { resolve = done; });
  const poll = page.autoRefresh.refresh(); page.openCreate();
  resolve([]); await poll;
  assert.equal(page.firstUserRow(), row);
});

test('Users retains action focus when rows change and clears protected data after losing access', async () => {
  let users = [account]; let status;
  const page = await usersPage(users, { fetch(url) {
    if (url !== '/api/admin/users') return;
    if (status) throw Object.assign(new Error('forbidden'), { status });
    return users;
  } });
  const edit = page.element('adminUsersRows').querySelectorAll('[data-user-id]').find(button => button.getAttribute('data-user-action') === 'edit');
  edit.focus();
  users = [{ ...account, displayName: 'Changed' }];
  await page.autoRefresh.refresh();
  assert.equal(page.document.activeElement.getAttribute('data-user-id'), account.id);
  assert.equal(page.document.activeElement.getAttribute('data-user-action'), 'edit');
  assert.notEqual(page.document.activeElement, edit);
  status = 403;
  await assert.rejects(page.autoRefresh.refresh());
  assert.equal(page.element('adminUsersRows').children.length, 0);
  assert.equal(page.autoRefresh.canRefresh(), false);
});
