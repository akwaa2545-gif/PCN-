// Isolated profile journeys: all directory responses are fixtures, never SQL or Power Automate.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { memoryRepository, fakeAuthService, TEST_PASSWORD } = require('../test/helpers/apiHarness');

// Synthetic silhouette PNG; no employee image or personal data is used in screenshots.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAA30lEQVR4nO3XOw7DMAwEUXe5V+6Vq/oE6dOmDmLAJLXSgvYArKV5jT7b/v60ns1eAMBdAMBdAMBdAMBdAMBdAGDOuo/n6396AA7T5zHEgNN6uUEJCNZrDTJAql5o0AAK9SoDgIF6iQEAAAAA2gPa3wNXALR/CxUMqk35D+QN2u34E7sHgHsA/E7jY7TxTVx+CEkYQ4DBdAmjDhDWjxiKAHl92VABTKqvGdKAqfUFQw6woD5rSACW1acMUcDi+rjhHgBLfdBwA4CxPmK4OsBef2oAAGAiwN4dMQAAAKA54AuP+NHRJaqYQwAAAABJRU5ErkJggg==';
const storedProfile = { email: 'stored.person@example.test', photo: PNG, jobTitle: 'Fixture engineer', department: 'Directory IT' };
const fixtureUser = (employeeCode, overrides = {}) => ({ username: employeeCode, employeeCode,
  displayName: 'Example Profile Person', identityProvider: 'employee-code', roles: ['admin'], department: 'it', ...overrides });

