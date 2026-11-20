// Real loopback auth/API with isolated memory fixtures. No SQL, mail or external integrations.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, expect: browserExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, unsignedPayload, TEST_PASSWORD } = require('../test/helpers/apiHarness');
const { RULES } = require('../src/workflowSettings');
const expectedDefaults = { gscTet: null, prodEngTet: 3, prodEngTa: 3, prodEngSc: 3, qaTet: 3, gscTapbu: null, qaTapbu: null, qaFinal: null };
const expect = browserExpect.configure({ timeout: 12000 });
const report = { storage: 'isolated_memory_only', checks: [], writes: [], forbidden: [], external: [], errors: [] };
const artifact = name => path.resolve('test-results', `system-settings-${name}`);
const check = name => { report.checks.push(name); console.log(name); };
const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

class SettingsPage {
  constructor(page) { this.page = page; this.editor = page.locator('#settingsEditor'); }
  field(key, suffix) { return this.page.locator(`#${key}${suffix}`); }
  async ready() { await expect(this.editor).toBeVisible(); await expect(this.page.locator('#settingsStatus')).toHaveText('Settings loaded.'); }
  async openReviews() { await this.page.locator('#settingsReviewLimits').click(); await this.ready(); }
  async days(key, value) { await this.field(key, 'Enabled').check(); await this.field(key, 'Days').fill(String(value)); }
  async save() {
    const response = this.page.waitForResponse(item => new URL(item.url()).pathname === '/api/admin/workflow-settings' && item.request().method() === 'PUT');
    await this.page.locator('#settingsSave').click();
    assert.equal((await response).status(), 200);
    await expect(this.page.locator('#settingsStatus')).toContainText('Settings saved.');
  }
  async reload(discard) {
    if (discard !== undefined) this.page.once('dialog', dialog => discard ? dialog.accept() : dialog.dismiss());
    await this.page.locator('#settingsReload').click();
    if (discard !== false) await expect(this.page.locator('#settingsStatus')).toHaveText('Settings loaded.');
  }
}

async function chooserJourney(settings) {
  const page = settings.page;
  await expect(page.locator('#settingsHome')).toBeVisible();
  await expect(settings.editor).toBeHidden();
  await expect(page.locator('#settingsBack')).toBeHidden();
  await expect(page.locator('#settingsNotifications')).toBeVisible();
  await expect(page.getByRole('link', { name: /Mail routing/ })).toHaveAttribute('href', '/admin#mail-routing');
  await expect(page.getByRole('link', { name: /User access/ })).toHaveAttribute('href', '/admin#users');
  await assertHeader(page);
  await page.screenshot({ path: artifact('home-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await assertHeader(page, true);
  await page.screenshot({ path: artifact('home-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#settingsReviewLimits').focus();
  await page.keyboard.press('Enter'); await settings.ready();
  await expect(page.locator('#pendingDaysTitle')).toBeFocused();
  await settings.days('qaTet', 9);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#settingsBack').click();
  await expect(settings.field('qaTet', 'Days')).toHaveValue('9');
  await expect(settings.editor).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#settingsBack').click();
  await expect(page.locator('#settingsHome')).toBeVisible();
  await expect(page.locator('#settingsReviewLimits')).toBeFocused();
  await settings.openReviews();
  await expect(settings.field('qaTet', 'Days')).toHaveValue('3');
  check('Settings starts with four feature choices on desktop/mobile; keyboard selection, focus return and unsaved-change protection work');
}

async function portalTheme(page) {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const style = selector => getComputedStyle(document.querySelector(selector));
    return { font: style('body').fontFamily, background: style('body').backgroundColor,
      header: style('.topbar').backgroundColor, headerHeight: document.querySelector('.topbar').getBoundingClientRect().height,
      logoWidth: document.querySelector('.admin-header-logo').getBoundingClientRect().width,
      panelBorder: style('.admin-panel').borderTopColor,
      gold: style('body').getPropertyValue('--mes-gold').trim() };
  });
}

async function assertPortalTheme(settings, reference) {
  const page = settings.page;
  assert.deepEqual(await portalTheme(page), reference, 'Settings inherits the same base theme, header, logo and panel border as PCN Records');
  for (const selector of ['.settings-feature', '#settingsEditor', '#qaTetDays', '#settingsSave']) {
    const finish = await page.locator(selector).first().evaluate(node => ({ radius: getComputedStyle(node).borderRadius, shadow: getComputedStyle(node).boxShadow }));
    assert.deepEqual(finish, { radius: '0px', shadow: 'none' }, `${selector} uses the Records square, flat component finish`);
  }
  await settings.days('qaTet', 4);
  const action = await page.locator('#settingsSave').evaluate(node => getComputedStyle(node).backgroundColor);
  const gold = await page.evaluate(() => {
    const probe = document.createElement('span'); probe.style.color = 'var(--mes-gold)'; document.body.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  });
  assert.equal(action, gold, 'Save uses the shared yellow action color');
  await settings.reload(true);
  check('System Settings matches PCN Records typography, white background, header dimensions, logo, panel borders and flat square controls');
}

async function fixtures() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...require('../src/masterData'), versionId: 1 });
  const startedAt = '2026-10-20T09:00:00.000Z';
  const now = new Date('2026-10-25T09:00:00.000Z');
  const service = new PcnService(repository, () => now);
  const complete = { prepared: true, checked: true, approved: true };
  const record = await repository.create({ ...service.normalizeInput({ ...unsignedPayload, status: 'gsc_review',
    materialName: 'Ongoing QA settings acceptance fixture', internalReview: { docs: { hazardousReport: true },
      tapbu: { noNeed: true }, signoff: { gscTet: complete, prodEngTet: complete } } }),
    createdAt: startedAt, updatedAt: startedAt, submittedAt: startedAt, reviewTiming: { qaTet: { startedAt } } }, 'Settings fixture');
  repository.getStatusTimings = async ids => new Map(await Promise.all(ids.map(async id => {
    const row = await repository.findById(id);
    const history = (await repository.getRevisions(id)).toSorted((a, b) => a.revision - b.revision);
    const transition = history.findLast((event, index) => event.status === row.status && !event.isBaseline
      && (index === 0 || history[index - 1].status !== event.status));
    return [id, { parentVersion: row.version, status: row.status, since: transition?.createdAt }];
  })));
  const authService = fakeAuthService({ additionalUsers: [
    { username: 'viewer', employeeCode: '0800001', identityProvider: 'employee-code', roles: [], displayName: 'Settings Records Viewer' },
    { username: 'gsc-user', roles: ['gsc'], department: 'gscTet', signingStep: 'prepared', displayName: 'Settings GSC User' }
  ] });
  return { repository, service, authService, record, now };
}

