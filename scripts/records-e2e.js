// Genuine loopback sessions and in-memory records; never uses SQL or live mail.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');

async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const service = new PcnService(repository);
  const first = await service.create({ ...unsignedPayload, supplierName: 'First supplier fixture' }, 'fixture', { id: 'creator-one', roles: ['supplier'] });
  const second = await service.create({ ...unsignedPayload, supplierName: 'Other supplier fixture' }, 'fixture', { id: 'creator-two', roles: ['supplier'] });
  const initial = await repository.list();
  const passwordAuth = fakeAuthService({ additionalUsers: [
    { username: '0800001', employeeCode: '0800001', displayName: 'Records Viewer', identityProvider: 'employee-code', roles: [] },
    { username: '0800002', employeeCode: '0800002', displayName: 'Records Administrator', identityProvider: 'employee-code', roles: ['admin'] },
    { username: '0800003', employeeCode: '0800003', displayName: 'Records Reviewer', identityProvider: 'employee-code', roles: ['reviewer'] },
    { username: '0800004', employeeCode: '0800004', displayName: 'Records Supplier', identityProvider: 'employee-code', roles: ['supplier'] }
  ] });
  const authService = { ...passwordAuth, authMode: 'employee-code',
    login: body => passwordAuth.login({ username: body.employeeCode, password: TEST_PASSWORD }) };
  const server = http.createServer();
  const contexts = [], errors = [], external = [], mail = [], checks = [];
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, service, authService,
      documents: { async list() { return []; } },
      notificationService: { async workflow() { mail.push('workflow'); throw new Error('Viewer must not send mail'); } },
      rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    const open = async code => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      await context.tracing.start({ screenshots: true, snapshots: true });
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/login`);
      await page.locator('#employeeCode').fill(code);
      await page.waitForURL(`${origin}/${code === '0800001' ? 'records' : 'admin'}`);
      return page;
    };
    const viewer = await open('0800001');
    await expect(viewer.locator('#recordsWorkspace')).toBeVisible();
    await expect(viewer.locator('#recordsRows a')).toHaveCount(2);
    await expect(viewer.locator('#recordsRows')).toContainText(first.id);
    await expect(viewer.locator('#recordsRows')).toContainText(second.id);
    await expect(viewer.locator('.topbar-actions a')).toHaveCount(0);
    await viewer.locator('#recordsSearch').fill('Other supplier fixture');
    await expect(viewer.locator('#recordsRows a')).toHaveCount(1);
    await expect(viewer.locator('#recordsRows')).toContainText(second.id);
    await viewer.locator('#recordsSearch').fill('');
    await viewer.locator('#recordsRefreshButton').click();
    await expect(viewer.locator('#recordsRows a')).toHaveCount(2);
    await viewer.screenshot({ path: path.resolve('test-results/records-roleless-desktop.png'), fullPage: true });
    checks.push('roleless-login-shows-all-owners-search-refresh-no-create-or-Portal');

    await viewer.getByRole('link', { name: second.id, exact: true }).click();
    await expect(viewer.locator('#appNoticeTitle')).toHaveText('PCN loaded');
    await expect(viewer.locator('#supplierName')).toHaveValue('Other supplier fixture');
    await expect(viewer.locator('main input:not(:disabled), main select:not(:disabled), main textarea:not(:disabled)')).toHaveCount(0);
    await expect(viewer.locator('#submitButton')).toBeHidden();
    await expect(viewer.locator('#saveDraftButton')).toBeHidden();
    await expect(viewer.locator('#loadDemoButton')).toBeHidden();
    await expect(viewer.locator('#formAdminLink')).toBeHidden();
    await expect(viewer.locator('.topbar-actions a[href="/records"]')).toBeVisible();
    await expect(viewer.locator('[data-internal-field="signoff.gscTet.comment"]')).toBeDisabled();
    await expect(viewer.getByRole('button', { name: 'Start new revision', exact: true })).toBeHidden();
    await viewer.getByRole('tab', { name: 'Attachments', exact: true }).click();
    await expect(viewer.getByRole('button', { name: 'Upload file', exact: true })).toBeHidden();
    await viewer.screenshot({ path: path.resolve('test-results/records-roleless-detail.png'), fullPage: true });
    await viewer.locator('.topbar-actions a[href="/records"]').click();
    await viewer.waitForURL(`${origin}/records`);
    checks.push('other-owner-detail-readonly-signatures-comments-save-upload-revision-blocked-return-link');

    for (const route of ['/create', '/admin']) {
      await viewer.goto(`${origin}${route}`);
      await viewer.waitForURL(`${origin}/records`);
      await expect(viewer.locator('#recordsWorkspace')).toBeVisible();
    }
    const csrf = (await (await viewer.request.get(`${origin}/api/session`)).json()).data.csrfToken;
    const blocked = [
      ['POST', '/api/pcns', unsignedPayload],
      ['PATCH', `/api/pcns/${second.id}`, { version: second.version, reason: 'Unauthorized edit' }],
      ['POST', `/api/pcns/${second.id}/comments`, { version: second.version, text: 'Unauthorized comment' }],
      ['POST', `/api/pcns/${second.id}/approvals`, { version: second.version, approved: true }],
      ['POST', `/api/pcns/${second.id}/revisions`, { version: second.version, reason: 'Unauthorized revision' }],
      ['POST', `/api/pcns/${second.id}/documents`, { version: second.version }],
      ['POST', `/api/pcns/${second.id}/notifications/workflow`, {}],
      ['DELETE', `/api/pcns/${second.id}`, { version: second.version }]
    ];
    for (const [method, route, data] of blocked) {
      const response = await viewer.request.fetch(`${origin}${route}`, { method, data,
        headers: { origin, 'x-csrf-token': csrf } });
      assert.equal(response.status(), 403, `${method} ${route} remains forbidden`);
    }
    assert.deepEqual(await repository.list(), initial, 'Rejected viewer mutations preserve every record');
    checks.push('roleless-create-Portal-redirect-and-server-mutations-denied');
    await viewer.setViewportSize({ width: 390, height: 844 });
    await expect(viewer.locator('#recordsSearch')).toBeVisible();
    await expect(viewer.locator('#recordsRows a')).toHaveCount(2);
    assert.equal(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await viewer.screenshot({ path: path.resolve('test-results/records-roleless-mobile.png'), fullPage: true });

    for (const code of ['0800002', '0800003', '0800004']) {
      const member = await open(code);
      await member.goto(`${origin}/records`);
      await member.waitForURL(`${origin}/admin`);
      await expect(member.locator('#pcnAdminView')).toBeVisible();
      await member.goto(`${origin}/create`);
      await expect(member.locator('#formAdminLink')).toBeVisible();
      await expect(member.locator('.topbar-actions a[href="/records"]')).toBeHidden();
    }
    checks.push('assigned-admin-reviewer-supplier-Records-redirect-Portal-Create-hides-Records');
    assert.deepEqual(mail, []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: 'passed', checks, storage: 'isolated-memory-fixtures', mail: 'none' }));
  } finally {
    for (let index = 0; index < contexts.length; index += 1) {
      await contexts[index].tracing.stop({ path: path.resolve(`test-results/records-trace-${index + 1}.zip`) });
      await contexts[index].close();
    }
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
