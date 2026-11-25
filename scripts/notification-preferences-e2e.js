// Actual loopback API and isolated memory settings/authentication. No SQL or mail.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: browserExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { ApiError } = require('../src/apiError');
const { memoryRepository, fakeAuthService, TEST_PASSWORD } = require('../test/helpers/apiHarness');
const { settingsVersion, resolveNextMailTarget } = require('../src/mailRouting');
const { notificationPreferencesView, validateNotificationPreferences, filterNotificationRecipients,
  readNotificationPreferences, assertGroupExclusionCompatibility } = require('../src/notificationPreferences');
const { preferenceBatches, defaultRoutingRecipients } = require('../src/notificationPreferenceRuntime');
const { notificationRecipient } = require('../src/notificationUpdates');

const expect = browserExpect.configure({ timeout: 12000 });
const endpoint = '/api/admin/notification-preferences';
const types = ['submitted', 'actionRequired', 'updated', 'completed', 'dueSoon', 'overdue'];
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const maliciousName = 'Recipient <img src=x onerror="window.notificationInjected=true">';
const artifact = name => path.resolve('test-results', `notification-preferences-${name}`);
const report = { storage: 'isolated_memory_only', checks: [], writes: [], errors: [], forbidden: [], external: [], status: 'running' };
const checked = name => { report.checks.push(name); console.log(JSON.stringify({ notificationPreferencesCheck: name })); };
const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

function verifiedRecipient(number, changes = {}) {
  const email = `recipient${number}@example.test`, directoryId = `synthetic-directory-${number}`;
  return { id: id(number), username: `recipient-${number}`, employeeCode: String(number).padStart(7, '0'),
    identityProvider: 'employee-code', isActive: true, roles: ['gsc'], department: 'gscTet', signingStep: 'prepared',
    displayName: `Recipient ${number}`, email, mailDirectoryId: directoryId, mailVerifiedAt: '2026-11-20T00:00:00Z',
    mailProfile: { id: directoryId, email, displayName: `Recipient ${number}` }, ...changes };
}

function fixtures() {
  const repository = memoryRepository();
  const authService = fakeAuthService({ additionalUsers: [
    verifiedRecipient(1, { displayName: maliciousName }),
    verifiedRecipient(2, { roles: ['qa'], department: 'qaTet', signingStep: 'approved' }),
    verifiedRecipient(3, { roles: [], department: null, signingStep: null }),
    verifiedRecipient(4, { roles: ['reviewer'], department: 'qaTet', signingStep: null }),
    verifiedRecipient(10, { username: 'preferences-developer', roles: ['developer'], department: 'developer', signingStep: null }),
    { username: 'preferences-viewer', id: id(11), roles: [], identityProvider: 'employee-code', employeeCode: '0011011' },
    { username: 'invalid-developer', id: id(12), roles: ['developer'], department: 'qaTet', signingStep: null }
  ] });
  const initialRouting = { schemaVersion: 2, groups: [{ key: 'department.gscTet.prepared', emails: 'legacy@example.test', recipients: [] }], legacyGroups: [] };
  let raw = structuredClone(initialRouting);
  const state = { revokeAdmin: false, saves: 0 };
  repository.getNotificationSettings = async () => structuredClone(raw);
  repository.saveNotificationSettings = async (input, actor, expectedVersion) => {
    if (expectedVersion !== settingsVersion(raw)) throw new ApiError(409, 'Notification settings changed; reload before saving');
    raw = structuredClone(input); state.saves += 1;
    return structuredClone(raw);
  };
  const accounts = () => authService.repository.listUsers();
  repository.getNotificationPreferences = async () => notificationPreferencesView(await repository.getNotificationSettings(), await accounts());
  repository.saveNotificationPreferences = async (input, actor, user) => {
    const users = await accounts(), validated = validateNotificationPreferences(input, users);
    const settings = await repository.getNotificationSettings();
    assertGroupExclusionCompatibility(validated, settings);
    const next = { ...settings, notificationPreferences: readNotificationPreferences({ schemaVersion: 1, rules: validated.rules,
      updatedAt: new Date().toISOString(), updatedBy: actor }) };
    await repository.saveNotificationSettings(next, actor, validated.version, user);
    return notificationPreferencesView(await repository.getNotificationSettings(), users);
  };
  for (const method of ['create', 'update', 'delete', 'saveWorkflowSettings']) repository[method] = async () => {
    report.forbidden.push(method); throw new Error('Notification preferences must not change business data');
  };
  const originalSession = authService.session.bind(authService);
  authService.session = async (...args) => {
    const principal = await originalSession(...args);
    return state.revokeAdmin && principal?.user.username === 'admin'
      ? { ...principal, user: { ...principal.user, roles: [], department: null } } : principal;
  };
  return { repository, authService, state, initialRouting,
    setManualDeveloperRoute(enabled) {
      raw = { ...raw, groups: enabled ? [...structuredClone(initialRouting.groups), { key: 'department.gscTet.checked', emails: 'recipient10@example.test', recipients: [] }]
        : structuredClone(initialRouting.groups) };
    } };
}

