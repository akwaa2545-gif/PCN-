// Isolated user popup journeys: no SQL, employee directory, or Power Automate connection.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { memoryRepository, fakeAuthService, TEST_PASSWORD } = require('../test/helpers/apiHarness');

const rootDir = path.resolve(__dirname, '..');
// Synthetic silhouette; no employee photo is used by this fixture.
const PROFILE_PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAA30lEQVR4nO3XOw7DMAwEUXe5V+6Vq/oE6dOmDmLAJLXSgvYArKV5jT7b/v60ns1eAMBdAMBdAMBdAMBdAMBdAGDOuo/n6396AA7T5zHEgNN6uUEJCNZrDTJAql5o0AAK9SoDgIF6iQEAAAAA2gPa3wNXALR/CxUMqk35D+QN2u34E7sHgHsA/E7jY7TxTVx+CEkYQ4DBdAmjDhDWjxiKAHl92VABTKqvGdKAqfUFQw6woD5rSACW1acMUcDi+rjhHgBLfdBwA4CxPmK4OsBef2oAAGAiwN4dMQAAAKA54AuP+NHRJaqYQwAAAABJRU5ErkJggg==';
const employee = { employeeCode: '8000001', displayName: 'Example Employee', englishName: 'Example Employee', sourceDepartment: 'Engineering', jobTitle: 'Engineer' };
const mail = { id: 'fixture-mail', email: 'example.employee@example.test', displayName: 'Example Employee', department: 'Engineering', jobTitle: 'Engineer', photo: PROFILE_PHOTO };
const viewerMail = { ...mail, id: 'viewer-profile', email: 'viewer@example.test', displayName: 'Example Viewer' };
const signerMail = { ...mail, id: 'signer-profile', email: 'signer@example.test', displayName: 'Example Signer' };
const manualMail = { ...mail, id: 'manual-profile', email: 'manual@example.test', displayName: 'Manual Example Employee' };
const account = (id, displayName, extras = {}) => ({ id, displayName, username: id, roles: [], department: 'qaTet', signingStep: null, email: null, mailProfile: null, isActive: true, version: '0000000000000001', identityProvider: 'employee-code', ...extras });

