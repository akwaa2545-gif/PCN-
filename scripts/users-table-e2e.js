// Users lists and role removal against local fixtures; never SQL or Power Automate.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { memoryRepository, fakeAuthService, TEST_PASSWORD } = require('../test/helpers/apiHarness');

const rootDir = path.resolve(__dirname, '..');
const version = '0000000000000001';
const profile = { id: 'fixture-profile', email: 'source.signer@example.test', displayName: 'Source Signer', department: 'Quality', jobTitle: 'Engineer' };
const account = (id, name, roles, extra = {}) => ({ id, username: id, displayName: name, roles, department: null,
  employeeCode: null, signingStep: null, mailProfile: null, email: null, isActive: true, identityProvider: 'employee-code', version, ...extra });
const fixtures = [
  account('fixture-admin', 'Fixture Administrator', ['admin'], { department: 'it', identityProvider: 'password' }),
  account('source-signer', 'Example Source Signer', ['qa', 'reviewer'], { employeeCode: '7100001', department: 'qaTet', signingStep: 'checked', mailProfile: profile }),
  account('local-signer', 'Example Local Signer', ['gsc'], { employeeCode: '7100002', identityProvider: 'pcn-local', department: 'gscTet', signingStep: 'prepared', mailProfile: { ...profile, email: 'local.signer@example.test' } }),
  account('legacy-requester', 'Example Legacy Requester', ['supplier'], { identityProvider: 'password', department: 'other', isActive: false }),
  account('pending-local', 'Example Pending Local', [], { employeeCode: '7100003', identityProvider: 'pcn-local', mailProfile: { ...profile, email: 'pending.local@example.test' } }),
  account('pending-source', 'Example Pending Source', [], { employeeCode: '7100004', isActive: false })
];

