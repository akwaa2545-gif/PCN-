// Two independent browser sessions, loopback auth, in-memory PCNs and mocked access/routing saves.
// No SQL, live directory, Power Automate, notification queue or external requests.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: playwrightExpect } = require('@playwright/test');
const expect = playwrightExpect.configure({ timeout: 10000 });
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');
const { mailGroups } = require('../src/mailRouting');
const rootDir = path.resolve(__dirname, '..');
const report = { storage: 'isolated_memory_only', checks: [], mutations: [], errors: [], external: [], forbidden: [], timings: [] };

async function unchangedFor(milliseconds, read, expected, message) {
  const deadline = Date.now() + milliseconds;
  do {
    assert.equal(await read(), expected, message);
    await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  assert.equal(await read(), expected, message);
}
async function withinInterval(label, assertion) {
  const started = Date.now();
  await assertion();
  const elapsedMs = Date.now() - started;
  assert(elapsedMs <= 10000, `${label} appears within ten seconds without Refresh`);
  report.timings.push({ label, elapsedMs });
}

async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const service = new PcnService(repository);
  const record = await service.create({ ...unsignedPayload, status: 'draft', supplierName: 'Polling Supplier Initial' }, 'fixture', { id: 'admin-id', roles: ['admin'] });
  let users = [{ id: 'poll-user', employeeCode: '7300001', username: '7300001', displayName: 'Polling Account Initial',
    roles: ['qa'], department: 'qaTet', signingStep: 'checked', isActive: true, identityProvider: 'pcn-local',
    mailProfile: { id: 'mail-poll', email: 'poll.account@example.test', displayName: 'Polling Account Initial' },
    version: '0000000000000001' }];
  let settings = { schemaVersion: 2, version: '0000000000000001', groups: mailGroups.map(group => ({ ...group,
    recipients: group.key === 'department.gscTet.prepared' ? [{ email: 'initial.route@example.test', displayName: 'Initial Routing Contact', id: 'initial-route' }] : [],
    emails: group.key === 'department.gscTet.prepared' ? 'initial.route@example.test' : '' })),
    legacyGroups: [], flowConfigured: false, directoryConfigured: false };
  const authService = fakeAuthService({ additionalUsers: [{ username: 'viewer', employeeCode: '7300002',
    identityProvider: 'employee-code', displayName: 'Polling Viewer', roles: [] }] });
  const server = http.createServer();
  const contexts = [];
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, service, authService, rootDir, publicOrigin: origin,
      secureCookies: false, documents: { async list() { return []; } } }));
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    browser = await chromium.launch({ headless: true });
    const open = async (username, label) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      contexts.push(context);
      await context.tracing.start({ screenshots: true, snapshots: true });
      const reads = new Map();
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        if (url.origin !== origin) { report.external.push({ label, path: url.pathname }); return route.abort(); }
        if (method === 'GET') reads.set(url.pathname, (reads.get(url.pathname) || 0) + 1);
        if (/\/notifications(?:\/|$)/.test(url.pathname)) {
          if (method === 'GET' && url.pathname === '/api/admin/notifications/health') {
            return route.fulfill({ json: { success: true, data: { configuration: { status: 'not_configured' }, worker: { status: 'disabled' }, queue: {} } } });
          }
          report.forbidden.push({ label, method, path: url.pathname }); return route.abort();
        }
        if (['/api/admin/employees', '/api/admin/directory-users'].includes(url.pathname)) {
          report.forbidden.push({ label, method, path: url.pathname }); return route.abort();
        }
        if (url.pathname === '/api/auth/config') return route.fulfill({ json: { success: true, data: { mode: 'password', employeeProvisioningConfigured: true } } });
        if (url.pathname === '/api/admin/users' && method === 'GET') return route.fulfill({ json: { success: true, data: users } });
        if (url.pathname === '/api/admin/users/poll-user' && method === 'PATCH') {
          const body = request.postDataJSON();
          assert.equal(body.version, users[0].version, 'Mock access save uses latest version');
          users = users.map(user => ({ ...user, ...body, version: (BigInt(`0x${user.version}`) + 1n).toString(16).padStart(16, '0') }));
          report.mutations.push({ label, method, path: url.pathname });
          return route.fulfill({ json: { success: true, data: users[0] } });
        }
        if (url.pathname === '/api/notification-settings') {
          if (method === 'PUT') {
            const body = request.postDataJSON();
            assert.equal(body.version, settings.version, 'Mock routing save uses latest version');
            settings = { ...body, version: (BigInt(`0x${settings.version}`) + 1n).toString(16).padStart(16, '0'), flowConfigured: false, directoryConfigured: false };
            report.mutations.push({ label, method, path: url.pathname });
          } else assert.equal(method, 'GET');
          return route.fulfill({ json: { success: true, data: settings } });
        }
        if (!['GET', 'HEAD'].includes(method)) {
          if (method === 'PATCH' && url.pathname === `/api/pcns/${record.id}`) report.mutations.push({ label, method, path: url.pathname });
          else if (!['/api/auth/login', '/api/auth/logout'].includes(url.pathname)) { report.forbidden.push({ label, method, path: url.pathname }); return route.abort(); }
        }
        return route.continue();
      });
      const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: TEST_PASSWORD } });
      assert.equal(login.status(), 200);
      const page = await context.newPage();
      page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(15000);
      page.on('pageerror', error => report.errors.push({ label, message: error.message }));
      return { page, context, reads, count: endpoint => reads.get(endpoint) || 0 };
    };
    const a = await open('admin', 'writer-A'), b = await open('admin', 'observer-B');
    const saveSupplier = async value => {
      await a.page.locator('#supplierName').fill(value);
      const saved = a.page.waitForResponse(response => new URL(response.url()).pathname === `/api/pcns/${record.id}` && response.request().method() === 'PATCH');
      await a.page.locator('#saveDraftButton').click();
      assert.equal((await saved).status(), 200, 'Writer saves isolated draft through actual UI/API');
      await expect(a.page.locator('#pcnSaveOverlay')).toBeHidden();
    };
    const directSave = (page, endpoint, body, method) => page.evaluate(async ({ endpoint, body, method }) =>
      window.PCN_SESSION.fetch(endpoint, { method, body: JSON.stringify(body) }), { endpoint, body, method });

    await a.page.goto(`${origin}/${record.id}`);
    await expect(a.page.locator('#supplierName')).toHaveValue('Polling Supplier Initial');
    await b.page.goto(`${origin}/admin`);
    await expect(b.page.locator('#adminPcnRows')).toContainText('Polling Supplier Initial');
    await b.page.locator('#adminSearchInput').fill('Polling Supplier');
    await b.page.locator('#adminSearchInput').focus();
    await b.page.evaluate(() => window.scrollTo(0, 100));
    const portalScroll = await b.page.evaluate(() => scrollY);
    const initialHealth = b.count('/api/admin/notifications/health');
    await saveSupplier('Polling Supplier Remote One');
    await withinInterval('Portal', () => expect(b.page.locator('#adminPcnRows')).toContainText('Polling Supplier Remote One'));
    await expect(b.page.locator('#adminSearchInput')).toHaveValue('Polling Supplier');
    await expect(b.page.locator('#adminSearchInput')).toBeFocused();
    assert.equal(await b.page.evaluate(() => scrollY), portalScroll);
    assert.equal(b.count('/api/admin/notifications/health'), initialHealth, 'Polling does not repeat notification health');
    report.checks.push('Portal updates after another browser save without Refresh; search/focus/scroll preserved');

    await b.page.locator('#adminUsersButton').click();
    await expect(b.page.locator('#adminUsersRows')).toContainText('Polling Account Initial');
    await b.page.locator('#usersSearchFilter').fill('Polling Account');
    await b.page.locator('#usersSearchFilter').focus();
    await directSave(a.page, '/api/admin/users/poll-user', { version: users[0].version, displayName: 'Polling Account Remote' }, 'PATCH');
    await withinInterval('Users', () => expect(b.page.locator('#adminUsersRows')).toContainText('Polling Account Remote'));
    await expect(b.page.locator('#usersSearchFilter')).toHaveValue('Polling Account');
    await expect(b.page.locator('#usersSearchFilter')).toBeFocused();
    const usersReads = b.count('/api/admin/users');
    await b.page.locator('#usersCreateButton').click();
    await b.page.locator('#employeeManualCode').fill('7300003');
    await unchangedFor(5500, () => b.count('/api/admin/users'), usersReads, 'User polling pauses while account dialog is open');
    await expect(b.page.locator('#employeeManualCode')).toHaveValue('7300003');
    await b.page.locator('#employeeCancelButton').click();
    report.checks.push('Users update automatically, keep filters/focus, and pause during unsaved account dialog');

    await b.page.locator('#adminMailRoutingButton').click();
    const routingList = b.page.locator('[data-notification-group="department.gscTet.prepared"]');
    await expect(routingList).toContainText('initial.route@example.test');
    await routingList.getByRole('button', { name: 'Remove initial.route@example.test from GSC/TET Prepared' }).click();
    await expect(routingList.locator('[data-recipient-email]')).toHaveCount(0);
    const routingReads = b.count('/api/notification-settings');
    await directSave(a.page, '/api/notification-settings', { ...settings, groups: settings.groups.map(group => group.key === 'department.gscTet.prepared' ? { ...group,
      recipients: [{ id: 'remote-route', displayName: 'Remote Routing Contact', email: 'remote.route@example.test' }], emails: 'remote.route@example.test' } : group) }, 'PUT');
    await unchangedFor(5500, () => b.count('/api/notification-settings'), routingReads, 'Dirty routing suppresses automatic settings reload');
    await expect(routingList.locator('[data-recipient-email]')).toHaveCount(0);
    await expect(b.page.locator('#notificationSaveButton')).toBeEnabled();
    await b.page.screenshot({ path: path.resolve('test-results/auto-refresh-routing-draft.png') });
    report.checks.push('Routing draft survives remote settings save and five-second polling interval without extra directory/mail calls');

    // Independent roleless session exercises Records, while writer A still uses its same isolated session.
    const viewer = await open('viewer', 'observer-records');
    await viewer.page.goto(`${origin}/records`);
    await expect(viewer.page.locator('#recordsRows')).toContainText('Polling Supplier Remote One');
    await viewer.page.locator('#recordsSearch').fill('Polling Supplier');
    await viewer.page.locator('#recordsSearch').focus();
    await saveSupplier('Polling Supplier Remote Two');
    await withinInterval('Records', () => expect(viewer.page.locator('#recordsRows')).toContainText('Polling Supplier Remote Two'));
    await expect(viewer.page.locator('#recordsSearch')).toHaveValue('Polling Supplier');
    await expect(viewer.page.locator('#recordsSearch')).toBeFocused();
    report.checks.push('Roleless Records list updates within interval with its search/focus retained');

    // Navigate directly to avoid discarding the routing draft through any save API.
    await b.page.goto(`${origin}/${record.id}`);
    await expect(b.page.locator('#supplierName')).toHaveValue('Polling Supplier Remote Two');
    await b.page.locator('#supplierName').focus();
    await b.page.locator('#supplierName').evaluate(input => input.setSelectionRange(2, 7));
    const detailScroll = await b.page.evaluate(() => scrollY);
    await saveSupplier('Polling Supplier Remote Three');
    await withinInterval('Clean detail', () => expect(b.page.locator('#supplierName')).toHaveValue('Polling Supplier Remote Three'));
    await expect(b.page.locator('#supplierName')).toBeFocused();
    assert.deepEqual(await b.page.locator('#supplierName').evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 7]);
    assert.equal(await b.page.evaluate(() => scrollY), detailScroll);
    await b.page.locator('#supplierName').fill('Unsaved observer draft');
    await saveSupplier('Polling Supplier Remote Four');
    const remoteNotice = b.page.getByRole('status').filter({ hasText: 'This record changed. Reload to view latest changes.' });
    await withinInterval('Dirty detail notice', () => expect(remoteNotice).toBeVisible());
    await expect(b.page.locator('#supplierName')).toHaveValue('Unsaved observer draft');
    await expect(b.page.locator('#supplierName')).toBeFocused();
    await b.page.screenshot({ path: path.resolve('test-results/auto-refresh-dirty-detail.png') });
    report.checks.push('Clean detail updates preserving caret/focus/scroll; dirty input remains and remote-change notice appears');

    // Headless Chromium keeps visibilityState visible, and CDP freeze does not
    // reliably suspend this target. Exercise the application's visibility wiring
    // explicitly; this is synthetic visibility, not native background-tab evidence.
    const setVisibility = state => viewer.page.evaluate(value => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
    await setVisibility('hidden');
    await saveSupplier('Polling Supplier After Resume');
    // The writer save settles any previously dispatched read before measurement.
    const frozenReads = viewer.count('/api/pcns/overview');
    await unchangedFor(5500, () => viewer.count('/api/pcns/overview'), frozenReads, 'Synthetic hidden visibility stops list polling');
    await setVisibility('visible');
    await withinInterval('Visibility resumed Records', () => expect(viewer.page.locator('#recordsRows')).toContainText('Polling Supplier After Resume'));
    report.checks.push('Synthetic visibilitychange wiring pauses polling while hidden and immediately refreshes on return');
    report.visibilityEvidence = 'Synthetic document.visibilityState plus visibilitychange; real CDP freeze was unreliable in headless Chromium';
    await viewer.page.screenshot({ path: path.resolve('test-results/auto-refresh-records-resumed.png') });
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
    assert.equal(report.mutations.filter(write => write.path === `/api/pcns/${record.id}`).length, 5);
    assert.equal(report.mutations.filter(write => write.path === '/api/admin/users/poll-user').length, 1);
    assert.equal(report.mutations.filter(write => write.path === '/api/notification-settings').length, 1);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.message; process.exitCode = 1;
  } finally {
    for (const [index, context] of contexts.entries()) {
      await context.tracing.stop({ path: path.resolve('test-results', `auto-refresh-${index + 1}-trace.zip`) });
      await context.close();
    }
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.resolve('test-results/auto-refresh-acceptance.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main();
