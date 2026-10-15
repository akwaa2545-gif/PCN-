// Isolated browser authentication fixtures; never connects to SQL or Power Automate.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');

async function main() {
  const baseline = process.env.LOGIN_E2E_BASELINE === '1'
    ? execFileSync('git', ['show', 'HEAD:login.js'], { encoding: 'utf8' }) : null;
  const server = http.createServer();
  const contexts = [], errors = [], external = [], checks = [];
  let browser;
  let releaseHeld = () => {};
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const repository = memoryRepository();
    repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
    const passwordAuth = fakeAuthService({ additionalUsers: [
      { username: '0700001', employeeCode: '0700001', displayName: 'Portal Fixture Administrator',
        identityProvider: 'employee-code', roles: ['admin'], department: 'it' },
      { username: '0700002', employeeCode: '0700002', displayName: 'Portal Fixture Reviewer',
        identityProvider: 'employee-code', roles: ['reviewer'], department: 'gscTet' },
      ...['supplier', 'gsc', 'productionengineering', 'qa', 'tapbu'].map((role, index) => ({
        username: `070000${index + 3}`, employeeCode: `070000${index + 3}`,
        displayName: `Portal Fixture ${role}`, identityProvider: 'employee-code', roles: [role]
      })),
      { username: '0700008', employeeCode: '0700008', displayName: 'Pending Fixture', identityProvider: 'employee-code', roles: [] }
    ] });
    const authService = { ...passwordAuth, authMode: 'employee-code',
      login: body => passwordAuth.login({ username: body.employeeCode, password: TEST_PASSWORD }) };
    server.on('request', createRequestHandler({ repository, authService,
      rootDir: path.resolve(__dirname, '..'), secureCookies: false, publicOrigin: origin }));
    browser = await chromium.launch({ headless: true });
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    const open = async (handleLogin, viewport = { width: 1440, height: 1000 }) => {
      const context = await browser.newContext({ viewport });
      contexts.push(context);
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      await context.tracing.start({ screenshots: true, snapshots: true });
      const requests = [];
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { external.push(url.href); return route.abort(); }
        if (baseline && url.pathname === '/login.js') return route.fulfill({ contentType: 'application/javascript', body: baseline });
        if (url.pathname === '/api/auth/config') return route.fulfill({ json: { success: true, data: { mode: 'employee-code' } } });
        if (url.pathname === '/api/session') return route.fulfill({ json: { success: true, data: { authenticated: false, csrfToken: 'fixture-csrf' } } });
        if (url.pathname === '/api/auth/login') {
          assert.equal(route.request().method(), 'POST');
          const body = route.request().postDataJSON();
          requests.push(body);
          assert.deepEqual(Object.keys(body), ['employeeCode']);
          return handleLogin(route, requests.length);
        }
        if (url.pathname === '/complete') return route.fulfill({ contentType: 'text/html', body: '<main>Isolated sign-in complete</main>' });
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(30000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/login?returnTo=%2Fcomplete`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#employeeLoginForm')).toBeVisible();
      return { page, context, requests };
    };
    const success = route => route.fulfill({ json: { success: true, data: { authenticated: true,
      user: { roles: ['reviewer'], identityProvider: 'employee-code' }, csrfToken: 'signed-in-csrf' } } });
    const pasteText = async (page, text) => {
      await page.evaluate(value => navigator.clipboard.writeText(value), text);
      await page.locator('#employeeCode').press('Control+V');
    };
    const fontCheck = async page => {
      assert.equal(await page.evaluate(async () => {
        await document.fonts.load('700 16px "Cairoli Classic"');
        return document.fonts.check('700 16px "Cairoli Classic"');
      }), true, 'The local Cairoli font loads');
      for (const selector of ['.auth-brand-headline', '.employee-entry-title', '.employee-entry-help', '.employee-pin-slot', '.auth-submit']) {
        assert.match(await page.locator(selector).first().evaluate(node => getComputedStyle(node).fontFamily), /^"Cairoli Classic"/, `${selector} uses Cairoli`);
      }
    };
    const typed = await open(success);
    await fontCheck(typed.page);
    await typed.page.locator('#employeeCode').pressSequentially('012345');
    assert.equal(typed.requests.length, 0, 'Incomplete employee code never signs in');
    await expect(typed.page.locator('#employeeDigit6')).toHaveText('5');
    await typed.page.screenshot({ path: path.resolve('test-results/login-font-desktop.png'), fullPage: true });
    const typedNavigation = typed.page.waitForURL(`${origin}/complete`);
    await typed.page.locator('#employeeCode').pressSequentially('6');
    await typedNavigation;
    assert.deepEqual(typed.requests, [{ employeeCode: '0123456' }], 'Final digit automatically submits once and preserves leading zeros');
    checks.push('desktop-Cairoli-loaded-incomplete-no-submit-final-digit-sign-in');

    const pasted = await open(success, { width: 390, height: 844 });
    await fontCheck(pasted.page);
    assert.equal(await pasted.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await pasted.page.screenshot({ path: path.resolve('test-results/login-font-mobile.png'), fullPage: true });
    const pasteNavigation = pasted.page.waitForURL(`${origin}/complete`);
    await pasteText(pasted.page, '0765432');
    await pasteNavigation;
    assert.deepEqual(pasted.requests, [{ employeeCode: '0765432' }]);
    checks.push('mobile-Cairoli-loaded-paste-signs-in-without-button');

    const pasteGuard = await open(success);
    await pasteGuard.page.locator('#employeeCode').fill('12');
    await pasteGuard.page.locator('#employeeCode').press('End');
    await pasteText(pasteGuard.page, '0012345');
    assert.equal(pasteGuard.requests.length, 0, 'Full code appended to partial input cannot silently sign in as a truncated different ID');
    await expect(pasteGuard.page.locator('#employeeCode')).toHaveValue('12');
    await pasteGuard.page.locator('#employeeCode').fill('123456');
    await pasteGuard.page.locator('#employeeCode').press('End');
    await pasteText(pasteGuard.page, '78');
    assert.equal(pasteGuard.requests.length, 0, 'Partial paste overflowing seven slots is rejected before maxlength truncation');
    await expect(pasteGuard.page.locator('#employeeCode')).toHaveValue('123456');
    await pasteGuard.page.locator('#employeeCode').press('Control+A');
    await pasteText(pasteGuard.page, 'bad-code');
    assert.equal(pasteGuard.requests.length, 0, 'Malformed pasted text cannot sign in');
    await expect(pasteGuard.page.locator('#employeeCode')).toHaveValue('123456');
    await pasteGuard.page.locator('#employeeCode').press('Control+A');
    const replacementNavigation = pasteGuard.page.waitForURL(`${origin}/complete`);
    await pasteText(pasteGuard.page, '0012345');
    await replacementNavigation;
    assert.deepEqual(pasteGuard.requests, [{ employeeCode: '0012345' }], 'A selected-range replacement pastes the exact intended employee ID');
    checks.push('real-clipboard-paste-overflow-malformed-rejected-selected-replacement-valid');

    const held = new Promise(resolve => { releaseHeld = resolve; });
    const pending = await open(async route => { await held; return success(route); });
    await pending.page.locator('#employeeCode').fill('0111111');
    await expect.poll(() => pending.requests.length).toBe(1);
    await expect(pending.page.locator('#employeeCode')).toBeDisabled();
    await expect(pending.page.locator('#employeeLoginForm button[type=submit]')).toBeDisabled();
    await pending.page.locator('#employeeCode').evaluate(input => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await pending.page.keyboard.press('Enter');
    assert.equal(pending.requests.length, 1, 'Pending input/change/Enter/submit cannot create duplicate requests');
    const pendingNavigation = pending.page.waitForURL(`${origin}/complete`);
    releaseHeld();
    await pendingNavigation;
    assert.equal(pending.requests.length, 1);
    checks.push('pending-controls-disabled-duplicate-events-blocked');

    const retry = await open((route, attempt) => attempt === 1
      ? route.fulfill({ status: 401, json: { success: false, error: 'This employee is not enabled for PCN.' } }) : success(route));
    await retry.page.locator('#employeeCode').fill('0222222');
    await expect(retry.page.locator('#employeeAuthMessage')).toHaveText('This employee is not enabled for PCN.');
    await expect(retry.page.locator('#employeeCode')).toBeEnabled();
    await expect(retry.page.locator('#employeeLoginForm button[type=submit]')).toBeEnabled();
    assert.match(retry.page.url(), /\/login\?/);
    await retry.page.locator('#employeeCode').dispatchEvent('change');
    assert.equal(retry.requests.length, 1, 'Unchanged code after failure does not loop automatic retries');
    await expect(retry.page.locator('#employeeAuthMessage')).toHaveText('This employee is not enabled for PCN.');
    const retryNavigation = retry.page.waitForURL(`${origin}/complete`);
    await retry.page.locator('#employeeLoginForm button[type=submit]').click();
    await retryNavigation;
    assert.equal(retry.requests.length, 2, 'Manual retry remains available after failure');
    checks.push('failure-inline-error-controls-recover-no-loop-manual-retry');

    // Use genuine isolated session cookies and authorization for default Portal navigation.
    const openRealLogin = async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      await context.tracing.start({ screenshots: true, snapshots: true });
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(30000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#employeeLoginForm')).toBeVisible();
      return page;
    };
    const portal = await openRealLogin();
    await portal.locator('#employeeCode').fill('0700001');
    await portal.waitForURL(`${origin}/admin`);
    await expect(portal).toHaveTitle('PCN Portal');
    await expect(portal.locator('#adminNoticeTitle')).toHaveText('Portal ready');
    await expect(portal.locator('#pcnAdminView')).toBeVisible();
    await expect(portal.locator('#adminMessage')).toHaveText('No PCNs saved.');
    const portalSession = await portal.request.get(`${origin}/api/session`);
    assert.equal(portalSession.status(), 200);
    assert.deepEqual((await portalSession.json()).data.user.roles, ['admin']);
    await portal.screenshot({ path: path.resolve('test-results/login-portal-default.png'), fullPage: true });
    await portal.goto(`${origin}/records`, { waitUntil: 'domcontentloaded' });
    await portal.waitForURL(`${origin}/admin`);
    await expect(portal.locator('#pcnAdminView')).toBeVisible();
    await portal.goto(`${origin}/form.html`, { waitUntil: 'domcontentloaded' });
    await expect(portal.locator('#formAdminLink')).toBeVisible();
    await expect(portal.locator('#formAdminLink')).toHaveText('Portal');
    await expect(portal.locator('.topbar-actions a[href="/records"]')).toBeHidden();
    await portal.goto(`${origin}/login?returnTo=%2Frecords`, { waitUntil: 'domcontentloaded' });
    await portal.waitForURL(`${origin}/admin`);
    await portal.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
    await portal.waitForURL(`${origin}/admin`);
    await expect(portal.locator('#adminNoticeTitle')).toHaveText('Portal ready');
    checks.push('real-admin-session-default-Portal-ready-renamed-navigation-and-explicit-return-preserved');

    const fixtureService = new PcnService(repository);
    const ownRecord = await fixtureService.create(unsignedPayload, 'fixture', { id: '0700003-id', roles: ['supplier'] });
    const otherRecord = await fixtureService.create(unsignedPayload, 'fixture', { id: 'other-id', roles: ['supplier'] });
    for (const code of ['0700002', '0700003', '0700004', '0700005', '0700006', '0700007']) {
      const member = await openRealLogin();
      const privilegedRequests = [];
      member.on('request', request => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/api/notification-settings' || pathname.startsWith('/api/admin/')) privilegedRequests.push(pathname);
      });
      await member.locator('#employeeCode').fill(code);
      await member.waitForURL(`${origin}/admin`);
      await expect(member.locator('#adminNoticeTitle')).toHaveText('Portal ready');
      await expect(member.locator('#pcnAdminView')).toBeVisible();
      await expect(member.locator('#adminMailRoutingButton')).toBeHidden();
      await expect(member.locator('#adminUsersButton')).toBeHidden();
      await expect(member.locator('#adminStatusControl')).toBeHidden();
      await expect(member.locator('#adminPcnRows .danger-button')).toHaveCount(0);
      await expect(member.locator('#adminPcnRows tr')).toHaveCount(code === '0700003' ? 1 : 2);
      if (code === '0700003') await expect(member.locator('#adminPcnRows')).not.toContainText(otherRecord.id);
      await member.getByRole('button', { name: `History ${ownRecord.id}`, exact: true }).click();
      await expect(member.locator('#adminNoticeTitle')).toHaveText('PCN loaded');
      await expect(member.locator('#adminProgressSteps input:not(:disabled)')).toHaveCount(0);
      for (const hash of ['#mail-routing', '#users', '#records']) {
        await member.goto(`${origin}/admin${hash}`, { waitUntil: 'domcontentloaded' });
        await expect(member.locator('#pcnAdminView')).toBeVisible();
        await expect(member.locator('#mailRoutingView')).toBeHidden();
        await expect(member.locator('#adminUsersView')).toBeHidden();
      }
      assert.deepEqual(privilegedRequests, [], code);
      assert.equal((await member.request.get(`${origin}/api/admin/users`)).status(), 403);
      await member.goto(`${origin}/records`, { waitUntil: 'domcontentloaded' });
      await member.waitForURL(`${origin}/admin`);
      await expect(member.locator('#adminNoticeTitle')).toHaveText('Portal ready');
      await member.goto(`${origin}/form.html`, { waitUntil: 'domcontentloaded' });
      await expect(member.locator('#formAdminLink')).toBeVisible();
      await expect(member.locator('.topbar-actions a[href="/records"]')).toBeHidden();
      await member.locator('#formAdminLink').click();
      await expect(member.locator('#adminNoticeTitle')).toHaveText('Portal ready');
    }
    checks.push('every-assigned-role-opens-Portal-records-without-administrator-requests-or-controls');
    const pendingAccess = await openRealLogin();
    await pendingAccess.locator('#employeeCode').fill('0700008');
    await pendingAccess.waitForURL(`${origin}/records`);
    await expect(pendingAccess.locator('#recordsWorkspace')).toBeVisible();
    await expect(pendingAccess.locator('#recordsRows tr')).toHaveCount(2);
    await expect(pendingAccess.locator('.topbar-actions a')).toHaveCount(0);
    await pendingAccess.goto(`${origin}/admin`, { waitUntil: 'domcontentloaded' });
    await pendingAccess.waitForURL(`${origin}/records`);
    await expect(pendingAccess.locator('#recordsWorkspace')).toBeVisible();
    checks.push('roleless-session-views-all-records-without-create-or-Portal-navigation');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(JSON.stringify({ browser: 'passed', checks, storage: 'isolated_loopback_fixtures' }));
  } catch (error) {
    console.error('Login browser journey failed before cleanup:', error);
    throw error;
  } finally {
    releaseHeld();
    for (let index = 0; index < contexts.length; index += 1) {
      await contexts[index].tracing.stop({ path: path.resolve(`test-results/login-trace-${index + 1}.zip`) });
      await contexts[index].close();
    }
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
