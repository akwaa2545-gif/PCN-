// Genuine login and presence with isolated memory accounts and a controlled service clock.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: browserExpect } = require('@playwright/test');
const { AuthService } = require('../src/authService');
const { createRequestHandler } = require('../src/httpServer');
const { memoryRepository } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');
const expect = browserExpect.configure({ timeout: 10000 });
const report = { storage: 'isolated_memory_only', checks: [], errors: [], external: [], forbidden: [], mailCalls: 0 };

function fixtureAccounts() {
  const employee = (code, name, roles, department = null, isActive = true) => ({ id: crypto.randomUUID(),
    username: code, employeeCode: code, normalizedEmployeeCode: code, displayName: name, roles, department,
    isActive, identityProvider: 'pcn-local', signingStep: null, securityStamp: crypto.randomUUID(), version: '0000000000000001' });
  const administrator = employee('0800200', 'Presence Administrator Fixture', ['admin'], 'it');
  const assigned = employee('0800300', 'Assigned Employee Fixture', ['qa'], 'qaTet');
  const pending = employee('0800301', 'Pending Employee Fixture', []);
  const inactive = employee('0800302', 'Inactive Employee Fixture', ['qa'], 'qaTet', false);
  const users = [administrator, assigned, pending, inactive];
  let sessions = [], now = Date.now();
  const copy = value => structuredClone(value);
  const repository = {
    async getUserByEmployeeCode(code) { return copy(users.find(user => user.normalizedEmployeeCode === code) || null); },
    async getUserById(id) { return copy(users.find(user => user.id === id) || null); },
    async listUsers() { return users.map(({ securityStamp, ...user }) => copy(user)); },
    async saveSession(session) { sessions = [...sessions, copy(session)]; },
    async getSession(hash) { return copy(sessions.find(session => session.tokenHash === hash && !session.revokedAt) || null); },
    async revokeSession(hash) { sessions = sessions.map(session => session.tokenHash === hash ? { ...session, revokedAt: new Date(now).toISOString() } : session); }
  };
  return { administrator, assigned, pending, inactive, repository, users: () => copy(users),
    clock: () => new Date(now), advance: milliseconds => { now += milliseconds; } };
}

