// Genuine authentication and isolated memory accounts. No SQL, live directory, mail or deployment.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: browserExpect } = require('@playwright/test');
const expect = browserExpect.configure({ timeout: 10000 });
const { AuthService } = require('../src/authService');
const { hashPassword } = require('../src/passwords');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');
const report = { storage: 'isolated_memory_only', checks: [], errors: [], external: [], forbidden: [] };

async function accountFixture() {
  const developerPassword = crypto.randomBytes(24).toString('hex');
  const maintenancePassword = crypto.randomBytes(24).toString('hex');
  const developerPasswordHash = await hashPassword(developerPassword);
  const mail = name => ({ email: `${name}@example.test`, mailDirectoryId: `fixture-${name}`, mailVerifiedAt: new Date().toISOString(),
    mailProfile: { id: `fixture-${name}`, email: `${name}@example.test`, displayName: `Fixture ${name}`, jobTitle: 'Fixture', department: 'Fixture', photo: '' } });
  const employee = (code, name, roles, department, provider = 'pcn-local') => ({ id: crypto.randomUUID(), username: code, employeeCode: code,
    normalizedEmployeeCode: code, displayName: name, roles, department, identityProvider: provider, isActive: true,
    signingStep: null, securityStamp: crypto.randomUUID(), version: '0000000000000001', ...mail(code) });
  const source = employee('0800101', 'Source Developer Fixture', ['developer'], 'developer', 'employee-code');
  const local = employee('0800102', 'Local Developer Fixture', ['developer'], 'developer');
  const administrator = employee('0800200', 'Administrator Fixture', ['admin'], 'it');
  const ordinary = employee('0800300', 'Ordinary Employee Fixture', ['qa'], 'qaTet');
  const maintenance = { id: crypto.randomUUID(), username: 'fixture-maintainer', displayName: 'Maintenance Developer Fixture',
    roles: ['developer'], department: 'developer', identityProvider: 'password', isActive: true, mustChangePassword: false,
    signingStep: null, securityStamp: crypto.randomUUID(), version: '0000000000000001', passwordHash: await hashPassword(maintenancePassword) };
  let users = [source, local, administrator, ordinary, maintenance], sessions = [], mutations = [];
  let version = 1;
  const publicCopy = user => { if (!user) return null; const { passwordHash: omitted, securityStamp: stamp, ...safe } = user; return structuredClone(safe); };
  const update = (id, patch) => {
    const previous = users.find(user => user.id === id); if (!previous) throw new Error('Unknown fixture account');
    const next = { ...previous, ...structuredClone(patch), securityStamp: crypto.randomUUID(), version: (++version).toString(16).padStart(16, '0') };
    users = users.map(user => user.id === id ? next : user); mutations = [...mutations, { id, roles: [...next.roles], department: next.department }];
    return structuredClone(next);
  };
  const repository = {
    async getUserByEmployeeCode(code) { return structuredClone(users.find(user => user.normalizedEmployeeCode === code) || null); },
    async getUserByCode(code) { return this.getUserByEmployeeCode(code); },
    async getUserByLogin(name) { return structuredClone(users.find(user => user.username.toLowerCase() === name) || null); },
    async getUserById(id) { return structuredClone(users.find(user => user.id === id) || null); },
    async listUsers() { return users.map(publicCopy); },
    async saveSession(session) { sessions = [...sessions, structuredClone(session)]; },
    async getSession(hash) { return structuredClone(sessions.find(session => session.tokenHash === hash && !session.revokedAt) || null); },
    async revokeSession(hash) { sessions = sessions.map(session => session.tokenHash === hash ? { ...session, revokedAt: new Date().toISOString() } : session); },
    async resetLoginFailures() {}, async recordLoginFailure() {},
    async createLocalEmployeeUser(account) {
      const next = employee(account.employeeCode, account.displayName, account.roles, account.department);
      const result = { ...next, ...structuredClone(account) }; users = [...users, result]; mutations = [...mutations, { id: result.id, roles: [...result.roles], department: result.department }];
      return structuredClone(result);
    },
    async updateEmployeeAccount(id, account) { return update(id, account); },
    async removeEmployeeRoles(id) { return update(id, { roles: [], department: null, signingStep: null }); }
  };
  const employeeDirectory = {
    async getByCode(code) { return code === source.employeeCode ? { employeeCode: code, displayName: source.displayName, englishName: source.displayName, isActive: true, email: null, sourceDepartment: 'Fixture', jobTitle: 'Fixture' } : null; },
    async search() { return []; }
  };
  const integrationService = { async directory(query) { return { users: [{ id: 'fixture-created-mail', email: 'created@example.test', displayName: 'Created Developer Fixture', jobTitle: 'Fixture', department: 'Fixture', photo: '' }] }; } };
  return { source, local, administrator, ordinary, maintenance, repository, employeeDirectory, integrationService,
    developerPassword, developerPasswordHash, maintenancePassword,
    getUsers: () => structuredClone(users), getMutations: () => structuredClone(mutations), getSessions: () => structuredClone(sessions) };
}