async function createContext(browser, origin, username) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
    if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
    if (url.pathname === '/api/admin/notifications/health') return route.fulfill({ json: { success: true,
      data: { configuration: { status: 'not_configured' }, worker: { status: 'disabled' }, queue: {} } } });
    if (!['GET', 'HEAD'].includes(request.method())) {
      if (url.pathname === '/api/admin/workflow-settings' && request.method() === 'PUT') report.writes.push({ method: request.method(), path: url.pathname });
      else { report.forbidden.push({ method: request.method(), path: url.pathname }); return route.abort(); }
    }
    if (/\/notifications(?:\/|$)/.test(url.pathname) || ['/api/admin/directory-users', '/api/admin/employees'].includes(url.pathname)) {
      report.forbidden.push({ method: request.method(), path: url.pathname }); return route.abort();
    }
    return route.continue();
  });
  // APIRequestContext is deliberately outside browser routing; only synthetic authentication writes occur here.
  const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: TEST_PASSWORD } });
  assert.equal(login.status(), 200);
  context.on('page', page => { page.setDefaultTimeout(12000); page.on('pageerror', error => report.errors.push(error.message)); });
  return context;
}

async function assertDeadline(dashboards, text, overdue) {
  for (const dashboard of dashboards) {
    await expect(dashboard.locator('[data-column="pending"]')).toHaveText(text);
    if (overdue) await expect(dashboard).toHaveClass(/rd-row-overdue/);
    else await expect(dashboard).not.toHaveClass(/rd-row-overdue/);
  }
}

function contrast(first, second) {
  const luminance = color => {
    const [red, green, blue] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    return .2126 * red + .7152 * green + .0722 * blue;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

async function assertHeader(page, mobile = false) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const header = page.locator('.settings-topbar'), logo = header.locator('img');
  const portal = header.getByRole('link', { name: 'Portal', exact: true });
  await expect(logo).toBeVisible(); await expect(portal).toBeVisible();
  assert.equal(await logo.evaluate(node => node.complete && node.naturalWidth > 0), true, 'Brand image loads');
  const geometry = await header.evaluate(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom,
    height: node.getBoundingClientRect().height, background: getComputedStyle(node).backgroundColor }));
  const heading = await page.getByRole('heading', { name: 'System Settings', exact: true }).boundingBox();
  assert.equal(geometry.top, 0, 'Header starts at the top of the page');
  assert.ok(heading.y >= geometry.bottom, 'Page heading clears the header');
  assert.ok(contrast(await portal.evaluate(node => getComputedStyle(node).color), geometry.background) >= 4.5, 'Portal text has readable header contrast');
  assert.ok(contrast(await header.locator('.admin-header-brand h1').evaluate(node => getComputedStyle(node).color), geometry.background) >= 4.5, 'Brand text has readable header contrast');
  if (mobile) assert.ok(geometry.height <= 150, 'Mobile header stays compact');
}