class UsersLists {
  constructor(page) { this.page = page; }
  row(id) { return this.page.locator(`[data-user-row="${id}"]`); }
  action(id, action) { return this.page.locator(`[data-user-id="${id}"][data-user-action="${action}"]`); }
  async counts(assigned, pending) {
    await expect(this.page.locator('#adminUsersRows tr')).toHaveCount(assigned);
    await expect(this.page.locator('#pendingUsersRows tr')).toHaveCount(pending);
    await expect(this.page.locator('#assignedUsersCount')).toContainText(String(assigned));
    await expect(this.page.locator('#pendingUsersCount')).toContainText(String(pending));
    await expect(this.page.locator('#usersFilterSummary')).toHaveText(new RegExp(`^Showing ${pending} of \\d+ pending users and ${assigned} of \\d+ assigned users\\.$`));
  }
  async clear() { await this.page.locator('#usersClearFiltersButton').click(); }
  async pendingIndicator() {
    const style = await this.page.locator('.users-group-pending').evaluate(section => {
      const heading = section.querySelector('h3');
      const marker = getComputedStyle(heading, '::before');
      const count = getComputedStyle(section.querySelector('#pendingUsersCount'));
      const table = getComputedStyle(section.querySelector('.users-table-wrap'));
      const assignedHeader = getComputedStyle(document.querySelector('#adminUsersRows').closest('table').querySelector('th'));
      return { marker: marker.backgroundColor, markerWidth: parseFloat(marker.width), markerHeight: parseFloat(marker.height),
        badge: count.backgroundColor, badgeText: count.color, border: table.borderTopColor,
        borderWidth: parseFloat(table.borderTopWidth), assignedHeader: assignedHeader.backgroundColor };
    });
    const channels = color => (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const marker = channels(style.marker);
    const badge = channels(style.badge);
    const assigned = channels(style.assignedHeader);
    assert(marker[0] >= 180 && marker[1] >= 100 && marker[2] <= 90 && style.markerWidth >= 8 && style.markerHeight >= 8,
      'Pending access has a visible yellow marker');
    assert(badge[0] >= 200 && badge[1] >= 150 && badge[2] <= badge[1] - 20, 'Pending count uses a yellow badge');
    assert.equal(style.badgeText, 'rgb(25, 44, 70)', 'Pending count retains dark readable text');
    assert.equal(style.border, style.marker, 'Pending table shares the yellow accent');
    assert(style.borderWidth >= 2 && assigned[2] > assigned[0], 'Assigned table retains its blue header');
    await expect(this.page.locator('#pendingUsersTitle')).toHaveText('Pending access');
  }
  async remove(id, accept = true) {
    this.page.once('dialog', dialog => {
      assert.match(dialog.message(), /role|access/i);
      return accept ? dialog.accept() : dialog.dismiss();
    });
    await this.action(id, 'remove').click();
  }
  async visibleActions(id, tableId) {
    const action = this.action(id, 'edit');
    await action.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
    const wrapper = this.page.locator('.users-table-wrap').filter({ has: this.page.locator(`#${tableId}`) });
    await wrapper.evaluate(node => { node.scrollLeft = 0; });
    const geometry = await action.evaluate(node => {
      const wrap = node.closest('.users-table-wrap').getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      return rect.left >= Math.max(0, wrap.left) && rect.right <= Math.min(innerWidth, wrap.right)
        && rect.top >= 0 && rect.bottom <= innerHeight
        && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') === node;
    });
    assert.equal(geometry, true, 'A row action stays visible and clickable without horizontal scrolling');
    if (this.page.viewportSize().width > 700) {
      const metrics = await action.evaluate(node => {
        const row = node.closest('tr');
        const wrap = node.closest('.users-table-wrap');
        return { departmentWidth: row.children[3].getBoundingClientRect().width,
          signInWidth: row.children[6].getBoundingClientRect().width,
          actionDisplay: getComputedStyle(row.children[7]).display,
          overflow: wrap.scrollWidth > wrap.clientWidth };
      });
      assert(metrics.departmentWidth >= 110 && metrics.signInWidth >= 110, 'Department and sign-in columns retain readable widths');
      assert.equal(metrics.actionDisplay, 'table-cell', 'Actions remain a sticky table cell');
      assert.equal(metrics.overflow, true, 'Narrow desktop tables scroll horizontally instead of crushing columns');
    }
  }
}

async function main() {
  const visualOnly = process.env.USERS_TABLE_VISUAL_ONLY === '1';
  const server = http.createServer();
  let browser;
  let context;
  let releaseRemoval = () => {};
  let holdRemoval = false;
  let rejectRemoval = null;
  let users = structuredClone(fixtures);
  const errors = [], external = [], writes = [], checks = [];
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository: memoryRepository(), authService: fakeAuthService(), rootDir, publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.tracing.start({ screenshots: true, snapshots: true });
    await fs.mkdir(path.join(rootDir, 'test-results'), { recursive: true });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.href); return route.abort(); }
      if (url.pathname === '/api/auth/config') return route.fulfill({ json: { success: true, data: { mode: 'password', employeeProvisioningConfigured: true } } });
      if (url.pathname === '/api/admin/employees') return route.fulfill({ json: { success: true, data: [] } });
      if (url.pathname === '/api/admin/directory-users') return route.fulfill({ json: { success: true, data: { users: [profile] } } });
      if (url.pathname === '/api/admin/users' && request.method() === 'GET') return route.fulfill({ json: { success: true, data: users } });
      const removal = /^\/api\/admin\/users\/([^/]+)\/roles$/.exec(url.pathname);
      const edit = /^\/api\/admin\/users\/([^/]+)$/.exec(url.pathname);
      if (removal || edit) {
        assert.equal(request.method(), removal ? 'DELETE' : 'PATCH', 'Only role revocation or account access edits are allowed');
        const id = (removal || edit)[1];
        const current = users.find(user => user.id === id);
        assert(current, 'Write targets an existing synthetic account');
        const body = request.postDataJSON();
        writes.push({ method: request.method(), path: url.pathname, body });
        assert.equal(body.version, current.version);
        if (removal) {
          assert.deepEqual(Object.keys(body), ['version']);
          if (holdRemoval) { holdRemoval = false; await new Promise(resolve => { releaseRemoval = resolve; }); }
          if (rejectRemoval) {
            const rejected = rejectRemoval;
            rejectRemoval = null;
            return route.fulfill({ status: rejected.status, json: { success: false, error: rejected.message } });
          }
        }
        const nextVersion = (BigInt(`0x${current.version}`) + 1n).toString(16).padStart(16, '0');
        const saved = removal ? { ...current, roles: [], department: null, signingStep: null, version: nextVersion }
          : { ...current, ...body, version: nextVersion };
        users = users.map(user => user.id === id ? saved : user);
        return route.fulfill({ json: { success: true, data: saved } });
      }
      return route.continue();
    });
    const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username: 'admin', password: TEST_PASSWORD } });
    assert.equal(login.status(), 200);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/admin#users`);
    const ui = new UsersLists(page);
    await ui.counts(4, 2);
    await expect(page.locator('#usersFilterSummary')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#usersFilterSummary')).toHaveAttribute('aria-atomic', 'true');
    await expect(ui.action('pending-local', 'edit')).toHaveText('Add role');
    await expect(ui.action('source-signer', 'edit')).toHaveText('Edit');
    await expect(ui.action('pending-local', 'remove')).toHaveCount(0);
    await expect(page.locator('#pendingUsersRows')).toContainText('Example Pending Source');
    await expect(page.locator('#adminUsersRows')).toContainText('Example Legacy Requester');
    checks.push('assigned-and-pending-split-including-inactive-legacy');

    for (const query of ['7100001', 'EXAMPLE SOURCE', 'SOURCE.SIGNER@EXAMPLE.TEST']) {
      await page.locator('#usersSearchFilter').fill(query);
      await ui.counts(1, 0);
      await expect(page.locator('#adminUsersRows')).toContainText('Example Source Signer');
      await expect(page.locator('#pendingUsersEmpty')).toBeVisible();
    }
    await ui.clear();
    await page.locator('#usersRoleFilter').selectOption('checked');
    await page.locator('#usersDepartmentFilter').selectOption('qaTet');
    await page.locator('#usersStatusFilter').selectOption('active');
    await ui.counts(1, 0);
    await page.locator('#usersSearchFilter').fill('No such fixture');
    await ui.counts(0, 0);
    await expect(page.locator('#assignedUsersEmpty')).toBeVisible();
    await expect(page.locator('#pendingUsersEmpty')).toBeVisible();
    await ui.clear();
    await ui.counts(4, 2);
    await page.locator('#usersStatusFilter').selectOption('inactive');
    await ui.counts(1, 1);
    await ui.clear();
    checks.push('case-insensitive-code-name-email-and-combined-role-department-status-filters');

    for (const [label, viewport] of [['desktop', { width: 995, height: 802 }], ['mobile', { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Users filters and tables fit the viewport');
      await ui.pendingIndicator();
      await ui.visibleActions('source-signer', 'adminUsersRows');
      await ui.visibleActions('pending-local', 'pendingUsersRows');
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(rootDir, `test-results/users-split-${label}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 995, height: 802 });
    checks.push('desktop-mobile-filters-and-actions-visible-with-scrollable-tables');
    checks.push('pending-yellow-indicator-count-and-table-accent-assigned-blue-preserved');
    if (visualOnly) {
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(JSON.stringify({ browser: 'passed', checks, writes: 0, storage: 'isolated_test_adapters', mode: 'visual_only' }));
      return;
    }

    await ui.remove('source-signer', false);
    assert.equal(writes.length, 0, 'Cancelling role removal sends no request');
    await ui.counts(4, 2);
    rejectRemoval = { status: 409, message: 'Fixture account changed; refresh users' };
    await ui.remove('source-signer');
    await expect(page.locator('#usersMessage')).toContainText(/changed|refresh/i);
    await ui.counts(4, 2);
    await expect(ui.action('source-signer', 'remove')).toBeEnabled();
    rejectRemoval = { status: 403, message: 'Fixture caller cannot remove these roles' };
    await ui.remove('local-signer');
    await expect(page.locator('#usersMessage')).toContainText('Fixture caller cannot remove these roles');
    await ui.counts(4, 2);
    rejectRemoval = { status: 409, message: 'Cannot remove the last active administrator' };
    await ui.remove('fixture-admin');
    await expect(page.locator('#usersMessage')).toContainText('administrator');
    await ui.counts(4, 2);
    checks.push('remove-cancel-conflict-caller-denial-last-admin-preserve-rows');

    const beforeSource = structuredClone(users.find(user => user.id === 'source-signer'));
    holdRemoval = true;
    await ui.remove('source-signer');
    await expect(ui.action('source-signer', 'remove')).toBeDisabled();
    await ui.counts(4, 2);
    releaseRemoval();
    await ui.counts(3, 3);
    await expect(ui.action('source-signer', 'edit')).toBeFocused();
    await expect(page.locator('#pendingUsersRows')).toContainText('Example Source Signer');
    const source = users.find(user => user.id === 'source-signer');
    assert.deepEqual(source, { ...beforeSource, roles: [], department: null, signingStep: null, version: '0000000000000002' });
    assert.deepEqual(writes[3], { method: 'DELETE', path: '/api/admin/users/source-signer/roles', body: { version } });
    checks.push('confirmed-role-removal-waits-server-then-moves-to-pending-preserving-account');

    await ui.action('source-signer', 'edit').click();
    await expect(page.locator('#employeeUserDialog')).toBeVisible();
    await page.locator('#employeeRole').selectOption('approved');
    await page.locator('#employeeDepartment').selectOption('qaTet');
    await page.locator('#employeeCreateButton').click();
    await expect(page.locator('#employeeUserDialog')).toBeHidden();
    await ui.counts(4, 2);
    await expect(ui.action('source-signer', 'edit')).toBeFocused();
    assert.deepEqual(writes[4], { method: 'PATCH', path: '/api/admin/users/source-signer', body: { roles: ['qa'], department: 'qaTet', signingStep: 'approved', isActive: true, version: '0000000000000002' } });
    checks.push('pending-add-role-patch-reassigns-with-current-version-and-focus');

    for (const [id, assigned, pending] of [['local-signer', 3, 3], ['legacy-requester', 2, 4]]) {
      const before = structuredClone(users.find(user => user.id === id));
      await ui.remove(id);
      await ui.counts(assigned, pending);
      await expect(ui.action(id, 'edit')).toBeFocused();
      assert.deepEqual(users.find(user => user.id === id), { ...before, roles: [], department: null, signingStep: null, version: '0000000000000002' });
    }
    await page.locator('#usersRoleFilter').selectOption('unassigned');
    await ui.counts(0, 4);
    await ui.action('local-signer', 'edit').click();
    await page.locator('#employeeRole').selectOption('checked');
    await page.locator('#employeeDepartment').selectOption('gscTet');
    await page.locator('#employeeCreateButton').click();
    await expect(page.locator('#employeeUserDialog')).toBeHidden();
    await ui.counts(0, 3);
    await expect(page.locator('#usersMessage')).toBeFocused();
    assert.deepEqual(writes[7], { method: 'PATCH', path: '/api/admin/users/local-signer', body: {
      roles: ['gsc'], department: 'gscTet', signingStep: 'checked', isActive: true, version: '0000000000000002'
    } });
    await ui.clear();
    await ui.counts(3, 3);
    await page.locator('#usersRoleFilter').selectOption('approved');
    await ui.counts(1, 0);
    await ui.remove('source-signer');
    await ui.counts(0, 0);
    await expect(page.locator('#usersMessage')).toBeFocused();
    assert.deepEqual(writes[8], { method: 'DELETE', path: '/api/admin/users/source-signer/roles', body: { version: '0000000000000003' } });
    await ui.clear();
    await ui.counts(2, 4);
    checks.push('filtered-reassignment-and-removal-restore-safe-focus-and-summary');
    await page.evaluate(() => {
      document.querySelectorAll('.users-table-wrap').forEach(node => { node.scrollLeft = 0; });
      scrollTo(0, 0);
    });
    await page.screenshot({ path: path.join(rootDir, 'test-results/users-role-removal-pending.png'), fullPage: true });
    assert.equal(users.length, fixtures.length, 'Role removal never deletes accounts');
    assert.equal(writes.length, 9);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    checks.push('pcn-local-and-legacy-revocation-retains-provider-mail-and-active-status');
    console.log(JSON.stringify({ browser: 'passed', checks, writes: writes.length, storage: 'isolated_test_adapters' }));
  } finally {
    releaseRemoval();
    if (context) {
      await context.tracing.stop({ path: path.join(rootDir, visualOnly ? 'test-results/users-table-visual-trace.zip' : 'test-results/users-table-trace.zip') });
      await context.close();
    }
    if (browser) await browser.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