function assertPayload(body) {
  assert.deepEqual(Object.keys(body).sort(), ['rules', 'schemaVersion', 'version']);
  assert.equal(body.schemaVersion, 1); assert.match(body.version, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(body.rules).sort(), [...types].sort());
  for (const rule of Object.values(body.rules)) {
    assert.deepEqual(Object.keys(rule).sort(), ['enabled', 'excludedUserIds', ...(Object.hasOwn(rule, 'excludedGroupKeys') ? ['excludedGroupKeys'] : []), 'groupKeys', 'includeDefaultRecipients', 'userIds'].sort());
    assert.equal(typeof rule.enabled, 'boolean'); assert.equal(typeof rule.includeDefaultRecipients, 'boolean');
    for (const key of ['groupKeys', 'userIds', 'excludedUserIds', ...(Object.hasOwn(rule, 'excludedGroupKeys') ? ['excludedGroupKeys'] : [])]) assert(Array.isArray(rule[key]));
    for (const userId of [...rule.userIds, ...rule.excludedUserIds]) assert.match(userId, /^[a-f0-9-]{36}$/);
    assert(!rule.userIds.some(userId => rule.excludedUserIds.includes(userId)));
  }
  assert(!JSON.stringify(body).includes('@'), 'Preferences submit stable identities and group keys, never free-form email recipients');
}

// Run the production recipient-batch selection without queuing or sending mail.
async function recipientSelection(fixture, type, groupKey = 'department.gscTet.prepared') {
  const settings = await fixture.repository.getNotificationSettings(), users = await fixture.authService.repository.listUsers();
  const record = { id: 'T-24112601', documentType: 'ta', status: 'submitted', ownerUserId: 'supplier-id', riskLevel: 'RL2',
    internalReview: groupKey === 'department.gscTet.checked' ? { signoff: { gscTet: { prepared: true } } } : {} };
  if (['actionRequired', 'dueSoon', 'overdue'].includes(type)) assert.equal(resolveNextMailTarget(record).groupKey, groupKey);
  const defaults = ['submitted', 'updated', 'completed'].includes(type)
    ? users.map(user => notificationRecipient(user, record, ['gscTet'])).filter(Boolean)
    : defaultRoutingRecipients(settings, users, groupKey);
  const selected = preferenceBatches(settings, type, { record, users, defaultRecipients: defaults }, { subject: 'Fixture only', body: 'Never sent' });
  return { settings, record, users, defaultRecipients: defaults, recipients: selected.batches.flatMap(batch => batch.notificationPreferenceSnapshot.recipients) };
}
async function recipientIds(fixture, type, groupKey) {
  const selected = await recipientSelection(fixture, type, groupKey);
  return [...new Set(selected.recipients.map(recipient => recipient.userId || recipient.email))].sort();
}