async function editorJourney(settings, other) {
  assert.deepEqual(Object.fromEntries(RULES.map(({ key, defaultDays }) => [key, defaultDays])), expectedDefaults);
  await expect(settings.page.locator('.settings-row')).toHaveCount(8);
  for (const [key, defaultDays] of Object.entries(expectedDefaults)) {
    await expect(settings.field(key, 'Enabled')).toBeChecked({ checked: defaultDays !== null });
    if (defaultDays === null) await expect(settings.field(key, 'Days')).toBeDisabled();
    else await expect(settings.field(key, 'Days')).toHaveValue(String(defaultDays));
  }
  await expect(settings.page.locator('#settingsSaved')).toContainText('Default settings');
  const gscRow = settings.page.locator('.settings-row').filter({ has: settings.field('gscTet', 'Enabled') });
  await expect(gscRow.locator('.settings-limit-off')).toBeVisible();
  await expect(gscRow.locator('.settings-limit-on')).toBeHidden();
  await settings.field('gscTet', 'Enabled').check();
  await expect(gscRow.locator('.settings-limit-on')).toBeVisible();
  await expect(gscRow.locator('.settings-limit-off')).toBeHidden();
  await expect(settings.field('gscTet', 'Days')).toBeEnabled();
  await settings.field('gscTet', 'Enabled').uncheck();
  await expect(gscRow.locator('.settings-limit-off')).toBeVisible();
  await expect(settings.field('gscTet', 'Days')).toBeDisabled();
  await settings.page.screenshot({ path: artifact('review-defaults-desktop.png'), fullPage: true });
  await settings.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await settings.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await settings.page.screenshot({ path: artifact('review-defaults-mobile.png'), fullPage: true });
  await settings.page.setViewportSize({ width: 1440, height: 1000 });
  check('Review limits clearly switch between Enabled and No deadline without saving; grouped form renders on desktop/mobile');
  check('Administrator Portal navigation opens eight correct default department controls including TA and SC');
  for (const value of ['0', '1.5', '366']) {
    const writes = report.writes.length;
    await settings.days('qaTet', value); await settings.page.locator('#settingsSave').click();
    await expect(settings.field('qaTet', 'Days')).toHaveAttribute('aria-invalid', 'true');
    await expect(settings.page.locator('#settingsStatus')).toContainText('Check the highlighted');
    assert.equal(report.writes.length, writes, 'Invalid values produce no browser write');
  }
  await settings.days('qaTet', 7); await settings.reload(false);
  await expect(settings.field('qaTet', 'Days')).toHaveValue('7');
  await settings.reload(true); await expect(settings.field('qaTet', 'Days')).toHaveValue('3');
  check('Zero, fractional and out-of-range days fail locally; Reload supports dismiss and discard');
  await settings.days('gscTet', 1); await settings.days('qaFinal', 365); await settings.save();
  await expect(settings.page.locator('#settingsSaved')).toContainText(/Last saved by/);
  await settings.reload(); await expect(settings.field('gscTet', 'Days')).toHaveValue('1');
  await expect(settings.field('qaFinal', 'Days')).toHaveValue('365');
  await settings.field('gscTet', 'Enabled').uncheck(); await settings.field('qaFinal', 'Enabled').uncheck();
  await settings.save(); await settings.reload();
  await expect(settings.field('gscTet', 'Enabled')).not.toBeChecked(); await expect(settings.field('gscTet', 'Days')).toBeDisabled();
  check('Bounds 1 and 365 persist with saved metadata; disabling persists after Reload');
  await settings.days('prodEngTa', 5); await settings.days('prodEngSc', 7); await settings.save(); await settings.reload();
  await expect(settings.field('prodEngTa', 'Days')).toHaveValue('5');
  await expect(settings.field('prodEngSc', 'Days')).toHaveValue('7');
  await expect(settings.field('prodEngTet', 'Days')).toHaveValue('3');
  check('TA and SC engineering limits save independently while legacy engineering retains its own allowance');
  await other.reload();
  await settings.days('prodEngTet', 4); await settings.save();
  await other.days('qaTet', 8);
  const conflict = other.page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/workflow-settings' && response.request().method() === 'PUT');
  await other.page.locator('#settingsSave').click(); assert.equal((await conflict).status(), 409);
  await expect(other.page.locator('#settingsStatus')).toContainText('Your edits are preserved');
  await expect(other.field('qaTet', 'Days')).toHaveValue('8');
  await other.reload(true); await expect(other.field('prodEngTet', 'Days')).toHaveValue('4');
  await expect(other.field('qaTet', 'Days')).toHaveValue('3');
  check('Two loaded administrators conflict safely; edits remain until explicit Reload');
}

