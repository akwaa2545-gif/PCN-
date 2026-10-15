// Genuine authentication with isolated memory accounts; no SQL, live directory, mail or deployment.
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
const report = { storage: 'isolated_memory_only', passwordPurpose: 'developer_role_assignment_only', checks: [], errors: [], external: [], forbidden: [] };

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
  const target = employee('0800301', 'Assignment Target Fixture', ['qa'], 'qaTet');
  const candidate = { employeeCode: '0800400', displayName: 'Directory Assignment Fixture', englishName: 'Directory Assignment Fixture',
    isActive: true, email: null, sourceDepartment: 'Fixture', jobTitle: 'Fixture' };
  const maintenance = { id: crypto.randomUUID(), username: 'fixture-maintainer', displayName: 'Maintenance Developer Fixture',
    roles: ['developer'], department: 'developer', identityProvider: 'password', isActive: true, mustChangePassword: false,
    signingStep: null, securityStamp: crypto.randomUUID(), version: '0000000000000001', passwordHash: await hashPassword(maintenancePassword) };
  let users = [source, local, administrator, ordinary, target, maintenance], sessions = [], mutations = [], version = 1;
  let fixtureNow = Date.now();
  const publicCopy = user => { if (!user) return null; const { passwordHash: omitted, securityStamp: stamp, ...safe } = user; return structuredClone(safe); };
  const recordMutation = next => {
    assert.equal(Object.hasOwn(next, 'developerPassword'), false, 'Assignment secret must never reach account storage');
    mutations = [...mutations, { id: next.id, roles: [...next.roles], department: next.department }];
  };
  const update = (id, patch) => {
    const previous = users.find(user => user.id === id); if (!previous) throw new Error('Unknown fixture account');
    const next = { ...previous, ...structuredClone(patch), securityStamp: crypto.randomUUID(), version: (++version).toString(16).padStart(16, '0') };
    recordMutation(next); users = users.map(user => user.id === id ? next : user); return structuredClone(next);
  };
  const create = (account, provider) => {
    const next = { ...employee(account.employeeCode, account.displayName, account.roles, account.department, provider), ...structuredClone(account) };
    recordMutation(next); users = [...users, next]; return structuredClone(next);
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
    async createLocalEmployeeUser(account) { return create(account, 'pcn-local'); },
    async createEmployeeUser(account) { return create(account, 'employee-code'); },
    async updateEmployeeAccount(id, account) { return update(id, account); },
    async removeEmployeeRoles(id) { return update(id, { roles: [], department: null, signingStep: null }); }
  };
  const profiles = [{ ...candidate }, { ...candidate, employeeCode: source.employeeCode, displayName: source.displayName, englishName: source.displayName }];
  const employeeDirectory = {
    async getByCode(code) { return structuredClone(profiles.find(profile => profile.employeeCode === code) || null); },
    async search(query) { return structuredClone(profiles.filter(profile => `${profile.employeeCode} ${profile.displayName}`.toLowerCase().includes(String(query).toLowerCase()))); }
  };
  const integrationService = { async directory() { return { users: [{ id: 'fixture-created-mail', email: 'created@example.test', displayName: 'Created Developer Fixture', jobTitle: 'Fixture', department: 'Fixture', photo: '' }] }; } };
  return { source, local, administrator, ordinary, target, candidate, maintenance, repository, employeeDirectory, integrationService,
    developerPassword, developerPasswordHash, maintenancePassword, now: () => new Date(fixtureNow),
    advanceAssignmentWindow: () => { fixtureNow += 900001; },
    getUsers: () => structuredClone(users), getMutations: () => structuredClone(mutations) };
}