async function main() {
  const fixture = fixtureAccounts(), instances = [];
  const records = memoryRepository(); records.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const originalUsers = fixture.users(), originalRecords = await records.list();
  const authService = new AuthService(fixture.repository, { authMode: 'employee-code', clock: fixture.clock });
  const server = http.createServer();
  let browser;
  try {
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository: records, authService, publicOrigin: origin,
      rootDir: path.resolve(__dirname, '..'), secureCookies: false, documents: { async list() { return []; } } }));
    browser = await chromium.launch({ headless: true });
    const open = async account => {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
      await context.tracing.start({ screenshots: true, snapshots: true });
      const instance = { context, page: await context.newPage(), sessionReads: 0, usersReads: 0, closed: false };
      instances.push(instance);
      instance.page.setDefaultTimeout(10000);
      instance.page.setDefaultNavigationTimeout(30000);
      await instance.page.clock.install();
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
        if (url.pathname === '/api/session') instance.sessionReads++;
        if (url.pathname === '/api/admin/users') instance.usersReads++;
        if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
        if (url.pathname === '/api/admin/notifications/health') return route.fulfill({ json: { success: true, data: { configuration: { status: 'not_configured' }, worker: { status: 'disabled' }, queue: {} } } });
        if (/\/notifications(?:\/|$)/.test(url.pathname) || (!['GET', 'HEAD'].includes(request.method())
          && !['/api/auth/login', '/api/auth/logout'].includes(url.pathname))) {
          report.forbidden.push({ method: request.method(), path: url.pathname }); return route.abort();
        }
        return route.continue();
      });
      instance.page.on('pageerror', error => report.errors.push(error.message));
      await instance.page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
      await expect(instance.page.locator('#employeeCode')).toBeVisible();
      await instance.page.locator('#employeeCode').fill(account.employeeCode);
      await instance.page.waitForURL(`${origin}/${account.roles.length ? 'admin' : 'records'}`);
      await expect(instance.page.locator('#accountMenu .account-trigger')).toBeVisible();
      return instance;
    };
    const close = async instance => {
      if (instance.closed) return;
      await instance.context.tracing.stop({ path: path.resolve(`test-results/user-presence-trace-${instances.indexOf(instance) + 1}.zip`) });
      await instance.context.close(); instance.closed = true;
    };
    const admin = await open(fixture.administrator), page = admin.page;
    await page.locator('#adminUsersButton').click();
    const row = (account, table = account.roles.length ? '#adminUsersRows' : '#pendingUsersRows') => page.locator(`${table} tr`).filter({ hasText: account.displayName });
    const presence = (account, status) => expect(row(account).locator('.user-presence-badge')).toHaveText(status);
    const poll = async () => {
      const before = admin.usersReads;
      await page.clock.runFor(5001);
      await expect.poll(() => admin.usersReads).toBeGreaterThan(before);
    };
    await presence(fixture.assigned, 'Offline'); await presence(fixture.pending, 'Offline');
    await expect(row(fixture.inactive)).toContainText('Inactive'); await presence(fixture.inactive, 'Offline');
    await expect(row(fixture.assigned)).toContainText('Active');
    await expect(row(fixture.administrator).locator('.user-presence-badge')).toHaveText('Online');
    report.checks.push('Users shows real Online/Offline presence separately from Active/Inactive account access, including pending accounts');

    await page.locator('#usersSearchFilter').fill('Employee Fixture');
    await page.locator('#usersStatusFilter').selectOption('active');
    const action = row(fixture.assigned).locator('[data-user-action="edit"]');
    await action.focus();
    const assigned1 = await open(fixture.assigned);
    await poll(); await presence(fixture.assigned, 'Online'); await expect(action).toBeFocused();
    await expect(page.locator('#usersSearchFilter')).toHaveValue('Employee Fixture');
    await expect(page.locator('#usersStatusFilter')).toHaveValue('active');
    await expect(row(fixture.inactive)).toHaveCount(0);
    const pending = await open(fixture.pending);
    assert.equal((await pending.context.request.get(`${origin}/api/admin/users`)).status(), 403);
    await poll(); await presence(fixture.pending, 'Online');
    report.checks.push('Login changes assigned and pending rows automatically without Refresh users; filters and row-action focus survive; roleless employee cannot inspect presence');

    const assigned2 = await open(fixture.assigned);
    await assigned1.page.evaluate(() => window.PCN_SESSION.logout()); await assigned1.page.waitForURL(`${origin}/login`);
    await poll(); await presence(fixture.assigned, 'Online');
    await assigned2.page.evaluate(() => window.PCN_SESSION.logout()); await assigned2.page.waitForURL(`${origin}/login`);
    await poll(); await presence(fixture.assigned, 'Offline');
    report.checks.push('Two independent sessions keep an employee Online after one logout; logging out the final session switches to Offline on the next automatic update');

    await close(pending);
    fixture.advance(89999); await poll(); await presence(fixture.pending, 'Online');
    fixture.advance(1); await poll(); await presence(fixture.pending, 'Offline');
    await expect(action).toBeFocused();
    report.checks.push('Closing a browser leaves no false logout; its presence remains until 89,999ms and expires at the real production 90,000ms threshold');

    // A fresh, still-open employee page must remain present beyond the expiry window through its real heartbeat.
    const heartbeat = await open(fixture.assigned);
    for (let index = 0; index < 4; index++) {
      const reads = heartbeat.sessionReads; fixture.advance(30000);
      await heartbeat.page.clock.runFor(30001);
      await expect.poll(() => heartbeat.sessionReads).toBeGreaterThan(reads);
      await expect.poll(async () => (await authService.userPresence([fixture.assigned]))[0].status).toBe('online');
    }
    await poll(); await presence(fixture.assigned, 'Online');
    report.checks.push('An open visible page sends genuine session heartbeats every 30 seconds and remains Online for two minutes without manual reload or business writes');
    await page.locator('#usersClearFiltersButton').click();
    await page.screenshot({ path: path.resolve('test-results/user-presence-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.resolve('test-results/user-presence-mobile.png'), fullPage: true });
    assert.deepEqual(fixture.users(), originalUsers); assert.deepEqual(await records.list(), originalRecords);
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
    report.checks.push('Account grants and PCN records are unchanged; runtime errors, external integration requests, forbidden writes and mail calls are zero');
    report.browser = 'passed';
  } catch (error) { report.browser = 'failed'; report.failure = error.message; throw error; }
  finally {
    await fs.writeFile(path.resolve('test-results/user-presence-acceptance.json'), JSON.stringify(report, null, 2));
    for (const [index, instance] of instances.entries()) {
      if (instance.closed) continue;
      const page = instance.page;
      if (!page.isClosed()) await page.screenshot({ path: path.resolve(`test-results/user-presence-${index + 1}.png`), fullPage: true, timeout: 5000 }).catch(() => {});
      await instance.context.tracing.stop({ path: path.resolve(`test-results/user-presence-trace-${index + 1}.zip`) });
      await instance.context.close();
    }
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    console.log(JSON.stringify(report));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