class UserDialog {
  constructor(page) { this.page = page; this.dialog = page.locator('#employeeUserDialog'); }
  async open() {
    await this.page.locator('#usersAddRoleButton').focus();
    await this.page.keyboard.press('Enter');
    await expect(this.dialog).toBeVisible();
    await expect(this.page.locator('#employeeSearch')).toBeFocused();
  }
  async openManual() {
    await this.page.locator('#usersCreateButton').focus();
    await this.page.keyboard.press('Enter');
    await expect(this.dialog).toBeVisible();
    await expect(this.page.locator('#employeeManualCode')).toBeFocused();
  }
  async selectEmployee() {
    await this.page.locator('#employeeSearch').fill(employee.displayName);
    await this.page.locator('#employeeResults button').first().click();
    await expect(this.page.locator('#employeeCode')).toHaveValue(employee.employeeCode);
  }
  async signingAssignment() {
    await this.page.locator('#employeeRole').selectOption('checked');
    await this.page.locator('#employeeDepartment').selectOption('qaTet');
    await this.page.locator('#employeeMailResults button').first().click();
    await expect(this.page.locator('#employeeCreateButton')).toBeEnabled();
  }
  async closed(opener = '#usersAddRoleButton') {
    await expect(this.dialog).toBeHidden();
    await expect(this.page.locator(opener)).toBeFocused();
  }
  async fit() {
    assert.equal(await this.dialog.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && node.scrollWidth <= node.clientWidth;
    }), true, 'Popup fits the viewport without horizontal clipping');
  }
  async trap() {
    await this.page.locator('#employeeDialogCloseButton').focus();
    await this.page.keyboard.press('Shift+Tab');
    assert.equal(await this.dialog.evaluate(node => node.contains(document.activeElement)), true, 'Reverse Tab stays inside the popup');
    for (let index = 0; index < 12; index += 1) {
      await this.page.keyboard.press('Tab');
      assert.equal(await this.dialog.evaluate(node => node.contains(document.activeElement)), true, 'Tab stays inside the popup');
    }
  }
  async unchangedSize(before) {
    const current = await this.dialog.boundingBox();
    assert(Math.abs(current.width - before.width) <= 1 && Math.abs(current.height - before.height) <= 1,
      'Employee and mail search states preserve the popup dimensions');
  }
  async desktopFormFits() {
    const geometry = await this.dialog.evaluate(dialog => {
      const body = dialog.querySelector('.employee-dialog-body');
      const bodyRect = body.getBoundingClientRect();
      const fields = ['employeeSearch', 'employeeCode', 'employeeManualCode', 'employeeManualName', 'employeeRole', 'employeeDepartment', 'employeeMailSearch',
        'employeeMailLoading', 'employeeMailSelected', 'employeeRoutePreview'];
      const clipped = fields.filter(id => {
        const node = document.getElementById(id);
        if (!node || !node.getClientRects().length) return false;
        const rect = node.getBoundingClientRect();
        return rect.top < bodyRect.top - 1 || rect.bottom > bodyRect.bottom + 1
          || rect.left < bodyRect.left - 1 || rect.right > bodyRect.right + 1;
      });
      const footerFits = ['employeeCancelButton', 'employeeCreateButton'].every(id => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
      });
      return { clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, clipped, footerFits };
    });
    assert.equal(geometry.scrollHeight <= geometry.clientHeight + 1 && geometry.clipped.length === 0 && geometry.footerFits,
      true, `Desktop form fields and footer fit without body scrolling: ${JSON.stringify(geometry)}`);
  }
  async scrollResultsToEnd(results) {
    assert.equal(await results.evaluate(node => {
      const style = getComputedStyle(node);
      const firstTwo = [...node.querySelectorAll('button')].slice(0, 2);
      const readableHeight = firstTwo.reduce((height, button) => height + button.getBoundingClientRect().height, 0)
        + (parseFloat(style.rowGap) || 0);
      return node.clientHeight >= Math.max(100, readableHeight) && node.scrollHeight > node.clientHeight
        && ['auto', 'scroll'].includes(style.overflowY);
    }), true, 'Long result lists show at least two full rows and scroll inside the popup');
    await results.evaluate(node => { node.scrollTop = node.scrollHeight; });
    assert.equal(await results.evaluate(node => node.scrollTop > 0), true, 'Result list can scroll to its bottom');
    await results.locator('button').last().click();
  }
}