async function main() {
  const fixture = await accountFixture();
  const records = memoryRepository(); records.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const service = new PcnService(records), servers = [], contexts = [], instances = [];
  let browser;
  try {
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    browser = await chromium.launch({ headless: true });
    const open = async (mode = 'employee-code', hash = fixture.developerPasswordHash, initialCookies = []) => {
      const authService = new AuthService(fixture.repository, { authMode: mode, clock: fixture.now, employeeDirectory: fixture.employeeDirectory,
        integrationService: fixture.integrationService, developerPasswordHash: hash });
      const server = http.createServer(); servers.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const origin = `http://127.0.0.1:${server.address().port}`;
      server.on('request', createRequestHandler({ repository: records, service, authService, employeeDirectory: fixture.employeeDirectory,
        integrationService: fixture.integrationService, rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false,
        documents: { async list() { return []; } } }));
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' }); contexts.push(context);
      if (initialCookies.length) await context.addCookies(initialCookies);
      await context.tracing.start({ screenshots: true, snapshots: true });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
        if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
        if (url.pathname === '/api/admin/notifications/health') return route.fulfill({ json: { success: true, data: { configuration: { status: 'not_configured' }, worker: { status: 'disabled' }, queue: {} } } });
        if (/\/notifications(?:\/|$)/.test(url.pathname) || (!['GET', 'HEAD'].includes(request.method())
          && !['/api/auth/login', '/api/auth/logout', '/api/admin/local-users', '/api/admin/users'].includes(url.pathname)
          && !/^\/api\/admin\/users\/[0-9a-f-]+(?:\/roles)?$/i.test(url.pathname))) {
          report.forbidden.push({ method: request.method(), path: url.pathname }); return route.abort();
        }
        if (url.pathname === '/api/auth/login' && request.method() === 'POST') {
          assert.equal(Object.hasOwn(request.postDataJSON(), 'developerPassword'), false, 'Sign-in must not send an assignment password');
        }
        return route.continue();
      });
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto(`${origin}/${initialCookies.length ? 'admin' : 'login'}`);
      const instance = { page, context, origin, authService }; instances.push(instance); return instance;
    };
    const codeLogin = async (instance, code) => {
      await expect(instance.page.locator('#employeeLoginForm')).toBeVisible();
      await instance.page.locator('#employeeCode').fill(code); await instance.page.waitForURL(`${instance.origin}/admin`);
    };
    const admin = await open(); const { page } = admin;
    await codeLogin(admin, fixture.administrator.employeeCode);
    await page.locator('#adminUsersButton').click(); await expect(page.locator('#adminUsersRows')).toContainText('Source Developer Fixture');
    for (const action of ['edit', 'remove']) {
      const button = page.locator(`[data-user-id="${fixture.source.id}"][data-user-action="${action}"]`);
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('title', /Only a Developer/);
    }
    const beforeProtection = fixture.getUsers();
    const protectionResults = await page.evaluate(async ({ target, assignmentPassword }) => {
      const session = await window.PCN_SESSION.load();
      const call = async (suffix, method, body) => {
        const response = await fetch(`/api/admin/users/${target.id}${suffix}`, { method,
          headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, body: JSON.stringify(body) });
        return response.status;
      };
      return [await call('', 'PATCH', { roles: ['developer'], department: 'developer', signingStep: null,
        isActive: false, version: target.version, developerPassword: assignmentPassword }),
      await call('/roles', 'DELETE', { version: target.version })];
    }, { target: fixture.source, assignmentPassword: fixture.developerPassword });
    assert.deepEqual(protectionResults, [403, 403]);
    assert.deepEqual(fixture.getUsers(), beforeProtection);
    await page.screenshot({ path: path.resolve('test-results/developer-admin-protected.png') });
    report.checks.push('Administrator sees disabled Developer Edit/Remove actions; direct authenticated PATCH with assignment password and DELETE roles return 403 without account changes');
    await page.evaluate(() => window.PCN_SESSION.logout());
    await page.goto(`${admin.origin}/login`);
    await codeLogin(admin, fixture.source.employeeCode);
    await page.locator('#adminUsersButton').click();
    const password = page.locator('#employeeDeveloperPassword'), dialog = page.locator('#employeeUserDialog'), save = page.locator('#employeeCreateButton');
    const submit = async (method, pathname, status) => {
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method);
      await save.click(); const result = await pending; assert.equal(result.status(), status);
      await expect(password).toHaveValue('');
      if (status < 300) await expect(dialog).toBeHidden();
      else { await expect(dialog).toBeVisible(); await expect(save).toBeDisabled(); }
      return result.json();
    };
    const selectMail = async () => {
      await page.locator('#employeeMailSearch').fill('Created Developer Fixture');
      await page.locator('#employeeMailResults').getByRole('button').first().click();
    };
    const edit = async id => {
      await page.locator(`[data-user-id="${id}"][data-user-action="edit"]`).click(); await expect(dialog).toBeVisible();
    };
    const expectPair = account => { assert.deepEqual(account.roles, ['developer']); assert.equal(account.department, 'developer'); assert.equal(account.signingStep, null); };
    const get = code => fixture.getUsers().find(user => user.employeeCode === code);

    await page.locator('#usersCreateButton').click(); await expect(password).toBeHidden();
    await page.locator('#employeeManualCode').fill('0800999'); await page.locator('#employeeManualName').fill('Created Developer Fixture');
    await page.locator('#employeeRole').selectOption('developer'); await selectMail();
    await expect(password).toBeVisible(); await expect(password).toHaveAttribute('type', 'password');
    await expect(password).toHaveAttribute('maxlength', '128'); await expect(save).toBeDisabled();
    await expect(page.locator('#employeeDepartment')).toHaveValue('developer'); await expect(page.locator('#employeeDepartment')).toBeDisabled();
    const beforeCreate = fixture.getUsers();
    await password.fill(crypto.randomBytes(16).toString('hex'));
    const wrongCreate = await submit('POST', '/api/admin/local-users', 400);
    assert.equal(wrongCreate.code, 'DEVELOPER_PASSWORD_INCORRECT'); assert.deepEqual(fixture.getUsers(), beforeCreate);
    await expect(page.locator('#employeeManualCode')).toHaveValue('0800999'); await expect(page.locator('#employeeMailSelected')).toContainText('created@example.test');
    await password.fill(fixture.developerPassword); await submit('POST', '/api/admin/local-users', 201); expectPair(get('0800999'));
    report.checks.push('Create user requires a masked Developer assignment password; wrong password keeps the draft/mail and writes nothing; correct password stores only the Developer pair');

    await edit(get('0800999').id); await expect(save).toBeDisabled();
    await password.fill(fixture.developerPassword); await page.locator('#employeeRole').selectOption('admin');
    await expect(password).toBeHidden(); await expect(password).toHaveValue(''); await expect(page.locator('#employeeDepartment')).toBeEnabled();
    await page.locator('#employeeRole').selectOption('developer'); await expect(password).toHaveValue(''); await expect(save).toBeDisabled();
    await password.fill(fixture.developerPassword); await page.locator('#employeeCancelButton').click();
    await edit(fixture.target.id); await expect(password).toBeHidden(); await expect(password).toHaveValue('');
    await page.locator('#employeeCancelButton').click(); await edit(get('0800999').id); await expect(password).toHaveValue('');
    await page.screenshot({ path: path.resolve('test-results/developer-access-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Edit access fits mobile viewport');
    await password.scrollIntoViewIfNeeded(); await expect(password).toBeVisible();
    await page.screenshot({ path: path.resolve('test-results/developer-access-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    report.checks.push('Developer password clears on role change, cancel and account switch; Edit access requires fresh verification and fits desktop/390px');

    await page.locator('#employeeActive').uncheck(); await expect(save).toBeDisabled();
    const beforeEdit = get('0800999'); await password.fill(crypto.randomBytes(16).toString('hex'));
    await submit('PATCH', `/api/admin/users/${beforeEdit.id}`, 400); assert.deepEqual(get('0800999'), beforeEdit);
    await expect(page.locator('#employeeActive')).not.toBeChecked();
    await password.fill(fixture.developerPassword); await submit('PATCH', `/api/admin/users/${beforeEdit.id}`, 200);
    expectPair(get('0800999')); assert.equal(get('0800999').isActive, false);
    report.checks.push('Editing an unchanged Developer assignment still requires the password; wrong verification preserves the account and correct verification saves the edit');

    await page.locator('#usersAddRoleButton').click(); await page.locator('#employeeSearch').fill(fixture.candidate.employeeCode);
    await page.locator('#employeeResults').getByRole('button').filter({ hasText: fixture.candidate.displayName }).click();
    await page.locator('#employeeRole').selectOption('developer'); await selectMail(); await expect(save).toBeDisabled();
    const beforeAdd = fixture.getUsers(); await password.fill(crypto.randomBytes(16).toString('hex'));
    await submit('POST', '/api/admin/users', 400); assert.deepEqual(fixture.getUsers(), beforeAdd);
    await password.fill(fixture.developerPassword); await submit('POST', '/api/admin/users', 429);
    assert.deepEqual(fixture.getUsers(), beforeAdd);
    fixture.advanceAssignmentWindow();
    await password.fill(fixture.developerPassword); await submit('POST', '/api/admin/users', 201); expectPair(get(fixture.candidate.employeeCode));
    await edit(fixture.target.id); await page.locator('#employeeRole').selectOption('developer'); await expect(save).toBeDisabled();
    await password.fill(fixture.developerPassword); await submit('PATCH', `/api/admin/users/${fixture.target.id}`, 200); expectPair(get(fixture.target.employeeCode));
    await page.locator('#usersRoleFilter').selectOption('developer'); await page.locator('#usersDepartmentFilter').selectOption('developer');
    await expect(page.locator('#adminUsersRows')).not.toContainText('Ordinary Employee Fixture');
    await expect(page.locator('#adminUsersRows')).toContainText('Directory Assignment Fixture'); await page.locator('#usersClearFiltersButton').click();
    report.checks.push('Add role and Edit access verify Developer grants, enforce assignment throttling without writes, preserve the exact role/department pair, and support Developer filters');

    const local = await open(); await codeLogin(local, fixture.local.employeeCode);
    assert.equal((await local.page.request.get(`${local.origin}/api/admin/users`)).status(), 200);
    await local.page.locator('.account-trigger').click(); await expect(local.page.locator('.account-panel')).toContainText('Developer');
    await edit(fixture.target.id); await page.locator('#employeeRole').selectOption('admin'); await page.locator('#employeeDepartment').selectOption('it');
    await expect(password).toBeHidden(); await expect(save).toBeEnabled(); page.once('dialog', prompt => prompt.accept());
    await submit('PATCH', `/api/admin/users/${fixture.target.id}`, 200); assert.deepEqual(get(fixture.target.employeeCode).roles, ['admin']);
    const originalOrdinary = fixture.getUsers().find(user => user.id === fixture.ordinary.id);
    page.once('dialog', prompt => prompt.accept());
    const removal = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/users/${fixture.local.id}/roles`);
    await page.locator(`[data-user-id="${fixture.local.id}"][data-user-action="remove"]`).click(); assert.equal((await removal).status(), 200);
    assert.equal((await local.page.request.get(`${local.origin}/api/admin/users`)).status(), 401);
    assert.deepEqual(get(fixture.local.employeeCode).roles, []);
    assert.deepEqual(fixture.getUsers().find(user => user.id === fixture.ordinary.id), originalOrdinary);
    report.checks.push('Developer can manage other Developer access; demotion/removal need no assignment password and role removal revokes the target session');

    const source = await open(); await codeLogin(source, fixture.source.employeeCode);
    assert.equal((await source.page.request.get(`${source.origin}/api/admin/users`)).status(), 200);
    const cookies = await source.context.cookies();
    const unconfigured = await open('employee-code', null); await codeLogin(unconfigured, fixture.source.employeeCode);
    assert.equal((await unconfigured.page.request.get(`${unconfigured.origin}/api/admin/users`)).status(), 200);
    const rotated = await open('employee-code', await hashPassword(crypto.randomBytes(24).toString('hex')), cookies);
    assert.equal((await rotated.page.request.get(`${rotated.origin}/api/admin/users`)).status(), 200);
    const ordinary = await open(); await codeLogin(ordinary, fixture.ordinary.employeeCode); await expect(ordinary.page.locator('#adminUsersButton')).toBeHidden();
    report.checks.push('Source Developer uses code-only sign-in; missing/rotated assignment configuration and restarted AuthService do not invalidate its session; unrelated employee sign-in is unchanged');

    const maintenance = await open('password', null);
    await maintenance.page.locator('#username').fill(fixture.maintenance.username); await maintenance.page.locator('#password').fill(fixture.maintenancePassword);
    await maintenance.page.locator('#loginForm button[type="submit"]').click(); await maintenance.page.waitForURL(`${maintenance.origin}/admin`);
    await expect(maintenance.page.locator('#adminUsersButton')).toBeVisible();
    const maintenanceSession = await (await maintenance.page.request.get(`${maintenance.origin}/api/session`)).json();
    expectPair(maintenanceSession.data.user); assert.equal(maintenanceSession.data.user.employeeCode, undefined);
    assert.equal((await maintenance.page.request.get(`${maintenance.origin}/api/admin/users`)).status(), 200);
    await maintenance.page.locator('.account-trigger').click(); await expect(maintenance.page.locator('.account-panel')).toContainText('Developer');
    report.checks.push('Maintenance Developer without an employee code uses its ordinary account password only and retains Developer profile/Users authority without assignment configuration');

    for (const instance of instances) {
      for (const resource of ['login.html', 'login.js', 'admin-users.js', 'session-client.js']) {
        const text = await (await instance.page.request.get(`${instance.origin}/${resource}`)).text();
        assert(!text.includes(fixture.developerPassword)); assert(!text.includes(fixture.developerPasswordHash));
      }
      const storage = await instance.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
      assert(!storage.includes(fixture.developerPassword)); assert(!storage.includes(fixture.developerPasswordHash));
    }
    assert(!fixture.getUsers().some(user => user.roles.includes('developer') && user.roles.includes('admin')));
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
    report.checks.push('Assignment secret/hash never reach account storage, browser assets, URLs or local/session storage; no external integration calls');
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
