// Isolated memory fixtures and loopback browser only; no live SQL, directory or mail.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: browserExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const expect = browserExpect.configure({ timeout: 12000 });

async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...require('../src/masterData'), versionId: 1 });
  const now = new Date('2026-11-19T05:00:00Z');
  const service = new PcnService(repository, () => now);
  const seeded = [];
  for (const [documentType, status] of [['ta', 'submitted'], ['sc', 'submitted'], ['ta', 'closed'], ['sc', 'closed'], [undefined, 'submitted']]) {
    seeded.push(await repository.create({ ...service.normalizeInput({ ...unsignedPayload, documentType, status,
      supplierName: 'Type filter supplier', materialName: `Type filter ${documentType || 'legacy'} ${status}` }),
      createdAt: now.toISOString(), updatedAt: now.toISOString() }, 'Historical type-filter fixture'));
  }
  const authService = fakeAuthService({ additionalUsers: [{ username: 'typed-viewer', employeeCode: '0800001',
    identityProvider: 'employee-code', displayName: 'Type Filter Viewer', roles: [] }] });
  const server = http.createServer();
  let browser;
  const checks = [], errors = [], forbidden = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, service, authService, clock: () => now,
      rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    for (const username of ['admin', 'typed-viewer']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      try {
        await context.route('**/*', route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
            forbidden.push(`${request.method()} ${url.pathname}`); return route.abort();
          }
          if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
          if (url.pathname === '/api/admin/notifications/health') return route.fulfill({ json: { success: true, data: { configuration: { status: 'not_configured' }, worker: { status: 'disabled' }, queue: {} } } });
          return route.continue();
        });
        assert.equal((await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: TEST_PASSWORD } })).status(), 200);
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${origin}/${username === 'admin' ? 'admin' : 'records'}`);
        const host = page.locator(username === 'admin' ? '#pcnAdminView' : '#recordsWorkspace');
        const rows = host.locator('tr[data-pcn-id]'), type = host.locator('#rdFilter-documentType');
        await expect(rows).toHaveCount(3);
        await expect(type.locator('option')).toHaveCount(4);
        await type.selectOption('ta'); await expect(rows).toHaveCount(1);
        await expect(rows.first()).toHaveAttribute('data-pcn-id', seeded[0].id);
        await host.locator('#rdLifecycleTab-closed').click();
        await expect(type).toHaveValue('ta'); await expect(rows).toHaveCount(1);
        await expect(rows.first()).toHaveAttribute('data-pcn-id', seeded[2].id);
        const search = page.locator(username === 'admin' ? '#adminSearchInput' : '#recordsSearch');
        await search.fill('cannot match'); await expect(rows).toHaveCount(0);
        await search.fill('Type filter'); await expect(rows).toHaveCount(1);
        await page.locator('#rdViewEditor summary').click(); await host.locator('#rdViewName').fill('TA complete');
        await host.getByRole('button', { name: 'Save current view', exact: true }).click();
        await type.selectOption('sc'); await expect(rows.first()).toHaveAttribute('data-pcn-id', seeded[3].id);
        await host.locator('#rdFilter-saved').selectOption('TA complete'); await expect(type).toHaveValue('ta');
        const download = page.waitForEvent('download');
        await host.getByRole('button', { name: 'Export filtered CSV', exact: true }).click();
        const csv = await fs.readFile(await (await download).path(), 'utf8');
        assert(csv.includes('"PCN type"') && csv.includes(`"${seeded[2].id}","TA"`) && !csv.includes(seeded[3].id));
        await host.getByRole('button', { name: 'Reset filters', exact: true }).click();
        await expect(host.locator('#rdLifecycleTab-closed')).toHaveAttribute('aria-selected', 'true');
        await expect(type).toHaveValue(''); await expect(rows).toHaveCount(2);
        await host.locator('#rdLifecycleTab-open').click(); await type.selectOption('legacy');
        await expect(rows).toHaveCount(1); await expect(rows.first()).toHaveAttribute('data-pcn-id', seeded[4].id);
        await type.selectOption('sc');
        const current = await repository.findById(seeded[1].id);
        await repository.update(current.id, row => ({ ...row, materialName: `${row.materialName} ${username}` }), 'Isolated polling update', current.version);
        await expect(rows.first().locator('[data-column="materialName"]')).toContainText(username);
        await expect(type).toHaveValue('sc');
        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await fs.mkdir(path.resolve('test-results'), { recursive: true });
        await page.screenshot({ path: path.resolve(`test-results/ta-sc-records-${username}-mobile.png`), fullPage: true });
        checks.push(`${username}: TA/SC/legacy filters, combined search, Open/Closed, saved view, CSV, reset, polling and mobile layout`);
      } finally { await context.close(); }
    }
    assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
    console.log(JSON.stringify({ status: 'passed', storage: 'isolated_memory_only', checks, errors, forbidden }));
  } finally {
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