async function main() {
  const baseline = process.env.USER_DIALOG_E2E_BASELINE === '1'
    ? Object.fromEntries(['admin.html', 'admin-users.js', 'admin.css'].map(file => [file, execFileSync('git', ['show', `HEAD:${file}`], { cwd: rootDir, encoding: 'utf8' })])) : null;
  const server = http.createServer();
  let browser;
  let context;
  let release = () => {};
  let releaseSearch = () => {};
  let directoryResponses = {};
  let employeeResponses = {};
  const directoryFixture = (query, { status = 200, profiles = [mail], held = false } = {}) => {
    let releaseLookup = () => {};
    const pending = held ? new Promise(resolve => { releaseLookup = resolve; }) : Promise.resolve();
    directoryResponses = { ...directoryResponses, [query]: { status, profiles, pending, release: releaseLookup } };
    return releaseLookup;
  };
  const errors = [], external = [], writes = [], checks = [];
  let users = [account('roleless', 'Example Viewer'), account('signer', 'Example Signer', { roles: ['qa'], signingStep: 'approved', mailProfile: signerMail }), account('legacy', 'Example Administrator', { roles: ['admin'], department: 'it', identityProvider: 'password' })];
  let rejectNext = false;
  let holdNext = false;
  let holdSearch = false;
  let rejectNextManual = false;
  let sourceConfigured = true;
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
      const asset = url.pathname === '/admin' ? 'admin.html' : url.pathname.slice(1);
      if (baseline?.[asset]) return route.fulfill({ contentType: asset.endsWith('.html') ? 'text/html' : asset.endsWith('.css') ? 'text/css' : 'application/javascript', body: baseline[asset] });
      if (url.pathname === '/api/auth/config') return route.fulfill({ json: { success: true, data: { mode: 'password', employeeProvisioningConfigured: sourceConfigured } } });
      if (url.pathname === '/api/admin/employees') {
        if (holdSearch) { holdSearch = false; await new Promise(resolve => { releaseSearch = resolve; }); }
        return route.fulfill({ json: { success: true, data: employeeResponses[url.searchParams.get('query')] || [employee] } });
      }
      if (url.pathname === '/api/admin/directory-users') {
        const fixture = directoryResponses[url.searchParams.get('query')];
        if (fixture) await fixture.pending;
        return route.fulfill({ status: fixture?.status || 200, json: fixture?.status >= 400
          ? { success: false, error: 'Fixture mail directory unavailable' }
          : { success: true, data: { users: fixture?.profiles || [mail] } } });
      }
      if (url.pathname.startsWith('/api/admin/users') || url.pathname === '/api/admin/local-users') {
        if (request.method() === 'GET') return route.fulfill({ json: { success: true, data: users } });
        const body = request.postDataJSON();
        if (url.pathname === '/api/admin/local-users') {
          assert.equal(request.method(), 'POST');
          assert.deepEqual(Object.keys(body).sort(), ['department', 'displayName', 'employeeCode', 'mailSelection', 'roles', 'signingStep']);
        }
        writes.push({ method: request.method(), path: url.pathname, body });
        if (rejectNextManual && url.pathname === '/api/admin/local-users') {
          rejectNextManual = false;
          return route.fulfill({ status: 503, json: { success: false, error: 'Fixture local user save rejected' } });
        }
        if (holdNext) { holdNext = false; await new Promise(resolve => { release = resolve; }); }
        if (rejectNext) { rejectNext = false; return route.fulfill({ status: 409, json: { success: false, error: 'Fixture version conflict' } }); }
        const target = users.find(user => url.pathname === `/api/admin/users/${user.id}` || url.pathname === `/api/admin/users/${user.id}/employee`);
        const selectedMail = body.mailSelection ? Object.values(directoryResponses).flatMap(response => response.profiles)
          .find(candidate => candidate.id === body.mailSelection.id && candidate.email === body.mailSelection.email) || mail : null;
        if (selectedMail) assert.equal(users.some(user => user.id !== target?.id && user.mailProfile?.email === selectedMail.email), false,
          'Verified email is unique to the selected synthetic account');
        const saved = target ? { ...target, ...body, mailProfile: selectedMail || target.mailProfile,
          identityProvider: url.pathname.endsWith('/employee') ? 'employee-code' : target.identityProvider, version: '0000000000000002' }
          : url.pathname === '/api/admin/local-users'
            ? account('manual-created', body.displayName, { ...body, username: body.employeeCode, identityProvider: 'pcn-local', mailProfile: selectedMail })
            : account('created', employee.displayName, { ...employee, ...body, mailProfile: mail });
        users = target ? users.map(user => user.id === target.id ? saved : user) : [...users, saved];
        return route.fulfill({ status: target ? 200 : 201, json: { success: true, data: saved } });
      }
      return route.continue();
    });
    const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username: 'admin', password: TEST_PASSWORD } });
    assert.equal(login.status(), 200);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/admin#users`);
    await expect(page.locator('#usersMessage')).toContainText('3 user accounts');
    const ui = new UserDialog(page);
    await expect(page.locator('#employeeUserForm')).toBeHidden();
    await expect(page.locator('#adminUsersRows')).toBeVisible();
    checks.push('initial-form-hidden-list-visible');
    await ui.open();
    await ui.fit();
    await page.screenshot({ path: path.join(rootDir, 'test-results/user-dialog-desktop.png'), fullPage: true });
    await ui.trap();
    await ui.selectEmployee();
    await expect(page.locator('#employeeMailResults')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(ui.dialog).toBeVisible();
    await expect(page.locator('#employeeMailResults')).toBeHidden();
    await expect(page.locator('#employeeMailSearch')).toBeFocused();
    await page.keyboard.press('Escape');
    await ui.closed();
    await ui.open();
    await expect(page.locator('#employeeSearch')).toHaveValue('');
    await expect(page.locator('#employeeCode')).toHaveValue('');
    await expect(page.locator('#employeeResults')).toBeHidden();
    await expect(page.locator('#employeeCreateButton')).toBeDisabled();
    await page.locator('#employeeDialogCloseButton').click();
    await ui.closed();
    await ui.open();
    await page.mouse.click(2, 2);
    await ui.closed();
    checks.push('keyboard-trap-escape-close-backdrop-draft-reset');

    await ui.open();
    holdSearch = true;
    const searchStarted = page.waitForRequest(request => new URL(request.url()).pathname === '/api/admin/employees');
    const searchAborted = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/api/admin/employees' });
    await page.locator('#employeeSearch').fill(employee.displayName);
    await searchStarted;
    await page.locator('#employeeCancelButton').click();
    await searchAborted;
    releaseSearch();
    await ui.closed();
    await ui.open();
    await expect(page.locator('#employeeResults')).toBeHidden();
    await expect(page.locator('#employeeDialogMessage')).toBeEmpty();
    await page.locator('#employeeCancelButton').click();
    checks.push('dismiss-aborts-inflight-employee-search');

    await ui.open();
    const releaseAutomaticMail = directoryFixture(employee.englishName, { held: true, profiles: [mail,
      { ...mail, id: 'fixture-initials', email: 'initials@example.test', displayName: 'Initials Person', photo: '' }] });
    await ui.selectEmployee();
    const loading = page.locator('#employeeMailLoading');
    const mailResults = page.locator('#employeeMailResults');
    await expect(loading).toBeVisible();
    await expect(loading.locator('.employee-mail-spinner')).toBeVisible();
    await expect(loading.locator('.employee-mail-loading-avatar svg')).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => loading.locator('.employee-mail-spinner').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
    await expect(loading).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.locator('#employeeMailLoadingText')).toContainText(/searching|looking/i);
    await expect(mailResults).toHaveAttribute('aria-busy', 'true');
    await ui.fit();
    await page.screenshot({ path: path.join(rootDir, 'test-results/user-mail-loading-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await loading.scrollIntoViewIfNeeded();
    await ui.fit();
    await page.screenshot({ path: path.join(rootDir, 'test-results/user-mail-loading-mobile.png') });
    releaseAutomaticMail();
    await expect(loading).toBeHidden();
    await expect(mailResults).toHaveAttribute('aria-busy', 'false');
    await expect(mailResults.locator('.employee-mail-result')).toHaveCount(2);
    await expect(mailResults.locator('.employee-mail-result').nth(1).locator('.notification-person-avatar')).toHaveText('I');
    const profileResult = mailResults.locator('.employee-mail-result').first();
    await expect(profileResult.locator('.employee-user-identity')).toContainText(mail.displayName);
    await expect(profileResult).toContainText(mail.email);
    await expect(profileResult).toContainText('Engineer - Engineering');
    await expect(profileResult.locator('.notification-person-avatar img')).toHaveAttribute('src', PROFILE_PHOTO);
    await expect.poll(() => profileResult.locator('img').evaluate(photo => photo.complete && photo.naturalWidth > 0)).toBe(true);
    await profileResult.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(rootDir, 'test-results/user-mail-profile-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(rootDir, 'test-results/user-mail-profile-desktop.png') });
    await profileResult.click();
    await expect(page.locator('#employeeMailSelected')).toContainText(mail.email);
    checks.push('mail-loading-desktop-mobile-verified-profile-result-selection');

    const waitForMail = query => page.waitForRequest(request => new URL(request.url()).pathname === '/api/admin/directory-users'
      && new URL(request.url()).searchParams.get('query') === query);
    const olderQuery = 'Older lookup';
    const newerQuery = 'Newer lookup';
    const releaseOlder = directoryFixture(olderQuery, { held: true });
    const releaseNewer = directoryFixture(newerQuery, { held: true, profiles: [{ ...mail, displayName: 'Current Lookup Person' }] });
    const olderStarted = waitForMail(olderQuery);
    await page.locator('#employeeMailSearch').fill(olderQuery);
    await olderStarted;
    await expect(loading).toBeVisible();
    const olderAborted = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).searchParams.get('query') === olderQuery });
    const newerStarted = waitForMail(newerQuery);
    await page.locator('#employeeMailSearch').fill(newerQuery);
    await olderAborted;
    await newerStarted;
    releaseOlder();
    await expect(loading).toBeVisible();
    await expect(mailResults).toHaveAttribute('aria-busy', 'true');
    releaseNewer();
    await expect(loading).toBeHidden();
    await expect(mailResults).toContainText('Current Lookup Person');
    await expect(mailResults).toHaveAttribute('aria-busy', 'false');
    checks.push('superseded-mail-search-aborts-current-loading-finishes');

    directoryFixture('No matching profile', { profiles: [] });
    await page.locator('#employeeMailSearch').fill('No matching profile');
    await expect(page.locator('#employeeMailStatus')).toContainText('No matching mail recipient');
    await expect(loading).toBeHidden();
    await expect(mailResults).toHaveAttribute('aria-busy', 'false');
    directoryFixture('Directory failure', { status: 503 });
    await page.locator('#employeeMailSearch').fill('Directory failure');
    await expect(page.locator('#employeeMailStatus')).toContainText('Fixture mail directory unavailable');
    await expect(loading).toBeHidden();
    await expect(mailResults).toHaveAttribute('aria-busy', 'false');
    const releaseDismissed = directoryFixture('Dismiss pending profile', { held: true });
    const dismissedStarted = waitForMail('Dismiss pending profile');
    const dismissedAborted = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).searchParams.get('query') === 'Dismiss pending profile' });
    await page.locator('#employeeMailSearch').fill('Dismiss pending profile');
    await dismissedStarted;
    await expect(loading).toBeVisible();
    await page.locator('#employeeCancelButton').click();
    await dismissedAborted;
    releaseDismissed();
    await ui.closed();
    await expect(loading).toBeHidden();
    await expect(mailResults).toHaveAttribute('aria-busy', 'false');
    await ui.open();
    await expect(loading).toBeHidden();
    await expect(mailResults).toBeHidden();
    await page.locator('#employeeCancelButton').click();
    assert.equal(writes.length, 0, 'Mail lookup and cancellation perform no user writes');
    checks.push('empty-failed-dismissed-mail-lookup-clears-spinner');

    employeeResponses = { ...employeeResponses, 'Many employees': Array.from({ length: 20 }, (_, index) => index === 19
      ? employee : { ...employee, employeeCode: `810${String(index + 1).padStart(4, '0')}`, displayName: `Directory Employee ${index + 1}` }) };
    const manyProfiles = Array.from({ length: 20 }, (_, index) => ({ ...mail, id: `fixture-many-${index + 1}`,
      email: `directory.person${index + 1}@example.test`, displayName: `Directory Person ${index + 1}` }));
    for (const [label, viewport] of [['desktop-reference', { width: 995, height: 802 }],
      ['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport);
      await ui.open();
      const before = await ui.dialog.boundingBox();
      const desktop = viewport.width >= 900;
      if (desktop) {
        await ui.desktopFormFits();
        await page.screenshot({ path: path.join(rootDir, `test-results/user-full-form-empty-${label}.png`) });
      }
      await page.locator('#employeeSearch').fill('Many employees');
      await ui.unchangedSize(before);
      if (desktop) await ui.desktopFormFits();
      const employeeResults = page.locator('#employeeResults');
      await expect(employeeResults.locator('button')).toHaveCount(20);
      await ui.unchangedSize(before);
      await ui.fit();
      if (desktop) await ui.desktopFormFits();
      await employeeResults.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(rootDir, `test-results/user-employee-results-scroll-${label}.png`) });
      const releaseManyProfiles = directoryFixture(employee.englishName, { held: true, profiles: manyProfiles });
      await ui.scrollResultsToEnd(employeeResults);
      await expect(page.locator('#employeeCode')).toHaveValue(employee.employeeCode);
      await expect(loading).toBeVisible();
      await ui.unchangedSize(before);
      if (desktop) {
        await ui.desktopFormFits();
        await page.screenshot({ path: path.join(rootDir, `test-results/user-full-form-loading-${label}.png`) });
      }
      releaseManyProfiles();
      await expect(mailResults.locator('button')).toHaveCount(20);
      await expect(loading).toBeHidden();
      assert.equal(await mailResults.evaluate(node => node.scrollWidth <= node.clientWidth
        && [...node.querySelectorAll('.employee-mail-result')].every(button => {
          const card = button.getBoundingClientRect();
          const identity = button.querySelector('.employee-user-identity').getBoundingClientRect();
          return identity.top >= card.top && identity.bottom <= card.bottom;
        })), true, 'Profile cards retain their full avatar and text inside scrollable results');
      await ui.unchangedSize(before);
      await ui.fit();
      if (desktop) await ui.desktopFormFits();
      await mailResults.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(rootDir, `test-results/user-mail-results-scroll-${label}.png`) });
      await ui.scrollResultsToEnd(mailResults);
      await expect(page.locator('#employeeMailSelected')).toContainText(manyProfiles[19].email);
      await ui.unchangedSize(before);
      if (desktop) {
        await page.locator('#employeeRole').selectOption('checked');
        await page.locator('#employeeDepartment').selectOption('qaTet');
        await expect(page.locator('#employeeCreateButton')).toBeEnabled();
        await ui.desktopFormFits();
        await page.screenshot({ path: path.join(rootDir, `test-results/user-full-form-selected-${label}.png`) });
      }
      await page.locator('#employeeCancelButton').click();
      await ui.closed();
    }
    directoryFixture(employee.englishName);
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(writes.length, 0, 'Scrollable result selection performs no user writes');
    checks.push('twenty-employee-and-profile-results-scroll-stable-popup-desktop-mobile');
    checks.push('full-desktop-form-no-body-scroll-995x802-and-1440x1000');

    await ui.open();
    await ui.selectEmployee();
    await ui.signingAssignment();
    await page.locator('#employeeCreateButton').click();
    await ui.closed();
    assert.deepEqual(writes, [{ method: 'POST', path: '/api/admin/users', body: { employeeCode: employee.employeeCode, roles: ['qa'], department: 'qaTet', signingStep: 'checked', mailSelection: { id: mail.id, email: mail.email } } }]);
    await expect(page.locator('#adminUsersRows')).toContainText(employee.displayName);
    checks.push('selected-employee-verified-mail-single-create-focus-restored');

    const viewerEdit = page.locator('#pendingUsersRows [data-user-id="roleless"][data-user-action="edit"]');
    directoryFixture('Example Viewer', { profiles: [viewerMail] });
    directoryFixture('typed@example.test', { profiles: [viewerMail] });
    await viewerEdit.click();
    await expect(ui.dialog).toBeVisible();
    await expect(page.locator('#employeeSearch')).toBeDisabled();
    await expect(page.locator('#employeeCreateButton')).toBeDisabled();
    await page.locator('#employeeMailSearch').fill('typed@example.test');
    await mailResults.locator('button').first().waitFor();
    await expect(page.locator('#employeeCreateButton')).toBeDisabled();
    await mailResults.locator('button').first().click();
    await expect(page.locator('#employeeCreateButton')).toBeDisabled();
    await expect(page.locator('#employeeRole')).toHaveValue('');
    await page.locator('#employeeRole').selectOption('checked');
    await page.locator('#employeeDepartment').selectOption('qaTet');
    await expect(page.locator('#employeeCreateButton')).toBeEnabled();
    await page.locator('#employeeActive').uncheck();
    await page.locator('#employeeCreateButton').click();
    await expect(ui.dialog).toBeHidden();
    await expect(page.locator('#adminUsersRows [data-user-id="roleless"][data-user-action="edit"]')).toBeFocused();
    assert.deepEqual(writes[1].body, { roles: ['qa'], department: 'qaTet', signingStep: 'checked',
      mailSelection: { id: viewerMail.id, email: viewerMail.email }, isActive: false, version: '0000000000000001' });
    checks.push('pending-add-role-requires-explicit-role-grant-and-moves-to-assigned');
    checks.push('edit-missing-and-unselected-mail-blocks-save-confirmed-directory-profile-allows-save');

    const signerEdit = page.locator('#adminUsersRows [data-user-id="signer"][data-user-action="edit"]');
    await signerEdit.click();
    await expect(page.locator('#employeeCreateButton')).toBeEnabled();
    await page.locator('#employeeMailSearch').fill('unconfirmed@example.test');
    await mailResults.locator('button').first().waitFor();
    await expect(page.locator('#employeeCreateButton')).toBeDisabled();
    await page.locator('#employeeCancelButton').click();
    await expect(ui.dialog).toBeHidden();
    await expect(signerEdit).toBeFocused();
    await signerEdit.click();
    await expect(page.locator('#employeeCreateButton')).toBeEnabled();
    checks.push('edit-retained-verified-mail-allowed-typing-invalidates-until-confirmed');
    await page.locator('#employeeRole').selectOption('prepared');
    rejectNext = true;
    await page.locator('#employeeCreateButton').click();
    await expect(page.locator('#employeeDialogMessage')).toContainText('Your edit is kept');
    await expect(ui.dialog).toBeVisible();
    await expect(page.locator('#employeeRole')).toHaveValue('prepared');
    assert.equal(writes.length, 3);
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.fit();
    await page.screenshot({ path: path.join(rootDir, 'test-results/user-dialog-mobile-error.png') });
    await page.locator('#employeeCancelButton').click();
    await expect(ui.dialog).toBeHidden();
    await expect(signerEdit).toBeFocused();
    await signerEdit.click();
    await expect(page.locator('#employeeDialogMessage')).toBeEmpty();
    await expect(page.locator('#employeeRole')).toHaveValue('approved');
    await page.locator('#employeeRole').selectOption('prepared');
    holdNext = true;
    await page.locator('#employeeCreateButton').click();
    await expect(page.locator('#employeeCreateButton')).toBeDisabled();
    await expect(page.locator('#employeeCancelButton')).toBeDisabled();
    await expect(page.locator('#employeeDialogCloseButton')).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
    await expect(ui.dialog).toBeVisible();
    assert.equal(writes.length, 4, 'Pending save has exactly one request');
    release();
    await expect(ui.dialog).toBeHidden();
    await expect(signerEdit).toBeFocused();
    assert.deepEqual(writes[3].body, { roles: ['qa'], department: 'qaTet', signingStep: 'prepared', isActive: true, version: '0000000000000001' });
    checks.push('conflict-local-error-keeps-draft-mobile-fit-pending-dismissal-blocked');

    await page.setViewportSize({ width: 1440, height: 1000 });
    const link = page.getByRole('button', { name: 'Link employee to Example Administrator', exact: true });
    await link.click();
    await expect(ui.dialog).toBeVisible();
    await expect(page.locator('#employeeAssignments')).toBeHidden();
    await ui.selectEmployee();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#employeeCreateButton').click();
    await expect(ui.dialog).toBeHidden();
    await expect(page.locator('#adminUsersRows [data-user-id="legacy"][data-user-action="edit"]')).toBeFocused();
    assert.deepEqual(writes[4], { method: 'POST', path: '/api/admin/users/legacy/employee', body: { employeeCode: employee.employeeCode } });
    assert.deepEqual(users.find(user => user.id === 'legacy').roles, ['admin']);
    checks.push('link-popup-preserves-permissions-row-focus');
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open();
    await ui.fit();
    await ui.trap();
    await page.screenshot({ path: path.join(rootDir, 'test-results/user-dialog-mobile.png') });
    await page.locator('#employeeCancelButton').click();
    await ui.closed();
    assert.equal(writes.length, 5);

    const manualName = 'Manual Example Employee';
    const manualCode = '9000001';
    await page.setViewportSize({ width: 995, height: 802 });
    await ui.openManual();
    await expect(page.locator('#employeeSearch')).toBeHidden();
    await page.locator('#employeeRole').selectOption('admin');
    await page.locator('#employeeDepartment').selectOption('it');
    await page.locator('#employeeManualCode').fill('900001');
    await page.locator('#employeeManualName').fill(manualName);
    await expect(page.locator('#employeeCreateButton')).toBeDisabled();
    await page.locator('#employeeManualCode').fill(manualCode);
    await page.locator('#employeeManualName').fill('');
    await expect(page.locator('#employeeCreateButton')).toBeDisabled();
    await page.locator('#employeeManualName').fill('   ');
    await expect(page.locator('#employeeCreateButton')).toBeDisabled();
    await page.locator('#employeeCancelButton').click();
    await ui.closed('#usersCreateButton');
    await ui.openManual();
    await expect(page.locator('#employeeManualCode')).toHaveValue('');
    await expect(page.locator('#employeeManualName')).toHaveValue('');
    await page.locator('#employeeManualCode').fill(manualCode);
    await page.locator('#employeeManualName').fill(manualName);
    await page.locator('#employeeRole').selectOption('checked');
    await page.locator('#employeeDepartment').selectOption('qaTet');
    await expect(page.locator('#employeeCreateButton')).toBeDisabled();
    const releaseManualMail = directoryFixture(manualName, { held: true, profiles: [manualMail] });
    const manualMailStarted = waitForMail(manualName);
    await page.locator('#employeeMailSearch').fill(manualName);
    await manualMailStarted;
    await expect(loading).toBeVisible();
    await ui.desktopFormFits();
    await ui.fit();
    await page.screenshot({ path: path.join(rootDir, 'test-results/user-manual-loading-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await loading.scrollIntoViewIfNeeded();
    await ui.fit();
    await page.screenshot({ path: path.join(rootDir, 'test-results/user-manual-loading-mobile.png') });
    const manualMailAborted = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).searchParams.get('query') === manualName });
    await page.locator('#employeeCancelButton').click();
    await manualMailAborted;
    releaseManualMail();
    await ui.closed('#usersCreateButton');
    await expect(loading).toBeHidden();
    assert.equal(writes.length, 5, 'Invalid manual drafts and cancellation perform no writes');
    checks.push('manual-seven-digit-code-name-validation-cancel-loading-desktop-mobile');

    directoryFixture(manualName, { profiles: [manualMail] });
    await page.setViewportSize({ width: 995, height: 802 });
    await ui.openManual();
    await page.locator('#employeeManualCode').fill(manualCode);
    await page.locator('#employeeManualName').fill(manualName);
    await page.locator('#employeeRole').selectOption('checked');
    await page.locator('#employeeDepartment').selectOption('qaTet');
    await page.locator('#employeeMailSearch').fill(manualName);
    await mailResults.locator('button').first().click();
    await expect(page.locator('#employeeCreateButton')).toBeEnabled();
    await ui.desktopFormFits();
    rejectNextManual = true;
    await page.locator('#employeeCreateButton').click();
    await expect(page.locator('#employeeDialogMessage')).toContainText('Fixture local user save rejected');
    await expect(ui.dialog).toBeVisible();
    await expect(page.locator('#employeeManualCode')).toHaveValue(manualCode);
    await expect(page.locator('#employeeManualName')).toHaveValue(manualName);
    await expect(page.locator('#employeeRole')).toHaveValue('checked');
    await page.locator('#employeeCreateButton').click();
    await ui.closed('#usersCreateButton');
    const manualBody = { employeeCode: manualCode, displayName: manualName, roles: ['qa'], department: 'qaTet', signingStep: 'checked', mailSelection: { id: manualMail.id, email: manualMail.email } };
    assert.deepEqual(writes[5], { method: 'POST', path: '/api/admin/local-users', body: manualBody });
    assert.deepEqual(writes[6], writes[5]);
    assert.equal(users.find(user => user.id === 'manual-created').identityProvider, 'pcn-local');
    await expect(page.locator('#adminUsersRows')).toContainText(manualName);
    checks.push('manual-create-rejection-keeps-draft-retry-exact-local-user-payload');

    employeeResponses = { ...employeeResponses, [manualCode]: [] };
    await ui.open();
    await page.locator('#employeeSearch').fill(manualCode);
    await page.locator('#employeeResults button').filter({ hasText: manualName }).click();
    await expect(page.locator('#employeeSearch')).toBeDisabled();
    await expect(page.locator('#employeeRole')).toHaveValue('checked');
    await page.locator('#employeeRole').selectOption('prepared');
    await page.locator('#employeeCreateButton').click();
    await ui.closed();
    assert.deepEqual(writes[7], { method: 'PATCH', path: '/api/admin/users/manual-created', body: { roles: ['qa'], department: 'qaTet', signingStep: 'prepared', isActive: true, version: '0000000000000001' } });
    assert.equal(users.find(user => user.id === 'manual-created').identityProvider, 'pcn-local');
    assert.equal(writes.length, 8);
    checks.push('add-role-searches-cached-local-user-and-patches-preserving-provider');
    sourceConfigured = false;
    await page.locator('#usersRefreshButton').click();
    await expect(page.locator('#usersMessage')).toContainText('not configured');
    await expect(page.locator('#usersCreateButton')).toBeDisabled();
    await ui.open();
    await page.locator('#employeeSearch').fill(manualCode);
    await page.locator('#employeeResults button').filter({ hasText: manualName }).click();
    await expect(page.locator('#employeeRole')).toHaveValue('prepared');
    await page.locator('#employeeCancelButton').click();
    await ui.closed();
    assert.equal(writes.length, 8, 'Unconfigured-source cached account browsing and cancel perform no writes');
    checks.push('source-unconfigured-blocks-create-preserves-cached-local-role-edit');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(JSON.stringify({ browser: 'passed', checks, writes: writes.length, storage: 'isolated_test_adapters' }));
  } finally {
    release();
    releaseSearch();
    Object.values(directoryResponses).forEach(fixture => fixture.release());
    if (context) {
      await context.tracing.stop({ path: path.join(rootDir, 'test-results/user-dialog-trace.zip') });
      await context.close();
    }
    if (browser) await browser.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