class PreferencesPage {
  constructor(page, origin) { this.page = page; this.origin = origin; }
  field(name) { return this.page.locator(`#notification${name}`); }
  async open() {
    await this.page.goto(`${this.origin}/system-settings`);
    await expect(this.page.locator('#settingsHome')).toBeVisible();
    await this.page.locator('#settingsNotifications').click();
    await this.ready();
  }
  async ready() {
    await expect(this.page.locator('#notificationEditor')).toBeVisible();
    await expect(this.field('Type').locator('option')).toHaveCount(6);
    await expect(this.field('View')).toBeEnabled();
  }
  async type(value) { await this.field('View').selectOption('type'); await this.field('Type').selectOption(value); }
  async overview(key) { await this.field('View').selectOption('group'); await this.field('OverviewGroup').selectOption(key); }
  async group(key) { await this.field('GroupPicker').selectOption(key); await this.field('AddGroup').click(); }
  async user(userId, exclude = false) {
    await this.field('UserSearch').fill(''); await this.field('UserPicker').selectOption(userId);
    await this.field(exclude ? 'ExcludeUser' : 'IncludeUser').click();
  }
  async save(status = 200) {
    const response = this.page.waitForResponse(item => new URL(item.url()).pathname === endpoint && item.request().method() === 'PUT');
    await this.field('Save').click(); const result = await response;
    assert.equal(result.status(), status); assertPayload(result.request().postDataJSON());
    if (status === 200) {
      await expect(this.page.locator('#settingsStatus')).toContainText(/saved/i);
      await expect(this.field('Save')).toBeDisabled();
    }
    return result.request().postDataJSON();
  }
  async reload(discard) {
    if (discard !== undefined) this.page.once('dialog', dialog => discard ? dialog.accept() : dialog.dismiss());
    await this.page.locator('#settingsReload').click();
    if (discard !== false) await this.ready();
  }
}

async function openContext(browser, origin, username, contexts) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  contexts.push({ context, name: `${username}-${contexts.length}` });
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
    if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
    if (!['GET', 'HEAD'].includes(request.method())) {
      if (url.pathname === endpoint && request.method() === 'PUT') report.writes.push(request.postDataJSON());
      else { report.forbidden.push(request.method() + ' ' + url.pathname); return route.abort(); }
    }
    if (/\/notifications(?:\/|$)/.test(url.pathname) || /\/directory-users$/.test(url.pathname)) {
      report.forbidden.push(request.method() + ' ' + url.pathname); return route.abort();
    }
    return route.continue();
  });
  const response = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: TEST_PASSWORD } });
  assert.equal(response.status(), 200);
  context.on('page', page => { page.setDefaultTimeout(12000); page.on('pageerror', error => report.errors.push(error.message)); });
  return context;
}

async function loadingAndDefaults(editor) {
  const page = editor.page;
  await page.goto(`${editor.origin}/system-settings`);
  await expect(page.locator('#settingsHome')).toBeVisible();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const hold = async route => { if (route.request().method() === 'GET') await gate; return route.fallback(); };
  await page.route(`**${endpoint}`, hold);
  try {
    await page.locator('#settingsNotifications').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#settingsStatus')).toContainText(/load/i);
    await expect(editor.field('Save')).toBeDisabled();
    release(); await editor.ready();
  } finally { release(); await page.unroute(`**${endpoint}`, hold); }
  await expect(page.locator('#notificationTitle')).toBeFocused();
  await expect(editor.field('View')).toHaveValue('group');
  await expect(editor.field('GroupView')).toBeVisible(); await expect(editor.field('TypeView')).toBeHidden();
  await expect(editor.field('OverviewGroup').locator('option')).toHaveCount(37);
  await expect(editor.field('GroupRules')).toBeHidden();
  await editor.overview('role.developer');
  await expect(editor.field('GroupRules').locator('input[type="checkbox"]')).toHaveCount(6);
  for (const type of types) {
    if (['submitted', 'updated', 'completed'].includes(type)) await expect(editor.field(`GroupSelected-${type}`)).toBeChecked();
    else await expect(editor.field(`GroupSelected-${type}`)).not.toBeChecked();
  }
  for (const type of types) {
    await editor.type(type); await expect(editor.field('Enabled')).toBeChecked();
    await expect(editor.field('UseDefaults')).toBeChecked();
  }
  await expect(editor.field('Save')).toBeDisabled();
  for (const name of ['AddGroup', 'IncludeUser', 'ExcludeUser']) await expect(editor.field(name)).toBeDisabled();
  await expect(editor.field('GroupPicker').locator('option')).toHaveCount(37);
  for (const role of ['admin', 'developer', 'reviewer', 'supplier', 'gsc', 'productionengineering', 'qa', 'tapbu']) {
    await expect(editor.field('GroupPicker').locator(`option[value="role.${role}"]`)).toHaveCount(1);
  }
  await expect(editor.field('GroupPicker').locator('option[value="role.admin"]')).toHaveText('PCN role — Administrator');
  await expect(editor.field('GroupPicker').locator('option[value="role.developer"]')).toHaveText('PCN role — Developer');
  assert.equal(report.writes.length, 0);
  checked('Notifications opens by keyboard, shows loading safely, and preserves all six default delivery rules without implicit saves');
}