async function main() {
  // Tests-first replay serves the committed implementation without modifying shared product files.
  const baselineClient = process.env.PROFILE_E2E_BASELINE === '1'
    ? execFileSync('git', ['show', 'HEAD:session-client.js'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }) : null;
  const repository = memoryRepository();
  const businessWrites = [];
  ['create', 'update', 'delete', 'saveNotificationSettings'].forEach(method => {
    repository[method] = async () => { businessWrites.push(method); throw new Error('Profile must not write business data'); };
  });
  const passwordAuth = fakeAuthService({ additionalUsers: [
    fixtureUser('7000001', { mailProfile: storedProfile }), fixtureUser('7000002'), fixtureUser('7000003'),
    fixtureUser('7000004', { mailProfile: { email: 'invalid-stored@example.test', photo: 'https://untrusted.example.test/profile.png' } })
  ] });
  const authService = { ...passwordAuth, authMode: 'employee-code',
    login: body => passwordAuth.login({ username: body.employeeCode, password: TEST_PASSWORD }) };
  const server = http.createServer();
  const checks = [], errors = [], external = [], contexts = [];
  let browser;
  let releaseHeld = () => {};
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, authService, rootDir: path.resolve(__dirname, '..'),
      publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    const open = async (code, profileResponse) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      await context.tracing.start({ screenshots: true, snapshots: true });
      let lookupCount = 0;
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { external.push(route.request().url()); return route.abort(); }
        if (baselineClient && url.pathname === '/session-client.js') return route.fulfill({ contentType: 'application/javascript', body: baselineClient });
        if (url.pathname === '/api/profile') {
          lookupCount += 1;
          assert.equal(route.request().method(), 'GET');
          if (typeof profileResponse === 'function') return profileResponse(route);
          return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ success: true, data: profileResponse || { status: 'unavailable' } }) });
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/login?returnTo=%2Frecords`);
      await page.locator('#employeeCode').fill(code);
      await page.waitForURL(`${origin}/admin`);
      await expect(page.locator('.account-trigger')).toBeVisible();
      return { context, page, lookups: () => lookupCount };
    };
    const openMenu = async page => {
      await page.locator('.account-trigger').click();
      await expect(page.locator('.account-panel')).toBeVisible();
      await expect(page.locator('.account-trigger')).toHaveAttribute('aria-expanded', 'true');
    };
    const photoPair = async page => {
      await expect(page.locator('#accountMenu .account-avatar img')).toHaveCount(2);
      for (const photo of await page.locator('#accountMenu .account-avatar img').all()) {
        await expect(photo).toHaveAttribute('src', PNG);
        await expect.poll(() => photo.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
      }
    };
    const identityRow = (page, label) => page.locator('.account-profile-detail').filter({ has: page.getByText(label, { exact: true }) });

    const stored = await open('7000001');
    await openMenu(stored.page);
    await photoPair(stored.page);
    assert.equal(stored.lookups(), 0, 'A valid verified stored photo does not trigger another lookup');
    await expect(stored.page.locator('.account-panel-email')).toHaveText(storedProfile.email);
    await expect(identityRow(stored.page, 'PCN role')).toContainText('Administrator');
    await expect(identityRow(stored.page, 'Signing step')).toContainText(/all/i);
    await expect(identityRow(stored.page, 'Department')).toContainText('IT');
    assert.equal(await stored.page.locator('.account-panel-heading .account-sign-out').count(), 0);
    const triggerBounds = await stored.page.locator('.account-trigger').boundingBox();
    const navAvatar = await stored.page.locator('.account-trigger .account-avatar').boundingBox();
    const panelAvatar = await stored.page.locator('.account-avatar-large').boundingBox();
    assert.ok(triggerBounds.width >= 56 && triggerBounds.height >= 56, 'Profile trigger is at least 56px square');
    assert.ok(navAvatar.width >= 44 && navAvatar.height >= 44, 'Navbar avatar is at least 44px');
    assert.ok(panelAvatar.width >= 84 && panelAvatar.height >= 84, 'Desktop profile avatar is at least 84px');
    assert.equal(await stored.page.locator('.account-panel').evaluate(node => getComputedStyle(node).borderTopLeftRadius), '0px');
    await stored.page.screenshot({ path: path.resolve('test-results/profile-desktop.png'), fullPage: false });
    checks.push('stored-verified-photo-two-avatars-no-lookup-square-menu-admin-identification');
    await stored.page.keyboard.press('Escape');
    await expect(stored.page.locator('.account-panel')).toBeHidden();
    await expect(stored.page.locator('.account-trigger')).toBeFocused();
    await openMenu(stored.page);
    await stored.page.locator('#adminMessage').click();
    await expect(stored.page.locator('.account-panel')).toBeHidden();
    await stored.page.setViewportSize({ width: 390, height: 844 });
    await openMenu(stored.page);
    const mobilePanel = await stored.page.locator('.account-panel').boundingBox();
    const mobileAvatar = await stored.page.locator('.account-avatar-large').boundingBox();
    assert.ok(mobilePanel.x >= 0 && mobilePanel.x + mobilePanel.width <= 390, 'Mobile profile menu fits horizontally');
    assert.ok(mobilePanel.y >= 0 && mobilePanel.y + mobilePanel.height <= 844, 'Mobile profile menu fits vertically');
    assert.ok(mobileAvatar.width >= 72 && mobileAvatar.height >= 72);
    await stored.page.screenshot({ path: path.resolve('test-results/profile-mobile.png'), fullPage: false });
    checks.push('escape-focus-outside-close-mobile-menu-fit');
    const logout = stored.page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout');
    await stored.page.locator('.account-sign-out').click();
    assert.equal((await logout).status(), 200);
    await stored.page.waitForURL(`${origin}/login`);
    const loggedOutSession = await stored.page.request.get(`${origin}/api/session`);
    assert.equal(loggedOutSession.status(), 200);
    assert.equal((await loggedOutSession.json()).data.authenticated, false);
    checks.push('authenticated-signout-clears-session');

    const found = await open('7000002', { status: 'available', photo: PNG, email: 'lookup.person@example.test',
      jobTitle: 'Lookup engineer', directoryDepartment: 'Directory Engineering', roles: ['supplier'], department: 'qaTet', signingStep: 'prepared' });
    await openMenu(found.page);
    await photoPair(found.page);
    assert.equal(found.lookups(), 1);
    await expect(found.page.locator('.account-panel-email')).toHaveText('lookup.person@example.test');
    await expect(found.page.locator('.account-panel')).toContainText('Lookup engineer');
    await expect(identityRow(found.page, 'PCN role')).toContainText('Administrator');
    await expect(identityRow(found.page, 'Department')).toContainText('IT');
    await expect(identityRow(found.page, 'Signing step')).toContainText(/all/i);
    checks.push('authenticated-lookup-photo-email-jobtitle-without-permission-changes');

    const invalidStored = await open('7000004', { status: 'available', photo: PNG, email: 'recovered.photo@example.test' });
    await openMenu(invalidStored.page);
    await photoPair(invalidStored.page);
    assert.equal(invalidStored.lookups(), 1, 'An unsafe stored photo triggers the authenticated fallback lookup');
    await expect(invalidStored.page.locator('.account-panel-email')).toHaveText('recovered.photo@example.test');
    checks.push('unsafe-stored-photo-is-replaced-through-authenticated-lookup');

    const unsafePhotos = [
      'https://untrusted.example.test/profile.png', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`, 'data:image/png;base64,aW52YWxpZCBwaG90bw=='
    ];
    for (let index = 0; index < unsafePhotos.length; index += 1) {
      const fallback = await open('7000003', { status: 'available', photo: unsafePhotos[index], email: 'fallback@example.test' });
      await openMenu(fallback.page);
      await expect.poll(() => fallback.lookups()).toBe(1);
      await expect(fallback.page.locator('.account-panel-email')).toHaveText('fallback@example.test');
      await expect(fallback.page.locator('.account-photo-status')).toHaveText('Profile photo unavailable');
      await expect(fallback.page.locator('#accountMenu .account-avatar img')).toHaveCount(0);
      await expect(fallback.page.locator('.account-avatar-large')).toContainText('EP');
      await fallback.context.close();
    }
    const unavailable = await open('7000003', async route => route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Fixture lookup unavailable' }) }));
    await openMenu(unavailable.page);
    await expect.poll(() => unavailable.lookups()).toBe(1);
    await expect(unavailable.page.locator('.account-photo-status')).toHaveText('Profile photo unavailable');
    await expect(unavailable.page.locator('#accountMenu .account-avatar img')).toHaveCount(0);
    await expect(unavailable.page.locator('.account-avatar-large')).toContainText('EP');
    checks.push('remote-svg-oversize-broken-image-and-service-error-fallbacks');

    const held = new Promise(resolve => { releaseHeld = resolve; });
    const stale = await open('7000002', async route => {
      await held;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true,
        data: { status: 'available', photo: PNG, email: 'stale.person@example.test', jobTitle: 'Stale directory title' } }) });
    });
    await expect.poll(() => stale.lookups()).toBe(1);
    const replaced = fixtureUser('7000001', { id: 'replacement-user', displayName: 'Replacement User', mailProfile: storedProfile });
    await stale.page.evaluate(user => window.PCN_SESSION.mountProfile(user), replaced);
    const staleResponse = stale.page.waitForResponse(response => new URL(response.url()).pathname === '/api/profile');
    releaseHeld();
    await staleResponse;
    await openMenu(stale.page);
    await expect(stale.page.locator('.account-panel-username')).toHaveText('Replacement User');
    await expect(stale.page.locator('.account-panel-email')).toHaveText(storedProfile.email);
    await expect(stale.page.locator('.account-panel')).not.toContainText('Stale directory title');
    checks.push('stale-directory-response-cannot-overwrite-remounted-profile');
    assert.deepEqual(businessWrites, []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: 'passed', checks, storage: 'isolated-memory-fixtures', directory: 'mocked-no-external-calls' }));
  } finally {
    releaseHeld();
    for (let index = 0; index < contexts.length; index += 1) {
      try { await contexts[index].tracing.stop({ path: path.resolve(`test-results/profile-trace-${index + 1}.zip`) }); } catch (_) { /* Context may already be closed. */ }
    }
    try { if (browser) await browser.close(); }
    finally { if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
