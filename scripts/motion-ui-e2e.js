// Loopback-only fixtures: this suite never loads SQL or a notification worker.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: baseExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const { mailGroups } = require('../src/mailRouting');
const masterData = require('../src/masterData');
const expect = baseExpect.configure({ timeout: 10000 });
const report = { storage: 'isolated_memory_only', checks: [], errors: [], external: [], forbidden: [] };

// Sample the browser's rendered frames, rather than trusting CSS declarations.
async function frames(surface, action) {
  return surface.evaluate(async (node, command) => {
    const samples = [];
    const act = () => command.kind === 'escape'
      ? document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      : (() => { const control = document.querySelector(command.selector); control.focus(); control.click(); })();
    const capture = () => {
      const style = getComputedStyle(node);
      samples.push({ opacity: Number(style.opacity), displayed: style.display !== 'none', time: performance.now(), text: node.textContent, logicalClosed: node.tagName === 'DIALOG' ? !node.open : node.hidden, noninteractive: node.tagName === 'DIALOG' ? !node.open : node.inert });
    };
    act(); capture();
    const until = performance.now() + 330;
    while (performance.now() < until) { await new Promise(requestAnimationFrame); capture(); }
    return samples;
  }, action);
}
async function fade(surface, action, opening, label, preservedText) {
  const samples = await frames(surface, action);
  report.motion ||= []; report.motion.push({ label, opening, frames: samples.map(({time, opacity, displayed}) => ({time, opacity, displayed})) });
  assert(samples.some(frame => frame.displayed && frame.opacity > 0.02 && frame.opacity < 0.98), `${label} has a rendered intermediate opacity on ${opening ? 'entry' : 'exit'}`);
  if (preservedText) assert(samples.some(frame => frame.displayed && frame.opacity > 0.02 && frame.opacity < 0.98 && frame.text.includes(preservedText)), `${label} retains its visible content during exit`);
  if (!opening) assert(samples[0].logicalClosed && samples[0].noninteractive, `${label} closes logically and becomes noninteractive before its exit finishes`);
  const final = samples.at(-1);
  if (opening) { assert(final.displayed && final.opacity > 0.98, `${label} finishes visible`); await expect(surface).toBeVisible(); }
  else { assert(!final.displayed, `${label} finishes removed from layout`); await expect(surface).toBeHidden(); }
}
async function fit(page, surface, label) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: no document horizontal overflow`);
  if (surface) assert(await surface.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1 && node.scrollWidth <= node.clientWidth + 1; }), `${label}: popup fits viewport without horizontal overflow`);
}
async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const service = new PcnService(repository);
  const admin = { id: 'admin-id', displayName: 'Motion Fixture Administrator', roles: ['admin'] };
  await service.create({ ...unsignedPayload, status: 'draft', supplierName: 'Responsive motion supplier', materialName: 'Fixture material' }, admin.displayName, admin);
  const before = await repository.list();
  const settings = { schemaVersion: 2, version: 'motion-v1', directoryConfigured: true, flowConfigured: false, legacyGroups: [], groups: mailGroups.map(group => ({ ...group, emails: '', recipients: [], automaticRecipients: [] })) };
  const server = http.createServer(); let browser, context;
  try {
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, service, authService: fakeAuthService(), rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username: 'admin', password: TEST_PASSWORD } });
    assert.equal(login.status(), 200);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const send = data => route.fulfill({ json: { success: true, data } });
      if (!['GET', 'HEAD'].includes(request.method())) { report.forbidden.push({ method: request.method(), path: url.pathname }); return route.abort(); }
      if (url.pathname === '/api/profile') return send({ status: 'unavailable' });
      if (url.pathname === '/api/auth/config') return send({ mode: 'password', employeeProvisioningConfigured: true });
      if (url.pathname === '/api/admin/users') return send([]);
      if (url.pathname === '/api/notification-settings') return send(settings);
      if (url.pathname === '/api/admin/notifications/health') return send({ configuration: { status: 'not_configured' }, worker: {}, queue: {} });
      if (url.pathname === '/api/admin/employees') return send(Array.from({ length: 30 }, (_, index) => ({ employeeCode: String(7000000 + index), displayName: `Motion employee ${index}`, englishName: `Motion employee ${index}`, jobTitle: 'Fixture engineer', sourceDepartment: 'Fixture' })));
      if (url.pathname === '/api/admin/directory-users') return send({ users: Array.from({ length: 25 }, (_, index) => ({ displayName: `Motion contact ${index}`, email: `motion${index}@example.test`, jobTitle: 'Fixture engineer', department: 'Fixture', photo: '' })) });
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`${origin}/admin`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.account-trigger')).toBeVisible();
    const menu = page.locator('#createStartOptions');
    await fade(menu, { selector: '#createStartToggle' }, true, 'Create dropdown');
    await fade(menu, { kind: 'escape' }, false, 'Create dropdown');
    await expect(page.locator('#createStartToggle')).toBeFocused();
    const account = page.locator('#accountProfilePanel');
    await fade(account, { selector: '.account-trigger' }, true, 'Account dropdown');
    await fade(account, { kind: 'escape' }, false, 'Account dropdown');
    await expect(page.locator('.account-trigger')).toBeFocused();
    report.checks.push('Create and account dropdowns render entry and exit opacity frames, settle hidden, and restore keyboard focus');

    await page.locator('#adminMailRoutingButton').click();
    const assign = '.notification-department[data-department="gscTet"] .notification-department-add';
    await expect(page.locator(assign)).toBeVisible();
    const recipient = page.locator('#notificationRecipientDialog');
    await fade(recipient, { selector: assign }, true, 'Mail assignment popup');
    await expect(page.locator('#notificationRecipientRole')).toBeFocused();
    await page.locator('#notificationRecipientRole').selectOption('checked');
    await page.locator('#notificationRecipientEmail').fill('Motion');
    await expect(recipient.locator('.directory-suggestion')).toHaveCount(6);
    await fade(recipient, { selector: '#notificationRecipientCancelButton' }, false, 'Mail assignment popup', 'Motion contact');
    await expect(page.locator(assign)).toBeFocused();
    await page.locator('#adminUsersButton').click();
    await expect(page.locator('#usersAddRoleButton')).toBeVisible();
    const employee = page.locator('#employeeUserDialog');
    await fade(employee, { selector: '#usersAddRoleButton' }, true, 'Employee access popup');
    await page.keyboard.press('Tab'); await expect(employee).toBeVisible();
    await page.locator('#employeeSearch').fill('Motion');
    await expect(page.locator('#employeeResults .employee-result')).toHaveCount(30);
    await fade(employee, { selector: '#employeeCancelButton' }, false, 'Employee access popup', 'Motion employee');
    await expect(page.locator('#usersAddRoleButton')).toBeFocused();
    report.checks.push('Mail assignment and employee access popups render entry and exit fades, keep keyboard controls usable and return focus');

    await page.locator('#adminRecordsButton').click();
    const historyButton = page.getByRole('button', { name: 'History ' + before[0].id, exact: true });
    await expect(historyButton).toBeVisible();
    const historySelector = '[aria-label="History ' + before[0].id + '"]';
    const timeline = page.locator('#pcnTimelineDialog');
    await fade(timeline, { selector: historySelector }, true, 'Department timeline');
    await expect(page.locator('#pcnTimelineTrack')).toContainText('GSC/TET');
    await fade(timeline, { selector: '#pcnTimelineCloseButton' }, false, 'Department timeline', 'GSC/TET');
    await expect(historyButton).toBeFocused();
    const quickSelector = '[aria-label="Quick view ' + before[0].id + '"]';
    await page.locator(quickSelector).click();
    const quick = page.locator('#rdPreviewDialog');
    await expect(quick).toContainText('Responsive motion supplier');
    await fade(quick, { selector: '#rdPreviewDialog [aria-label="Close preview"]' }, false, 'PCN quick view', 'Responsive motion supplier');
    await expect(page.locator(quickSelector)).toBeFocused();
    await page.locator(historySelector).click(); await expect(timeline).toBeVisible();
    await page.keyboard.press('Escape'); await expect(timeline).toBeHidden(); await expect(historyButton).toBeFocused();
    report.checks.push('Timeline and quick view retain document content throughout fade-out and return focus');

    // Reopening during an exit must not let an older completion hide the new popup.
    await page.evaluate(() => { const trigger = document.querySelector('.account-trigger'); trigger.focus(); trigger.click(); trigger.click(); trigger.click(); });
    await expect(account).toBeVisible(); await page.waitForTimeout(350); await expect(account).toBeVisible();
    await expect(page.locator('.account-trigger')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape'); await expect(account).toBeHidden();
    await page.evaluate(() => { const trigger = document.querySelector('#createStartToggle'); trigger.focus(); trigger.click(); trigger.click(); trigger.click(); });
    await page.waitForTimeout(350); await expect(menu).toBeVisible();
    await page.keyboard.press('Escape'); await expect(menu).toBeHidden();
    report.checks.push('Rapid close/reopen cannot leave dropdowns hidden or aria-expanded stale');

    for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); const label = `${viewport.width}x${viewport.height}`;
      await page.locator('#adminUsersButton').click(); await page.locator('#usersAddRoleButton').click(); await expect(employee).toBeVisible();
      await fit(page, employee, `${label} employee`);
      await page.locator('#employeeSearch').fill('Motion');
      await expect(page.locator('#employeeResults')).toBeVisible();
      await fit(page, employee, `${label} employee results`);
      assert(await page.locator('#employeeResults').evaluate(node => node.scrollHeight > node.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)), `${label}: employee results scroll inside their own bounded area`);
      assert(await page.locator('#employeeCancelButton').evaluate(node => { const box = node.getBoundingClientRect(); return box.bottom <= innerHeight && box.top >= 0; }), `${label}: employee footer stays accessible`);
      await page.locator('#employeeCancelButton').click(); await expect(employee).toBeHidden();
      await page.locator('#adminMailRoutingButton').click(); await page.locator(assign).click(); await expect(recipient).toBeVisible();
      await page.locator('#notificationRecipientRole').selectOption('checked'); await page.locator('#notificationRecipientEmail').fill('Motion');
      await expect(recipient.locator('.directory-suggestion')).toHaveCount(6);
      await fit(page, recipient, `${label} mail results`);
      assert(await page.locator('#notificationRecipientCancelButton').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), `${label}: mail footer stays accessible`);
      await page.locator('#notificationRecipientCancelButton').click(); await expect(recipient).toBeHidden();
      await page.locator('#adminRecordsButton').click(); await fit(page, null, `${label} Records`);
      await page.locator('#createStartToggle').click(); await expect(menu).toBeVisible(); await fit(page, menu, `${label} Create dropdown`);
      await page.keyboard.press('Escape'); await expect(menu).toBeHidden();
      await page.screenshot({ path: path.resolve(`test-results/motion-ui-${viewport.width}.png`) });
    }
    report.checks.push('1366, 1280, 1024 and 390px layouts fit; search results scroll internally and popup actions remain visible');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const [surface, trigger, close] of [[menu, '#createStartToggle', { kind: 'escape' }], [account, '.account-trigger', { kind: 'escape' }]]) {
      const opening = await frames(surface, { selector: trigger });
      assert(opening.every(frame => !frame.displayed || frame.opacity === 1), 'Reduced motion has no partial opacity entry frames');
      const closing = await frames(surface, close);
      assert(!closing[0].displayed, 'Reduced motion hides dropdown immediately');
    }
    await page.locator('#adminMailRoutingButton').click();
    const opening = await frames(recipient, { selector: assign });
    assert(opening.every(frame => !frame.displayed || frame.opacity === 1), 'Reduced motion skips popup entry fade');
    const closing = await frames(recipient, { selector: '#notificationRecipientCancelButton' });
    assert(!closing[0].displayed, 'Reduced motion closes popup immediately');
    report.checks.push('Reduced motion skips fades and removes closed surfaces immediately');
    await page.goto(origin + '/create', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#startBlank')).toBeVisible();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await fit(page, null, viewport.width + 'px Create entry');
      assert(await page.locator('.create-entry-card').evaluateAll(cards => cards.every(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })), 'Create start choices fit without clipped actions');
    }
    await page.locator('#startBlank').click(); await expect(page.locator('#createEditor')).toBeVisible();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await fit(page, null, viewport.width + 'px Create editor');
      assert(await page.locator('.create-actionbar').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && box.top >= 0; }), 'Create fixed actionbar fits laptop and mobile viewport');
    }
    report.checks.push('Create entry choices and blank editor fit laptop and mobile sizes with the fixed save/continue actions accessible');
    assert.deepEqual(await repository.list(), before, 'Motion and layout checks never mutate PCNs');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.message; throw error; }
  finally {
    await fs.writeFile(path.resolve('test-results/motion-ui-acceptance.json'), JSON.stringify(report, null, 2));
    if (context) { await context.tracing.stop({ path: path.resolve('test-results/motion-ui-trace.zip') }); await context.close(); }
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    console.log(JSON.stringify({ storage: report.storage, status: report.status, checks: report.checks, errors: report.errors, external: report.external, forbidden: report.forbidden, ...(report.failure ? { failure: report.failure } : {}) }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