async function audienceAndPersistence(editor, fixture) {
  await editor.type('actionRequired');
  await editor.field('UseDefaults').uncheck();
  await editor.group('department.gscTet.any'); await editor.group('department.qaTet.approved');
  await editor.group('role.admin'); await editor.group('role.developer');
  await editor.user(id(1)); await editor.user(id(1), true); await editor.user(id(1));
  await editor.user(id(2), true);
  await expect(editor.field('SelectedUsers')).toContainText(maliciousName);
  assert.equal(await editor.page.locator('img[src="x"]').count(), 0);
  assert.equal(await editor.page.evaluate(() => window.notificationInjected), undefined);
  await editor.type('updated'); await editor.field('Enabled').uncheck();
  await editor.type('actionRequired'); await expect(editor.field('UseDefaults')).not.toBeChecked();
  const body = await editor.save();
  assert.equal(body.rules.updated.enabled, false);
  assert.deepEqual(body.rules.actionRequired.groupKeys.sort(), ['department.gscTet.any', 'department.qaTet.approved', 'role.admin', 'role.developer']);
  assert.deepEqual(body.rules.actionRequired.userIds, [id(1)]);
  assert.deepEqual(body.rules.actionRequired.excludedUserIds, [id(2)]);
  await editor.reload(); await editor.type('actionRequired');
  await expect(editor.field('SelectedGroups')).toContainText('GSC/TET');
  await expect(editor.field('SelectedGroups')).toContainText('PCN role — Administrator');
  await expect(editor.field('SelectedGroups')).toContainText('PCN role — Developer');
  await expect(editor.field('SelectedUsers')).toContainText(maliciousName);
  await editor.type('updated'); await expect(editor.field('Enabled')).not.toBeChecked();
  const stored = await fixture.repository.getNotificationSettings();
  assert.deepEqual(stored.groups, fixture.initialRouting.groups); assert.deepEqual(stored.legacyGroups, []);
  assert.equal(stored.notificationPreferences.rules.updated.enabled, false);
  checked('All eight PCN role groups are available; Administrator/Developer and department/signing groups persist with included/excluded users per type without changing mail routing');
  checked('Untrusted display names render as literal text; payloads contain strict rule fields and UUID/group identifiers without free-form email addresses');
}