async function main() {
  const fixture = await accountFixture();
  const records = memoryRepository(); records.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const service = new PcnService(records), servers = [], contexts = [];
  let browser;
  try {
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    browser = await chromium.launch({ headless: true });
    const open = async (mode = 'employee-code', configured = true) => {
      const authService = new AuthService(fixture.repository, { authMode: mode, employeeDirectory: fixture.employeeDirectory,
        integrationService: fixture.integrationService, developerPasswordHash: configured ? fixture.developerPasswordHash : undefined });
      const server = http.createServer(); servers.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const origin = `http://127.0.0.1:${server.address().port}`;
      server.on('request', createRequestHandler({ repository: records, service, authService, employeeDirectory: fixture.employeeDirectory,
        integrationService: fixture.integrationService, rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false,
        documents: { async list() { return []; } } }));
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' }); contexts.push(context);
      await context.tracing.start({ screenshots: true, snapshots: true });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
        if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
        if (url.pathname === '/api/admin/notifications/health') return route.fulfill({ json: { success: true, data: { configuration: { status: 'not_configured' }, worker: { status: 'disabled' }, queue: {} } } });
        if (/\/notifications(?:\/|$)/.test(url.pathname) || (!['GET', 'HEAD'].includes(request.method())
          && !['/api/auth/login', '/api/auth/logout', '/api/admin/local-users'].includes(url.pathname)
          && !/^\/api\/admin\/users\/[0-9a-f-]+(?:\/roles)?$/i.test(url.pathname))) {
          report.forbidden.push({ method: request.method(), path: url.pathname }); return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto(`${origin}/login`); return { page, context, origin, authService };
    };
    const employee = await open(); const { page } = employee;
    await expect(page.locator('#employeeLoginForm')).toBeVisible();
    await page.locator('#employeeCode').fill(fixture.source.employeeCode);
    await expect(page.locator('#employeeDeveloperChallenge')).toBeVisible();
    await expect(page.locator('#employeeDeveloperPassword')).toHaveAttribute('type', 'password');
    assert.equal((await employee.context.cookies()).filter(cookie => cookie.name.startsWith('pcn_session')).length, 0);
    assert.equal(fixture.getSessions().length, 0);
    await page.locator('#employeeDeveloperPassword').fill(crypto.randomBytes(16).toString('hex'));
    await page.locator('#employeeLoginForm').getByRole('button', { name: /^Sign in$/ }).click();
    await expect(page.locator('#employeeAuthMessage')).toContainText(/password|sign.in|verified/i);
    await expect(page.locator('#employeeDeveloperPassword')).toHaveValue('');
    assert.equal(fixture.getSessions().length, 0);
    await page.locator('#employeeDeveloperPassword').fill(fixture.developerPassword);
    await page.locator('#employeeLoginForm').getByRole('button', { name: /^Sign in$/ }).click();
    await page.waitForURL(`${employee.origin}/admin`);
    await expect(page.locator('#adminUsersButton')).toBeVisible();
    await page.locator('.account-trigger').click(); await expect(page.locator('.account-panel')).toContainText('Developer');
    await page.locator('.account-sign-out').click(); await page.waitForURL(`${employee.origin}/login`);
    await page.locator('#employeeCode').fill(fixture.source.employeeCode);
    await expect(page.locator('#employeeDeveloperChallenge')).toBeVisible();
    await expect(page.locator('#employeeDeveloperPassword')).toHaveValue('');
    await page.screenshot({ path: path.resolve('test-results/developer-challenge-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Developer challenge fits mobile viewport');
    await expect(page.locator('#employeeDeveloperPassword')).toBeVisible();
    await page.screenshot({ path: path.resolve('test-results/developer-challenge-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    report.checks.push('Source Developer requires masked password each sign-in; absent/wrong password issues no session and correct password opens Portal with Developer profile');

    await page.locator('#employeeDeveloperPassword').fill('discarded-fixture-value');
    await page.locator('#employeeCode').fill('080030');
    await expect(page.locator('#employeeDeveloperChallenge')).toBeHidden(); await expect(page.locator('#employeeDeveloperPassword')).toHaveValue('');
    await page.locator('#employeeCode').fill(fixture.local.employeeCode); await expect(page.locator('#employeeDeveloperChallenge')).toBeVisible();
    await page.locator('#employeeDeveloperCancel').click();
    await expect(page.locator('#employeeDeveloperChallenge')).toBeHidden(); await expect(page.locator('#employeeCode')).toHaveValue('');
    await page.locator('#employeeCode').fill(fixture.local.employeeCode); await expect(page.locator('#employeeDeveloperChallenge')).toBeVisible();
    await page.locator('#employeeDeveloperPassword').fill(fixture.developerPassword);
    await page.locator('#employeeLoginForm').getByRole('button', { name: /^Sign in$/ }).click(); await page.waitForURL(`${employee.origin}/admin`);
    report.checks.push('Changing Employee ID or canceling clears challenge/password; local Developer uses the same protected gate');

    await page.locator('#adminUsersButton').click(); await expect(page.locator('#adminUsersRows')).toContainText('Local Developer Fixture');
    await page.locator('#usersRoleFilter').selectOption('developer'); await page.locator('#usersDepartmentFilter').selectOption('developer');
    await expect(page.locator('#adminUsersRows')).not.toContainText('Ordinary Employee Fixture');
    await expect(page.locator('#adminUsersRows')).toContainText('Source Developer Fixture');
    await page.locator('#usersClearFiltersButton').click();
    await page.locator('#usersCreateButton').click(); await expect(page.locator('#employeeUserDialog')).toBeVisible();
    await page.locator('#employeeManualCode').fill('0800999'); await page.locator('#employeeManualName').fill('Created Developer Fixture');
    await page.locator('#employeeRole').selectOption('developer');
    await expect(page.locator('#employeeDepartment')).toHaveValue('developer'); await expect(page.locator('#employeeDepartment')).toBeDisabled();
    await page.locator('#employeeMailSearch').fill('Created Developer Fixture');
    await page.locator('#employeeMailResults').getByRole('button').first().click();
    await page.locator('#employeeCreateButton').click(); await expect(page.locator('#employeeUserDialog')).toBeHidden();
    const created = fixture.getUsers().find(user => user.employeeCode === '0800999');
    assert.deepEqual(created.roles, ['developer']); assert.equal(created.department, 'developer'); assert.equal(created.signingStep, null);
    await page.locator(`[data-user-id="${created.id}"][data-user-action="edit"]`).click();
    await expect(page.locator('#employeeRole')).toHaveValue('developer'); await expect(page.locator('#employeeDepartment')).toHaveValue('developer');
    await page.locator('#employeeActive').uncheck(); await page.locator('#employeeCreateButton').click();
    await expect(page.locator('#employeeUserDialog')).toBeHidden();
    const edited = fixture.getUsers().find(user => user.id === created.id);
    assert.deepEqual(edited.roles, ['developer']); assert.equal(edited.department, 'developer'); assert.equal(edited.isActive, false);
    assert(!fixture.getUsers().some(user => user.roles.includes('developer') && user.roles.includes('admin')));
    report.checks.push('Developer has Users permission; role/department filters and Create/Edit preserve the exact Developer pair with no stored admin alias');

    const beforeOrdinary = fixture.getUsers().find(user => user.id === fixture.ordinary.id);
    page.once('dialog', dialog => dialog.accept());
    await page.locator(`[data-user-id="${fixture.local.id}"][data-user-action="remove"]`).click();
    const denied = await page.request.get(`${employee.origin}/api/admin/users`);
    assert.equal(denied.status(), 401, 'Removing Developer grant revokes its existing authenticated session');
    assert.deepEqual(fixture.getUsers().find(user => user.id === fixture.local.id).roles, []);
    assert.deepEqual(fixture.getUsers().find(user => user.id === fixture.ordinary.id), beforeOrdinary);
    const ordinary = await open(); await ordinary.page.locator('#employeeCode').fill(fixture.ordinary.employeeCode);
    await ordinary.page.waitForURL(`${ordinary.origin}/admin`);
    await expect(ordinary.page.locator('#adminUsersButton')).toBeHidden();
    report.checks.push('Removing Developer roles revokes its active session; unrelated employee grants and employee-only sign-in remain unchanged');

    const maintenance = await open('password');
    await maintenance.page.locator('#username').fill(fixture.maintenance.username); await maintenance.page.locator('#password').fill(fixture.maintenancePassword);
    await maintenance.page.locator('#loginForm').getByRole('button', { name: /^Sign in$/ }).click();
    await expect(maintenance.page.locator('#passwordDeveloperChallenge')).toBeVisible();
    await expect(maintenance.page.locator('#passwordDeveloperPassword')).toHaveAttribute('type', 'password');
    await expect(maintenance.page.locator('#password')).toHaveValue('');
    await maintenance.page.locator('#password').fill(fixture.maintenancePassword);
    await maintenance.page.locator('#passwordDeveloperPassword').fill(crypto.randomBytes(16).toString('hex'));
    await maintenance.page.locator('#loginForm').getByRole('button', { name: /^Sign in$/ }).click();
    await expect(maintenance.page.locator('#authMessage')).toContainText(/password|verified/i);
    await expect(maintenance.page.locator('#passwordDeveloperPassword')).toHaveValue('');
    assert.equal((await maintenance.context.cookies()).filter(cookie => cookie.name.startsWith('pcn_session')).length, 0);
    await maintenance.page.locator('#password').fill(fixture.maintenancePassword);
    await maintenance.page.locator('#passwordDeveloperPassword').fill(fixture.developerPassword);
    await maintenance.page.locator('#loginForm').getByRole('button', { name: /^Sign in$/ }).click();
    await maintenance.page.waitForURL(`${maintenance.origin}/admin`); await expect(maintenance.page.locator('#adminUsersButton')).toBeVisible();
    const maintenanceSession = await (await maintenance.page.request.get(`${maintenance.origin}/api/session`)).json();
    assert.deepEqual(maintenanceSession.data.user.roles, ['developer']);
    assert.equal(maintenanceSession.data.user.department, 'developer'); assert.equal(maintenanceSession.data.user.employeeCode, undefined);
    assert.equal((await maintenance.page.request.get(`${maintenance.origin}/api/admin/users`)).status(), 200);
    await maintenance.page.locator('.account-trigger').click(); await expect(maintenance.page.locator('.account-panel')).toContainText('Developer');
    report.checks.push('Maintenance Developer validates ordinary account password plus the protected Developer password before Portal access');

    const unconfigured = await open('employee-code', false);
    await unconfigured.page.locator('#employeeCode').fill(fixture.source.employeeCode);
    await expect(unconfigured.page.locator('#employeeAuthMessage')).toContainText(/unavailable|configured/i);
    assert.equal((await unconfigured.context.cookies()).filter(cookie => cookie.name.startsWith('pcn_session')).length, 0);
    report.checks.push('Missing protected Developer hash fails closed without a cookie');

    for (const instance of [employee, ordinary, maintenance, unconfigured]) {
      const resources = ['login.html', 'login.js', 'admin-users.js', 'session-client.js'];
      for (const resource of resources) {
        const text = await (await instance.page.request.get(`${instance.origin}/${resource}`)).text();
        assert(!text.includes(fixture.developerPassword)); assert(!text.includes(fixture.developerPasswordHash));
      }
      const storage = await instance.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
      assert(!storage.includes(fixture.developerPassword)); assert(!storage.includes(fixture.developerPasswordHash));
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
    report.checks.push('Protected password/hash are absent from browser assets, URLs and local/session storage; no external integration calls');
    report.browser = 'passed';
  } catch (error) { report.browser = 'failed'; report.failure = error.message; throw error; }
  finally {
    await fs.writeFile(path.resolve('test-results/developer-role-acceptance.json'), JSON.stringify(report, null, 2));
    for (const [index, context] of contexts.entries()) {
      const page = context.pages()[0]; if (page && !page.isClosed()) await page.screenshot({ path: path.resolve(`test-results/developer-role-${index + 1}.png`), fullPage: true });
      await context.tracing.stop({ path: path.resolve(`test-results/developer-role-trace-${index + 1}.zip`) }); await context.close();
    }
    if (browser) await browser.close();
    for (const server of servers) if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    console.log(JSON.stringify(report));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