async function deniedJourney(browser, origin, contexts) {
  for (const username of ['viewer', 'gsc-user']) {
    const context = await createContext(browser, origin, username); contexts.push({ context, name: username });
    const page = await context.newPage();
    await page.goto(`${origin}/admin`);
    await expect(page.locator('#adminSystemSettingsLink')).toBeHidden();
    await page.goto(`${origin}/system-settings`);
    await expect(page.locator('#settingsStatus')).toContainText('Administrator access required');
    await expect(page.locator('#settingsEditor')).toBeHidden();
    await expect(page.locator('#settingsHome')).toBeHidden();
    assert.equal((await context.request.get(`${origin}/api/admin/workflow-settings`)).status(), 403);
    const session = (await (await context.request.get(`${origin}/api/session`)).json()).data;
    const deniedSave = await context.request.put(`${origin}/api/admin/workflow-settings`, {
      headers: { origin, 'x-csrf-token': session.csrfToken }, data: { schemaVersion: 1, version: 0, pendingDays: expectedDefaults }
    });
    assert.equal(deniedSave.status(), 403);
  }
  check('Roleless viewer and GSC user have no Settings navigation and cannot use the page or GET/PUT API');
}

async function revokeJourney(settings, origin) {
  await settings.page.route(`${origin}/api/admin/workflow-settings`, route => route.fulfill({ status: 403, json: { success: false, error: 'Administrator access required' } }));
  await settings.page.locator('#settingsReload').click();
  await expect(settings.editor).toBeHidden(); await expect(settings.page.locator('#settingsSaved')).toBeEmpty();
  for (const { key } of RULES) await expect(settings.field(key, 'Days')).toHaveValue('');
  await settings.page.unroute(`${origin}/api/admin/workflow-settings`);
  await settings.page.reload(); await settings.openReviews();
  await settings.days('qaTet', 9);
  await settings.page.route(`${origin}/api/session`, route => route.fulfill({ status: 403, json: { success: false, error: 'Administrator access required' } }));
  await settings.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(settings.editor).toBeHidden(); await expect(settings.page.locator('#settingsSaved')).toBeEmpty();
  for (const { key } of RULES) await expect(settings.field(key, 'Days')).toHaveValue('');
  check('Settings and session 403 responses revoke access and clear cached controls, metadata and unsaved edits');
}