async function currentDefaultsJourney(editor, fixture) {
  const before = await fixture.repository.getNotificationPreferences();
  const writes = report.writes.length;
  const developer = before.options.groups.find(group => group.key === 'role.developer');
  assert.deepEqual([...developer.defaultTypes].sort(), ['completed', 'submitted', 'updated']);
  assert.deepEqual(developer.members, [id(10)]);
  await editor.overview('role.developer');
  for (const type of types) {
    assert.equal(before.rules[type].enabled, true);
    assert.equal(before.rules[type].includeDefaultRecipients, true);
    assert.deepEqual(before.rules[type].groupKeys, []);
    if (['submitted', 'updated', 'completed'].includes(type)) {
      await expect(editor.field(`GroupSelected-${type}`)).toBeChecked();
      assert((await recipientIds(fixture, type)).includes(id(10)), `${type} default audience includes Developer`);
    } else await expect(editor.field(`GroupSelected-${type}`)).not.toBeChecked();
  }
  await expect(editor.field('GroupSummary')).toContainText('3');
  for (const width of [1440, 320]) {
    await editor.page.setViewportSize({ width, height: width === 320 ? 844 : 1000 });
    assert(await editor.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (const type of types) {
      const bounds = await editor.field(`GroupCurrent-${type}`).boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
    }
    await editor.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await editor.page.screenshot({ path: artifact(`current-defaults-${width === 1440 ? 'desktop' : 'mobile-320'}.png`), fullPage: true });
  }
  await editor.page.setViewportSize({ width: 1440, height: 1000 });
  await expect(editor.field('Save')).toBeDisabled();
  assert.equal(report.writes.length, writes);
  assert.deepEqual((await fixture.repository.getNotificationPreferences()).rules, before.rules);
  checked('Developer shows three effective default general notifications checked and workflow mail off; production recipient batching confirms the default Developer audience without adding group subscriptions');
}

async function manualRoutingJourney(editor, fixture) {
  fixture.setManualDeveloperRoute(true); await editor.reload(); await editor.overview('role.developer');
  const view = await fixture.repository.getNotificationPreferences();
  const group = view.options.groups.find(item => item.key === 'role.developer');
  assert.equal(group.defaultModes.actionRequired, 'routing');
  await expect(editor.field('GroupSelected-actionRequired')).toBeChecked();
  await expect(editor.field('GroupCurrent-actionRequired')).toContainText(/routing/i);
  assert((await recipientIds(fixture, 'actionRequired', 'department.gscTet.checked')).includes(id(10)));
  assert(!(await recipientIds(fixture, 'actionRequired', 'department.gscTet.prepared')).includes(id(10)), 'Manual routing remains conditional on the active review step');
  await editor.field('GroupSelected-actionRequired').uncheck(); const off = await editor.save();
  assert(off.rules.actionRequired.excludedGroupKeys.includes('role.developer'));
  assert(!(await recipientIds(fixture, 'actionRequired', 'department.gscTet.checked')).includes(id(10)));
  await editor.field('GroupSelected-actionRequired').check(); const on = await editor.save();
  assert(!(on.rules.actionRequired.excludedGroupKeys || []).includes('role.developer'));
  assert(!on.rules.actionRequired.groupKeys.includes('role.developer'), 'On restores matched defaults instead of broadening all action requests');
  fixture.setManualDeveloperRoute(false); await editor.reload(); await editor.overview('role.developer');
  await expect(editor.field('GroupSelected-actionRequired')).not.toBeChecked();
  checked('Known manual Developer routing displays conditional workflow Receive, Off blocks that real route, and On restores defaults without subscribing the role to unrelated review steps');
}

async function groupFirstJourney(editor, fixture) {
  const before = (await fixture.repository.getNotificationPreferences()).rules;
  const original = await recipientSelection(fixture, 'submitted');
  const originalIds = original.recipients.map(recipient => recipient.userId || recipient.email).sort();
  const writes = report.writes.length;
  await editor.overview('role.developer');
  await expect(editor.field('GroupSelected-submitted')).toBeChecked();
  await expect(editor.field('GroupSelected-updated')).toBeDisabled();
  await expect(editor.field('GroupSelected-updated')).not.toBeChecked();
  await expect(editor.field('GroupCurrent-updated')).toContainText(/off for everyone/i);
  await editor.field('GroupSelected-submitted').uncheck();
  await editor.type('submitted');
  await expect(editor.field('ExcludedGroups')).toContainText('Developer');
  await editor.overview('role.developer');
  await expect(editor.field('GroupSelected-submitted')).not.toBeChecked();
  assert.equal(report.writes.length, writes, 'Effective group edits stay unsaved until Save');
  const off = await editor.save();
  assert.deepEqual(off.rules.submitted.excludedGroupKeys, ['role.developer']);
  assert.equal(off.rules.submitted.includeDefaultRecipients, true);
  assert.equal(off.rules.submitted.enabled, true);
  assert.deepEqual(off.rules.submitted.groupKeys, before.submitted.groupKeys);
  const afterIds = await recipientIds(fixture, 'submitted');
  assert(!afterIds.includes(id(10)));
  assert.deepEqual(afterIds, originalIds.filter(value => value !== id(10)), 'Developer Off leaves all other roles unchanged');
  const current = await recipientSelection(fixture, 'submitted');
  const pending = filterNotificationRecipients(current.settings, 'submitted', original.recipients, current);
  assert(!pending.recipients.some(recipient => recipient.userId === id(10)), 'Send-time policy also blocks previously selected Developer mail');
  await editor.reload(); await editor.overview('role.developer');
  await expect(editor.field('GroupSelected-submitted')).not.toBeChecked();
  await editor.field('GroupSelected-submitted').check(); const on = await editor.save();
  assert(!(on.rules.submitted.excludedGroupKeys || []).includes('role.developer'));
  assert(!on.rules.submitted.groupKeys.includes('role.developer'));
  assert.deepEqual(await recipientIds(fixture, 'submitted'), originalIds);
  await editor.reload(); await editor.overview('role.developer');
  await expect(editor.field('GroupSelected-submitted')).toBeChecked();
  checked('Developer Receive Off saves an explicit group exclusion and blocks fresh/send-time default mail without affecting other roles; On restores defaults without adding an extra role subscription');

  await editor.type('updated'); await editor.field('Enabled').check();
  await editor.overview('role.developer');
  await expect(editor.field('GroupSelected-updated')).toBeChecked();
  await expect(editor.field('GroupSelected-updated')).toBeEnabled();
  await editor.type('updated'); await editor.field('Enabled').uncheck();
  await editor.overview('role.developer');
  await expect(editor.field('GroupSelected-updated')).not.toBeChecked();
  await expect(editor.field('GroupSelected-updated')).toBeDisabled();
  await expect(editor.field('Save')).toBeDisabled();
  const keyboardWrites = report.writes.length;
  await editor.field('GroupSelected-submitted').focus(); await editor.page.keyboard.press('Space');
  await expect(editor.field('GroupSelected-submitted')).not.toBeChecked();
  await editor.page.keyboard.press('Space'); await expect(editor.field('GroupSelected-submitted')).toBeChecked();
  await expect(editor.field('Save')).toBeDisabled(); assert.equal(report.writes.length, keyboardWrites);
  for (const width of [1440, 320]) {
    await editor.page.setViewportSize({ width, height: width === 320 ? 844 : 1000 });
    assert(await editor.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await editor.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await editor.page.screenshot({ path: artifact(`group-first-${width === 1440 ? 'desktop' : 'mobile-320'}.png`), fullPage: true });
  }
  await editor.page.setViewportSize({ width: 1440, height: 1000 });
  checked('Global Off disables Receive; changing type-wide enabled state updates role checkboxes immediately, and keyboard/default toggles remain usable at desktop and 320px');
}

async function overlappingGroupJourney(editor, fixture) {
  await editor.type('updated'); await editor.field('Enabled').check(); await editor.group('role.gsc');
  await editor.overview('department.gscTet.any'); await expect(editor.field('GroupSelected-updated')).toBeChecked();
  await editor.field('GroupSelected-updated').uncheck(); const off = await editor.save();
  assert(off.rules.updated.excludedGroupKeys.includes('department.gscTet.any'));
  assert(off.rules.updated.groupKeys.includes('role.gsc'));
  assert(!(await recipientIds(fixture, 'updated')).includes(id(1)), 'Department Off beats an overlapping role subscription');
  await editor.type('updated'); await editor.user(id(1)); await editor.save();
  assert((await recipientIds(fixture, 'updated')).includes(id(1)), 'Individual Receive overrides group Off');
  await editor.overview('department.gscTet.any');
  await expect(editor.field('GroupSelected-updated')).not.toBeChecked();
  await expect(editor.field('GroupStatus-updated')).toContainText(/individual|exception/i);
  await editor.type('updated'); await editor.user(id(1), true); await editor.save();
  assert(!(await recipientIds(fixture, 'updated')).includes(id(1)), 'Individual Exclude wins over overlapping groups and defaults');
  await expect(editor.field('ExcludedGroups')).toContainText('GSC/TET');
  await editor.field('ExcludedGroups').getByRole('button', { name: /remove/i }).click();
  const cleared = await editor.save();
  assert(!(cleared.rules.updated.excludedGroupKeys || []).includes('department.gscTet.any'));
  assert(!(await recipientIds(fixture, 'updated')).includes(id(1)), 'Clearing group Off retains the individual Exclude');
  checked('Department Off beats overlapping role subscriptions; individual Receive can override it, individual Exclude wins, and Details can clear group blocks without erasing user exclusions');
}

async function conflictAndDiscard(editor, second) {
  await second.open();
  await editor.type('completed'); await editor.field('Enabled').uncheck(); await editor.save();
  await second.overview('role.developer'); await second.field('GroupSelected-overdue').check();
  await second.save(409);
  await expect(second.page.locator('#settingsStatus')).toContainText(/preserv|reload|changed/i);
  await expect(second.field('GroupSelected-overdue')).toBeChecked();
  await second.reload(false); await expect(second.field('GroupSelected-overdue')).toBeChecked();
  await second.reload(true); await second.overview('role.developer'); await expect(second.field('GroupSelected-overdue')).not.toBeChecked();
  await second.type('overdue'); await expect(second.field('Enabled')).toBeChecked();
  await second.type('completed'); await expect(second.field('Enabled')).not.toBeChecked();
  checked('Real stale-version saves return 409 while preserving the draft; Reload supports cancel and explicit discard before loading the latest rules');
}

async function rejectFreeEmail(context, origin, fixture) {
  const current = await fixture.repository.getNotificationPreferences();
  const session = (await (await context.request.get(`${origin}/api/session`)).json()).data;
  const saves = fixture.state.saves;
  const invalid = { schemaVersion: 1, version: current.version,
    rules: { ...current.rules, updated: { ...current.rules.updated, emails: 'unmanaged@example.test' } } };
  const response = await context.request.put(`${origin}${endpoint}`, {
    headers: { origin, 'x-csrf-token': session.csrfToken }, data: invalid
  });
  assert.equal(response.status(), 400);
  assert.equal(fixture.state.saves, saves);
  checked('The real settings API rejects free-form email fields without persisting any change');
}

async function responsive(editor) {
  await editor.type('actionRequired');
  for (const width of [1440, 320]) {
    await editor.page.setViewportSize({ width, height: width === 320 ? 844 : 1000 });
    assert(await editor.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (const name of ['Type', 'GroupPicker', 'UserSearch', 'UserPicker', 'Save']) {
      const bounds = await editor.field(name).boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `${width}px ${name} stays within the viewport`);
    }
    await editor.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await editor.page.screenshot({ path: artifact(`${width === 1440 ? 'desktop' : 'mobile-320'}.png`), fullPage: true });
  }
  await editor.field('Enabled').focus(); await editor.page.keyboard.press('Space');
  await expect(editor.field('Enabled')).not.toBeChecked();
  await editor.page.keyboard.press('Space'); await expect(editor.field('Enabled')).toBeChecked();
  await editor.page.setViewportSize({ width: 1440, height: 1000 });
  checked('Desktop and 320px editors keep all selectors/actions contained; native keyboard selection and enable controls work');
}

async function permissions(browser, origin, contexts, fixture, editor) {
  const developer = await openContext(browser, origin, 'preferences-developer', contexts);
  const developerEditor = new PreferencesPage(await developer.newPage(), origin); await developerEditor.open();
  await developerEditor.type('dueSoon'); await developerEditor.field('Enabled').uncheck(); await developerEditor.save();
  checked('A correctly assigned Developer can open and save Notifications just like an Administrator');
  for (const username of ['preferences-viewer', 'invalid-developer']) {
    const context = await openContext(browser, origin, username, contexts);
    const page = await context.newPage(); await page.goto(`${origin}/system-settings`);
    await expect(page.locator('#settingsHome')).toBeHidden(); await expect(page.locator('#notificationEditor')).toBeHidden();
    assert.equal((await context.request.get(`${origin}${endpoint}`)).status(), 403);
    const session = (await (await context.request.get(`${origin}/api/session`)).json()).data;
    const current = await fixture.repository.getNotificationPreferences();
    const response = await context.request.put(`${origin}${endpoint}`, { headers: { origin, 'x-csrf-token': session.csrfToken },
      data: { schemaVersion: 1, version: current.version, rules: current.rules } });
    assert.equal(response.status(), 403);
  }
  fixture.state.revokeAdmin = true;
  await editor.page.locator('#settingsReload').click();
  await expect(editor.page.locator('#notificationEditor')).toBeHidden();
  await expect(editor.page.locator('#settingsHome')).toBeHidden();
  await expect(editor.field('UserPicker').locator(`option[value="${id(1)}"]`)).toHaveCount(0);
  await expect(editor.field('GroupPicker').locator('option[value="department.gscTet.any"]')).toHaveCount(0);
  await expect(editor.field('OverviewGroup').locator('option[value="role.admin"]')).toHaveCount(0);
  await expect(editor.field('SelectedGroups')).toBeEmpty(); await expect(editor.field('SelectedUsers')).toBeEmpty();
  checked('Roleless and incorrectly assigned Developer accounts cannot read/write preferences; access loss clears the editor, cached options and recipient drafts');
}

async function main() {
  const fixture = fixtures(), server = http.createServer(), contexts = [];
  let browser, page;
  await fs.mkdir(path.dirname(artifact('report.json')), { recursive: true });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository: fixture.repository, authService: fixture.authService,
      rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    const admin = await openContext(browser, origin, 'admin', contexts);
    page = await admin.newPage(); const editor = new PreferencesPage(page, origin);
    await loadingAndDefaults(editor); await currentDefaultsJourney(editor, fixture); await manualRoutingJourney(editor, fixture); await audienceAndPersistence(editor, fixture);
    await rejectFreeEmail(admin, origin, fixture); await groupFirstJourney(editor, fixture); await overlappingGroupJourney(editor, fixture);
    const second = new PreferencesPage(await admin.newPage(), origin); await conflictAndDiscard(editor, second);
    await responsive(editor); await permissions(browser, origin, contexts, fixture, editor);
    for (const body of report.writes) assertPayload(body);
    assert.deepEqual(report.external, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.forbidden, []);
    assert.deepEqual((await fixture.repository.getNotificationSettings()).groups, fixture.initialRouting.groups);
    checked('Only isolated notification-preference settings changed; no PCN, workflow limit, mail, directory or external requests occurred');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.stack; process.exitCode = 1;
    await page?.screenshot({ path: artifact('failure.png'), fullPage: true }).catch(() => {});
  } finally {
    for (const { context, name } of contexts) {
      await context.tracing.stop({ path: artifact(`${name}-trace.zip`) }).catch(() => {}); await context.close();
    }
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.writeFile(artifact('report.json'), JSON.stringify(report, null, 2));
    const cases = report.checks.map(name => `<testcase classname="notification-preferences" name="${xml(name)}"/>`);
    if (report.failure) cases.push(`<testcase name="failure"><failure>${xml(report.failure)}</failure></testcase>`);
    await fs.writeFile(artifact('junit.xml'), `<testsuite tests="${cases.length}" failures="${Number(report.status !== 'passed')}">${cases.join('')}</testsuite>`);
    await fs.writeFile(artifact('report.html'), `<!doctype html><meta charset="utf-8"><title>Notification preferences acceptance</title><h1>${report.status}</h1><ol>${report.checks.map(name => `<li>${xml(name)}</li>`).join('')}</ol>${report.failure ? `<pre>${xml(report.failure)}</pre>` : ''}`);
    console.log(JSON.stringify({ status: report.status, checks: report.checks, errors: report.errors, forbidden: report.forbidden, external: report.external }));
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { fixtures, assertPayload };
