// Isolated local API fixtures only: no SQL, account changes, workflow triggers or email.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: browserExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { memoryRepository, fakeAuthService } = require('../test/helpers/apiHarness');
const { mailGroups } = require('../src/mailRouting');
const expect = browserExpect.configure({ timeout: 10000 });
const report = { storage: 'isolated_api_fixtures_only', checks: [], errors: [], external: [], forbidden: [], unexpected: [], saves: [] };
const departments = ['gscTet', 'prodEngTet', 'qaTet', 'gscTapbu', 'qaTapbu'];
const profile = (name, email) => ({ displayName: name, email, jobTitle: 'Fixture engineer', department: 'Fixture department', photo: '' });

async function main() {
  const saved = profile('Saved Contact', 'saved@example.test');
  const managed = { ...profile('Managed Signer', 'managed@example.test'), employeeCode: '0800123', userId: 'fixture-managed', signingStep: 'prepared' };
  let settings = { schemaVersion: 2, version: 'fixture-routing-v1', directoryConfigured: true, flowConfigured: false, legacyGroups: [],
    groups: mailGroups.map(group => ({ ...group, emails: group.key === 'department.gscTet.prepared' ? saved.email : '',
      recipients: group.key === 'department.gscTet.prepared' ? [saved] : [],
      automaticRecipients: group.key === 'department.gscTet.prepared' ? [managed] : [] })) };
  const server = http.createServer();
  let browser, context, releaseOld = () => {}, finishOldLookup;
  const oldLookupFinished = new Promise(resolve => { finishOldLookup = resolve; });
  try {
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository: memoryRepository(), authService: fakeAuthService(),
      rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const send = data => route.fulfill({ json: { success: true, data } });
      if (method === 'GET') {
        if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture-csrf', user: { id: 'fixture-admin', username: 'fixture-admin', displayName: 'Fixture Administrator', isActive: true, roles: ['admin'] } });
        if (url.pathname === '/api/auth/config') return send({ mode: 'password', employeeProvisioningConfigured: false });
        if (url.pathname === '/api/profile') return send({ status: 'unavailable' });
        if (url.pathname === '/api/pcns/overview') return send({ items: [] });
        if (url.pathname === '/api/admin/users') return send([]);
        if (url.pathname === '/api/notification-settings') return send(settings);
        if (url.pathname === '/api/admin/notifications/health') return send({ configuration: { status: 'not_configured' }, worker: { lastOutcome: null }, queue: { pending: 0, sending: 0, accepted: 0, uncertain: 0 }, deliveryVerified: false });
        if (url.pathname === '/api/admin/directory-users') {
          const query = url.searchParams.get('query');
          if (query === 'Slow former role') {
            await new Promise(resolve => { releaseOld = resolve; });
            try { return await send({ users: [profile('Old Role Contact', 'old-role@example.test')] }); }
            finally { finishOldLookup(); }
          }
          const person = query === 'Fresh Checker' ? profile('Fresh Checker', 'checker@example.test')
            : query === 'Supplier Contact' ? profile('Supplier Contact', 'supplier@example.test')
              : profile('Verified Contact', 'verified@example.test');
          return send({ users: [person] });
        }
      }
      if (method === 'PUT' && url.pathname === '/api/notification-settings') {
        const payload = request.postDataJSON(); report.saves.push(structuredClone(payload));
        assert.equal(payload.version, settings.version); assert.equal(payload.schemaVersion, 2);
        settings = { ...settings, version: `fixture-routing-v${report.saves.length + 1}`,
          groups: settings.groups.map(group => ({ ...group, ...structuredClone(payload.groups.find(entry => entry.key === group.key)) })) };
        return send(settings);
      }
      if (!['GET', 'HEAD'].includes(method)) report.forbidden.push({ method, path: url.pathname });
      else report.unexpected.push(url.pathname);
      return route.fulfill({ status: 500, json: { success: false, error: 'Unexpected isolated request' } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`${origin}/admin#mail-routing`, { waitUntil: 'domcontentloaded' });
    const department = key => page.locator(`.notification-department[data-department="${key}"]`);
    const assign = key => department(key).locator('.notification-department-add');
    const toggle = key => department(key).locator('.notification-department-toggle');
    const group = key => page.locator(`#notificationGroups [data-notification-group="${key}"]`);
    const popup = page.locator('#notificationRecipientDialog');
    const role = popup.locator('#notificationRecipientRole');
    const input = popup.locator('#notificationRecipientEmail');
    const confirm = popup.getByRole('button', { name: 'Add recipient', exact: true });
    const cancel = popup.getByRole('button', { name: 'Cancel', exact: true });
    const open = async key => { await assign(key).click(); await expect(popup).toBeVisible(); };
    const choose = async query => {
      await input.fill(query);
      await popup.locator('.directory-suggestion[role="option"]').filter({ hasText: query }).click();
      await expect(confirm).toBeEnabled();
    };
    await expect(page.locator('.notification-department')).toHaveCount(5);
    await expect(page.locator('#notificationGroups [data-notification-group]')).toHaveCount(16);
    for (const key of departments) {
      await expect(department(key).locator('.notification-department-header .notification-department-add')).toHaveCount(1);
      await expect(department(key).locator('[data-notification-group] .notification-add-button')).toHaveCount(0);
      await expect(department(key).locator('[data-notification-group]')).toHaveCount(3);
    }
    await expect(page.locator('#notificationGroups .notification-department-add')).toHaveCount(5);
    report.checks.push('Five department headers each have one Assign user action; all fifteen signing lists and the separate supplier list remain mounted');

    await open('gscTet'); await expect(role).toHaveValue(''); await expect(role).toBeFocused();
    await expect(input).toBeDisabled(); await expect(confirm).toBeDisabled();
    await confirm.dispatchEvent('click'); await expect(group('department.gscTet.approved').locator('[data-recipient-email]')).toHaveCount(0);
    await role.press('Shift+Tab'); await expect(cancel).toBeFocused();
    await cancel.press('Tab'); await expect(role).toBeFocused();
    await page.keyboard.press('Escape'); await expect(popup).toBeHidden(); await expect(assign('gscTet')).toBeFocused();
    await open('gscTet'); await expect(role).toHaveValue(''); await cancel.click(); await expect(assign('gscTet')).toBeFocused();
    report.checks.push('Signing role is required before searching or confirming; blank-role forced confirmation changes nothing; role select participates in the focus loop and Escape/Cancel restore header focus');

    await open('gscTet'); await role.selectOption('prepared'); await choose('Verified Contact');
    await role.selectOption('approved'); await expect(input).toHaveValue(''); await expect(confirm).toBeDisabled();
    await expect(popup.locator('.directory-suggestion[role="option"]')).toHaveCount(0);
    const oldEntered = page.waitForRequest(request => new URL(request.url()).pathname === '/api/admin/directory-users' && new URL(request.url()).searchParams.get('query') === 'Slow former role');
    await input.fill('Slow former role'); await oldEntered;
    await role.selectOption('checked'); await expect(input).toHaveValue(''); releaseOld(); await oldLookupFinished;
    await expect(confirm).toBeDisabled(); await expect(popup).not.toContainText('Old Role Contact');
    await choose('Fresh Checker'); await confirm.click(); await expect(popup).toBeHidden();
    await expect(page.locator('#adminToastStack')).toContainText(/checker@example\.test added to GSC\/TET.*Checked/);
    await expect(group('department.gscTet.checked').locator('[data-recipient-email]')).toHaveValue('checker@example.test');
    await expect(group('department.gscTet.prepared').locator('[data-recipient-email]')).toHaveValue('saved@example.test');
    await expect(group('department.gscTet.approved').locator('[data-recipient-email]')).toHaveCount(0);
    assert.equal(report.saves.length, 0, 'Assigning a recipient is a local draft until Save Mail');
    report.checks.push('Changing role clears a verified choice and aborts the former lookup; its late result cannot verify a new target; a fresh Checked contact changes only the Checked draft');

    const managedRow = group('department.gscTet.prepared').locator('.notification-person-managed');
    await expect(managedRow).toContainText('Managed Signer'); await expect(managedRow).toContainText('From Users');
    await expect(managedRow.locator('input, button')).toHaveCount(0);
    await group('supplierNotification').locator('.notification-add-button').click();
    await expect(popup.locator('#notificationRecipientRoleField')).toBeHidden(); await expect(input).toBeEnabled();
    await choose('Supplier Contact'); await confirm.click(); await expect(popup).toBeHidden();
    await expect(group('supplierNotification').locator('[data-recipient-email]')).toHaveValue('supplier@example.test');
    report.checks.push('From Users contacts remain read-only; Supplier Notification keeps its separate fixed-target Add flow without signing-role selection');

    const draftRows = () => page.locator('#notificationGroups [data-recipient-email]').evaluateAll(inputs => inputs.map(entry => ({ key: entry.closest('[data-notification-group]').dataset.notificationGroup, email: entry.value })));
    const beforeCollapse = await draftRows();
    for (const key of departments) {
      const control = toggle(key);
      if (await control.getAttribute('aria-expanded') === 'true') { await control.focus(); await control.press('Enter'); }
      await expect(control).toHaveAttribute('aria-expanded', 'false');
      await expect(department(key).locator('.notification-department-body')).toBeHidden();
      await expect(department(key).locator('[data-notification-group]')).toHaveCount(3);
    }
    assert.deepEqual(await draftRows(), beforeCollapse);
    await page.locator('#notificationSaveButton').click(); await expect(page.locator('#mailRoutingMessage')).toContainText('Mail routing saved.');
    assert.equal(report.saves.length, 1); const payload = report.saves[0];
    assert.deepEqual(payload.groups.map(entry => entry.key), mailGroups.map(entry => entry.key));
    for (const entry of payload.groups) {
      const expected = beforeCollapse.filter(row => row.key === entry.key).map(row => row.email).join('; ');
      assert.equal(entry.emails, expected); assert.equal(Object.hasOwn(entry, 'automaticRecipients'), false);
      assert(!entry.emails.includes(managed.email), 'Managed assignment is never copied into editable routing');
    }
    for (const key of departments) await expect(toggle(key)).toHaveAttribute('aria-expanded', 'false');
    await toggle('gscTet').click(); await expect(group('department.gscTet.prepared')).toBeVisible();
    await expect(managedRow).toContainText('From Users');
    await expect(group('department.gscTet.checked').locator('[data-recipient-email]')).toHaveValue('checker@example.test');
    assert.equal(await department('prodEngTet').evaluate(card => card.getBoundingClientRect().height <= card.querySelector('header').getBoundingClientRect().height + 2), true, 'Collapsed card remains compact beside an expanded department');
    report.checks.push('Collapsing every department preserves the exact manual drafts and mounted list nodes; Save Mail sends all sixteen versioned lists and excludes managed assignments; collapsed state survives saving');

    await page.screenshot({ path: path.resolve('test-results/mail-routing-ui-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await open('qaTet'); await expect(role).toBeFocused();
    await role.selectOption('prepared'); await choose('Verified Contact');
    await confirm.focus(); await page.keyboard.press('Tab'); await expect(role).toBeFocused();
    assert.equal(await popup.evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth; }), true);
    await page.screenshot({ path: path.resolve('test-results/mail-routing-ui-mobile-dialog.png') });
    await cancel.click(); await expect(assign('qaTet')).toBeFocused();
    await expect(toggle('qaTet')).toHaveAttribute('aria-expanded', 'false');
    await open('qaTet'); await expect(role).toHaveValue(''); await role.selectOption('prepared'); await choose('Verified Contact');
    await confirm.click(); await expect(popup).toBeHidden();
    await expect(toggle('qaTet')).toHaveAttribute('aria-expanded', 'true');
    await expect(group('department.qaTet.prepared')).toBeVisible();
    await expect(group('department.qaTet.prepared').locator('[data-recipient-email]')).toHaveValue('verified@example.test');
    await page.screenshot({ path: path.resolve('test-results/mail-routing-ui-mobile.png'), fullPage: true });
    assert.equal(report.saves.length, 1); assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
    assert.deepEqual(report.forbidden, []); assert.deepEqual(report.unexpected, []);
    report.checks.push('390px page and popup fit; focus loop includes role selection; Cancel keeps a department collapsed while confirmed assignment reveals its unsaved draft; only one explicit isolated settings save occurs, with no grants or mail');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.message; throw error; }
  finally {
    releaseOld(); await fs.writeFile(path.resolve('test-results/mail-routing-ui-acceptance.json'), JSON.stringify(report, null, 2));
    if (context) { await context.tracing.stop({ path: path.resolve('test-results/mail-routing-ui-trace.zip') }); await context.close(); }
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    console.log(JSON.stringify(report));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
