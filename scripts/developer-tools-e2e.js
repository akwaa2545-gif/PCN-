// Synthetic loopback acceptance only. No SQL connection, mail integration or external requests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { createApp } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, unsignedPayload, TEST_PASSWORD } = require('../test/helpers/apiHarness');

async function main() {
  const report = { storage: 'isolated_memory_only', checks: [], writes: [], external: [], errors: [] };
  const check = text => { report.checks.push(text);console.log(text); };
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...require('../src/masterData'), versionId: 1 });
  const developer = { id: 'tools-dev-id', username: 'tools-dev', displayName: 'Developer fixture', roles: ['developer'], department: 'developer', signingStep: null, isActive: true };
  const authService = fakeAuthService({ additionalUsers: [developer] });
  const service = new PcnService(repository);
  let record = await service.create({ ...unsignedPayload, supplierName: 'Tool Supplier', status: 'draft' }, developer, developer);
  for (let number = 1; number <= 31; number++) record = await service.update(record.id, { version: record.version, reason: `Reason update ${number}` }, developer, developer);
  record = await service.update(record.id, { version: record.version, reason: '<img src=x onerror="window.injected=true">' }, developer, developer);
  record = await service.update(record.id, { version: record.version, status: 'submitted' }, developer, developer);
  record = await service.update(record.id, { version: record.version, internalReview: { signoff: { gscTet: { prepared: true } } } }, developer, developer);
  const other = await service.create({ ...unsignedPayload, supplierName: 'Second tool supplier', status: 'draft' }, developer, developer);
  const server = createApp({ repository, service, authService, documents: { list: async () => [] }, publicOrigin: 'http://localhost', secureCookies: false });
  let browser, context, page;
  const releases = [];
  try {
    await fs.mkdir('test-results', { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { report.external.push(url.pathname);return route.abort(); }
      if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
      if (!['GET', 'HEAD'].includes(request.method()) && !url.pathname.endsWith('/login')) report.writes.push(url.pathname);
      return route.continue();
    });
    const login = async username => {
      const response = await context.request.post(`${origin}/api/auth/login`, { headers: { origin: 'http://localhost' }, data: { username, password: TEST_PASSWORD } });
      assert.equal(response.status(), 200);
    };
    await login('tools-dev');
    page = await context.newPage();page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`${origin}/admin`);
    await expect(page.locator('#adminDeveloperLink')).toBeVisible();await page.locator('#adminDeveloperLink').click();
    await expect(page).toHaveURL(`${origin}/developer`);await expect(page.locator('#developerMain')).toBeVisible();
    await page.locator('#pcnSelect').selectOption(record.id);
    await expect(page.locator('#workflowStages')).toContainText('Developer fixture');
    await expect(page.locator('#workflowSummary')).toContainText(/Checked/i);
    await expect(page.locator('#workflowStages')).toContainText(/Prepared/);
    check('Only Developer menu opens the inspector with recorded signer and next Checked action');
    await page.screenshot({ path: path.resolve('test-results/developer-workflow-desktop.png'), fullPage: true });
    await page.locator('#transactionsTab').click();
    await expect(page.locator('#transactionRows tr')).toHaveCount(25);
    await page.locator('#transactionNext').click();await expect(page.locator('#transactionPrevious')).toBeEnabled();
    await page.locator('#transactionSearch').fill('Reason update 31');
    await expect(page.locator('#transactionRows')).toContainText('Reason update 31');
    await page.locator('#transactionSearch').fill('<img');
    await expect(page.locator('#transactionRows')).toContainText('<img');
    assert.equal(await page.locator('#transactionRows img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.locator('#transactionSearch').fill('');
    await page.locator('#transactionFrom').fill('2099-01-01');
    await expect(page.locator('#transactionCount')).toContainText(/0/);
    await page.locator('#transactionFrom').fill('');
    check('Transactions show before/after values, paginate, search and date-filter without rendering injected HTML');
    await page.screenshot({ path: path.resolve('test-results/developer-transactions-desktop.png'), fullPage: true });
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });releases.push(release);
    let hold = true;
    await context.route(`${origin}/api/developer/pcns/${record.id}/inspect`, async route => {
      if (hold) { hold = false;entered();await gate; }
      return route.continue();
    });
    await page.locator('#refreshDeveloper').click();await waiting;
    await page.locator('#pcnSelect').selectOption(other.id);
    await expect(page.locator('#workflowSummary')).toContainText(/Prepare and submit/i);
    release();await page.waitForTimeout(100);
    await expect(page.locator('#pcnSelect')).toHaveValue(other.id);
    await expect(page.locator('#workflowSummary')).toContainText(/Prepare and submit/i);
    check('A late response for the previous PCN cannot replace the newly selected document');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#pcnSelect').selectOption(record.id);await expect(page.locator('#transactionRows')).toContainText(/Developer fixture/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile page contains table scrolling');
    await page.screenshot({ path: path.resolve('test-results/developer-tools-mobile.png'), fullPage: true });
    await context.route(`${origin}/api/developer/pcns/${record.id}/inspect`, route => route.fulfill({ status: 403, json: { success: false, error: 'Developer access required' } }));
    await page.locator('#refreshDeveloper').click();await expect(page.locator('#developerMain')).toBeHidden();
    await expect(page.locator('#pcnSelect option')).toHaveCount(1);
    await expect(page.locator('#workflowStages')).toBeEmpty();
    check('Losing Developer access clears cached document choices and details and hides the tools');
    await login('admin');await page.goto(`${origin}/admin`);await expect(page.locator('#adminDeveloperLink')).toBeHidden();
    await page.goto(`${origin}/developer`);await expect(page.locator('#developerMain')).toBeHidden();await expect(page.locator('#developerStatus')).toContainText(/access|Developer/i);
    const denied = await context.request.get(`${origin}/api/developer/pcns`);assert.equal(denied.status(), 403);
    check('Mobile layout stays contained; Administrator sees no menu and cannot use the page or API');
    assert.deepEqual(report.writes, []);assert.deepEqual(report.external, []);assert.deepEqual(report.errors, []);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';report.error = error.stack;process.exitCode = 1;
    if (page) await page.screenshot({ path: path.resolve('test-results/developer-tools-failure.png'), fullPage: true }).catch(() => {});
  } finally {
    releases.forEach(release => release());
    if (context) await context.close();if (browser) await browser.close();
    await new Promise(resolve => { server.close(resolve);server.closeAllConnections(); });
    await fs.writeFile('test-results/developer-tools-acceptance.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error.message);process.exitCode = 1; });