async function writeArtifacts() {
  const failed = report.status !== 'passed';
  await fs.writeFile(artifact('acceptance.json'), JSON.stringify(report, null, 2));
  const cases = report.checks.map(name => `<testcase classname="system-settings" name="${xml(name)}"/>`);
  if (failed) cases.push(`<testcase classname="system-settings" name="acceptance failure"><failure>${xml(report.failure)}</failure></testcase>`);
  await fs.writeFile(artifact('junit.xml'), `<testsuite name="system-settings" tests="${cases.length}" failures="${Number(failed)}">${cases.join('')}</testsuite>`);
  await fs.writeFile(artifact('report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>System Settings acceptance</title><h1>${failed ? 'FAILED' : 'PASSED'}</h1><p>Isolated memory fixtures, loopback API and synthetic authentication.</p><ol>${report.checks.map(name => `<li>${xml(name)}</li>`).join('')}</ol>${failed ? `<pre>${xml(report.failure)}</pre>` : ''}</html>`);
}

async function main() {
  const fixture = await fixtures(), server = http.createServer(), contexts = [];
  let browser, page;
  await fs.mkdir(path.dirname(artifact('acceptance.json')), { recursive: true });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ ...fixture, clock: () => fixture.now, publicOrigin: origin, secureCookies: false, rootDir: path.resolve(__dirname, '..') }));
    const before = await fixture.repository.list(), revisions = await fixture.repository.getRevisions(fixture.record.id);
    browser = await chromium.launch({ headless: true });
    const admin = await createContext(browser, origin, 'admin'); contexts.push({ context: admin, name: 'editor' });
    page = await admin.newPage(); await page.goto(`${origin}/admin`);
    const referenceTheme = await portalTheme(page);
    await expect(page.locator('#adminSystemSettingsLink')).toBeVisible(); await page.locator('#adminSystemSettingsLink').click();
    await expect(page).toHaveURL(`${origin}/system-settings`);
    const settings = new SettingsPage(page); await chooserJourney(settings);
    await assertPortalTheme(settings, referenceTheme);
    const second = new SettingsPage(await admin.newPage()); await second.page.goto(`${origin}/system-settings`); await second.openReviews();
    await editorJourney(settings, second);
    const portalContext = await createContext(browser, origin, 'admin'); contexts.push({ context: portalContext, name: 'portal' });
    const recordsContext = await createContext(browser, origin, 'viewer'); contexts.push({ context: recordsContext, name: 'records' });
    const portal = await portalContext.newPage(), records = await recordsContext.newPage();
    await portal.goto(`${origin}/admin`); await portal.locator('#adminRecordsButton').click();
    await records.goto(`${origin}/records`);
    const dashboards = [portal.locator(`#pcnAdminView tr[data-pcn-id="${fixture.record.id}"]`), records.locator(`#recordsWorkspace tr[data-pcn-id="${fixture.record.id}"]`)];
    await assertDeadline(dashboards, 'Overdue 2 days', true);
    await settings.days('qaTet', 7); await settings.save();
    await assertDeadline(dashboards, '5 days', false);
    await portal.screenshot({ path: artifact('portal-limit-7.png'), fullPage: true });
    await records.screenshot({ path: artifact('records-limit-7.png'), fullPage: true });
    await settings.days('qaTet', 2); await settings.save();
    await assertDeadline(dashboards, 'Overdue 3 days', true);
    await portal.screenshot({ path: artifact('portal-limit-2.png'), fullPage: true });
    await records.screenshot({ path: artifact('records-limit-2.png'), fullPage: true });
    check('Ongoing QA starts at original October 20 handoff: both visible dashboards poll from Overdue 2 days to 5 days at limit 7, then Overdue 3 days at limit 2');
    await settings.field('qaTet', 'Enabled').uncheck(); await settings.save();
    await assertDeadline(dashboards, '5 days', false);
    await settings.days('qaTet', 2); await settings.save(); await assertDeadline(dashboards, 'Overdue 3 days', true);
    check('Disabling removes overdue styling; reenabling uses the unchanged original handoff on normal polling');
    await assertHeader(page);
    await page.screenshot({ path: artifact('desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Settings page stays inside 390px viewport');
    const panelBounds = await page.locator('#settingsEditor').boundingBox();
    const workspaceBounds = await page.locator('.settings-workspace').boundingBox();
    assert.ok(panelBounds.x >= workspaceBounds.x && panelBounds.x + panelBounds.width <= workspaceBounds.x + workspaceBounds.width - 12,
      'Mobile review panel and its controls retain space inside the workspace without clipping');
    await expect(page.locator('.settings-row')).toHaveCount(8);
    for (const key of Object.keys(expectedDefaults)) {
      await expect(settings.field(key, 'Enabled')).toBeVisible();
      await expect(settings.field(key, 'Days')).toBeVisible();
      assert.equal(await settings.field(key, 'Days').evaluate(node => {
        const bounds = node.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth;
      }), true, `${key} day control stays within the mobile viewport`);
    }
    await expect(page.locator('#settingsSave')).toBeVisible(); await expect(page.locator('#settingsReload')).toBeVisible();
    await assertHeader(page, true);
    await page.screenshot({ path: artifact('mobile.png'), fullPage: true });
    check('Desktop and 390px mobile settings remain contained with all eight controls and actions');
    await deniedJourney(browser, origin, contexts); await revokeJourney(settings, origin);
    assert.deepEqual(await fixture.repository.list(), before, 'Settings editing and polling never modify PCN records');
    assert.deepEqual(await fixture.repository.getRevisions(fixture.record.id), revisions, 'Settings editing creates no PCN revisions');
    assert.deepEqual(report.forbidden, []); assert.deepEqual(report.external, []); assert.deepEqual(report.errors, []);
    check('Only workflow-settings PUT writes occurred; no PCN mutation, revisions, mail, external requests or browser errors');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.stack; process.exitCode = 1;
    if (page) await page.screenshot({ path: artifact('failure.png'), fullPage: true }).catch(() => {});
  } finally {
    for (const { context, name } of contexts) { await context.tracing.stop({ path: artifact(`${name}-trace.zip`) }); await context.close(); }
    if (browser) await browser.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await writeArtifacts(); console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
