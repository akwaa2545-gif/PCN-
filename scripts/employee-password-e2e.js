// Synthetic employee-password browser journeys on a random loopback port.
// Never connects to SQL, modifies live users or calls external integrations.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect } = require('@playwright/test');
const { AuthService, hashToken } = require('../src/authService');
const { ApiError } = require('../src/apiError');
const { createRequestHandler } = require('../src/httpServer');
const { memoryRepository } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');
const { exerciseEmployeeCircleControls, exerciseAutomaticPassword } = require('./helpers/employee-password-browser');

const output = path.resolve('test-results');
const artifact = name => path.join(output, `employee-password-${name}`);
// These are intentionally public synthetic test values, never user credentials.
const passwords = Object.freeze({ numeric: '12345678', letters: 'abcdefgh', mixed: 'Ab12Cd34', wrong: '87654321' });

function memoryAuthentication() {
  const makeUser = (code, roles, department, provider = 'employee-code') => ({
    id: crypto.randomUUID(), username: code, employeeCode: code, normalizedEmployeeCode: code,
    displayName: `Synthetic ${roles[0] || 'Viewer'} Employee`, identityProvider: provider,
    roles, department, signingStep: null, isActive: true, securityStamp: crypto.randomUUID(),
    version: '0000000000000001', passwordHash: null, passwordSetAt: null, mustChangePassword: false,
    failedLoginCount: 0, lockoutUntil: null, email: null, mailProfile: null
  });
  const state = { users: [makeUser('0011001', ['admin'], 'it'), makeUser('0011002', [], null),
    makeUser('0011003', ['developer'], 'developer'), makeUser('0011004', ['reviewer'], 'gscTet', 'pcn-local')],
  sessions: [], writes: [], lookups: [], sourceOutage: false };
  const repository = {
    async getUserById(id) { return structuredClone(state.users.find(user => user.id === id) || null); },
    async getUserByEmployeeCode(code) { return structuredClone(state.users.find(user => user.normalizedEmployeeCode === code) || null); },
    async getUserByLogin(code) { return this.getUserByEmployeeCode(code); },
    async createEmployeeViewer(profile) {
      if (state.users.some(user => user.employeeCode === profile.employeeCode)) throw new ApiError(409, 'Duplicate fixture employee');
      const user = makeUser(profile.employeeCode, [], null);
      state.users = [...state.users, user];
      return structuredClone(user);
    },
    async saveSession(session) { state.sessions = [...state.sessions, structuredClone(session)]; },
    async getSession(hash) { return structuredClone(state.sessions.find(session => session.tokenHash === hash) || null); },
    async revokeSession(hash) {
      state.sessions = state.sessions.map(session => session.tokenHash === hash ? { ...session, revokedAt: new Date().toISOString() } : session);
    },
    async resetLoginFailures(id) {
      state.users = state.users.map(user => user.id === id ? { ...user, failedLoginCount: 0, lockoutUntil: null } : user);
    },
    async recordLoginFailure(id, now) {
      state.users = state.users.map(user => user.id !== id ? user : { ...user, failedLoginCount: user.failedLoginCount + 1,
        lockoutUntil: user.failedLoginCount + 1 >= 5 ? new Date(new Date(now).getTime() + 900000).toISOString() : user.lockoutUntil });
    },
    async updateEmployeePassword(id, hash, stamp, expectedStamp, { firstSetup }) {
      const user = state.users.find(entry => entry.id === id);
      const enrolled = Boolean(user?.passwordHash && user?.passwordSetAt);
      if (!user?.isActive || !['employee-code', 'pcn-local'].includes(user.identityProvider)
        || user.securityStamp !== expectedStamp || (firstSetup ? enrolled || user.passwordHash || user.passwordSetAt : !enrolled)) {
        throw new ApiError(409, 'Account changed. Sign in again');
      }
      state.users = state.users.map(entry => entry.id === id ? { ...entry, passwordHash: hash, passwordSetAt: entry.passwordSetAt || new Date().toISOString(),
        securityStamp: stamp, failedLoginCount: 0, lockoutUntil: null, mustChangePassword: false } : entry);
      state.sessions = state.sessions.map(session => session.userId === id ? { ...session, revokedAt: new Date().toISOString() } : session);
      state.writes = [...state.writes, { userId: id, firstSetup }];
    },
    async listUsers() {
      return state.users.map(({ passwordHash, securityStamp, passwordSetAt, ...user }) => structuredClone(user));
    }
  };
  const employeeDirectory = { async getByCode(code) {
    state.lookups = [...state.lookups, code];
    if (state.sourceOutage) throw new Error('Synthetic source outage');
    if (!['0011001', '0011002', '0011003', '0011005'].includes(code)) return null;
    return { employeeCode: code, displayName: 'Synthetic Source Employee', englishName: 'Synthetic Source Employee', isActive: true };
  }};
  const service = new AuthService(repository, { authMode: 'employee-password', employeeDirectory });
  return { state, repository, employeeDirectory, service };
}

class EmployeeLoginPage {
  constructor(page, origin) { this.page = page; this.origin = origin; }
  async open(returnTo = '/admin') {
    await this.page.goto(`${this.origin}/login?returnTo=${encodeURIComponent(returnTo)}`);
    await expect(this.page.locator('#employeeLoginForm')).toBeVisible();
    await expect(this.page.locator('#employeePassword')).toBeHidden();
  }
  async signIn(code, password = '', remember = false) {
    const identifier = this.page.locator('#employeeCode');
    const unchanged = await identifier.inputValue() === code;
    await identifier.fill(code);
    if (unchanged && !await this.page.locator('#employeePassword').isVisible()) {
      await this.page.locator('#employeeLoginForm button[type=submit]').click();
    }
    await expect.poll(async () => await this.page.locator('#passwordSetupForm').isVisible()
      || await this.page.locator('#employeePassword').isVisible()).toBe(true);
    if (!password) return;
    await expect(this.page.locator('#employeePassword')).toBeVisible();
    await this.page.getByRole('checkbox', { name: 'Remember me', exact: true }).setChecked(remember);
    await this.page.locator('#employeePassword').fill(password);
  }
  async setup(password) {
    await expect(this.page.locator('#passwordSetupForm')).toBeVisible();
    await this.page.locator('#setupPassword').fill(password);
    await this.page.locator('#setupConfirmPassword').fill(password);
    await this.page.locator('#passwordSetupForm button[type=submit]').click();
    await expect(this.page.locator('#employeeLoginForm')).toBeVisible();
    await expect(this.page.locator('#employeeAuthMessage')).toContainText(/password/i);
  }
}

async function assertPasswordCircles(page, value, visible = false, inputId = 'employeePassword') {
  const circles = page.locator(`#${inputId}`).locator('..').locator('.employee-password-circles');
  await expect(circles).toHaveAttribute('aria-hidden', 'true');
  await expect(circles.locator('> span')).toHaveCount(8);
  for (let index = 0; index < 8; index += 1) {
    const slot = page.locator(`#${inputId}Digit${index + 1}`);
    if (index < value.length) await expect(slot).toHaveClass(/is-filled/);
    else await expect(slot).not.toHaveClass(/is-filled/);
    if (visible) await expect(slot).toHaveText(value[index] || '');
    else assert(['', '•', '●'].includes(await slot.textContent()), 'Masked decorative slots contain no password characters');
  }
}

async function assertSetupCircleGeometry(page, inputId, width) {
  const bounds = await page.locator(`#${inputId}`).evaluate(input => {
    const control = input.parentElement, field = control.parentElement;
    const row = control.querySelector('.employee-password-circles').getBoundingClientRect();
    const toggle = field.querySelector('button').getBoundingClientRect();
    const native = input.getBoundingClientRect();
    return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      row: { left: row.left, right: row.right, top: row.top, bottom: row.bottom },
      native: { left: native.left, right: native.right, top: native.top, bottom: native.bottom },
      toggle: { left: toggle.left, right: toggle.right, bottom: toggle.bottom, height: toggle.height },
      slots: [...control.querySelector('.employee-password-circles').children].map(slot => {
        const rect = slot.getBoundingClientRect(), style = getComputedStyle(slot);
        return { left: rect.left, right: rect.right, width: rect.width, height: rect.height,
          radius: style.borderTopLeftRadius, pointerEvents: style.pointerEvents };
      }) };
  });
  assert(bounds.scrollWidth <= bounds.viewport, `${width}px setup page has no horizontal overflow`);
  assert(bounds.row.left >= 0 && bounds.row.right <= width);
  assert(bounds.toggle.height >= 44 && bounds.toggle.bottom <= bounds.row.top + 1, `${inputId} toggle stays above the circles`);
  assert(bounds.native.left <= bounds.row.left && bounds.native.right >= bounds.row.right,
    'One native input covers the full decorative circle row');
  for (const slot of bounds.slots) {
    assert(slot.left >= bounds.row.left - 1 && slot.right <= bounds.row.right + 1);
    assert(slot.width >= 20 && Math.abs(slot.width - slot.height) <= 1, `${width}px ${inputId} has readable circular indicators`);
    assert(slot.radius.endsWith('%') ? parseFloat(slot.radius) >= 50 : parseFloat(slot.radius) >= slot.width / 2 - 1);
    assert.equal(slot.pointerEvents, 'none');
  }
}

async function main() {
  const report = { storage: 'isolated_memory_only', checks: [], errors: [], external: [], authRequests: [], status: 'running' };
  const checked = value => { report.checks.push(value); console.log(JSON.stringify({ employeePasswordCheck: value })); };
  const authentication = memoryAuthentication();
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const businessWrites = [];
  for (const method of ['create', 'update', 'delete', 'saveNotificationSettings', 'saveWorkflowSettings']) {
    repository[method] = async () => { businessWrites.push(method); throw new Error('Password journeys must not change business data'); };
  }
  const server = http.createServer();
  const contexts = [];
  let browser, page;
  try {
    await fs.mkdir(output, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, authService: authentication.service, authMode: 'employee-password',
      employeeDirectory: authentication.employeeDirectory, rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    const openContext = async (width = 1440) => {
      const context = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 1000 }, serviceWorkers: 'block' });
      contexts.push(context);
      await context.tracing.start({ screenshots: true, snapshots: true });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
        if (url.pathname.startsWith('/api/auth/') && route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          report.authRequests.push({ path: url.pathname, fields: Object.keys(body || {}),
            ...(typeof body?.identifyOnly === 'boolean' ? { identifyOnly: body.identifyOnly } : {}),
            ...(typeof body?.remember === 'boolean' ? { remember: body.remember } : {}) });
        }
        return route.continue();
      });
      return context;
    };
    const mainContext = await openContext();
    await mainContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    page = await mainContext.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => report.errors.push(error.message));
    const login = new EmployeeLoginPage(page, origin);
    const session = async context => (await (await context.request.get(`${origin}/api/session`)).json()).data;
    const post = (context, route, data, csrf) => context.request.post(`${origin}${route}`, { headers: { origin, ...(csrf ? { 'x-csrf-token': csrf } : {}) }, data });
    const assertSessionDuration = (value, days) => {
      const remaining = new Date(value.expiresAt).getTime() - Date.now();
      const expected = days * 86400000;
      assert(remaining > expected - 15000 && remaining <= expected,
        `Expected a ${days}-day session; actual remaining ${remaining}ms`);
    };
    await login.open();
    await expect(page.locator('#employeePasswordField .employee-password-circles > span')).toHaveCount(8);
    const identifier = page.locator('#employeeCode');
    const employeeSubmit = page.locator('#employeeLoginForm button[type=submit]');
    await expect(employeeSubmit).toContainText('Continue');
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
      await expect(page.locator('#employeePasswordField')).toBeHidden();
      await expect(page.getByRole('checkbox', { name: 'Remember me', exact: true })).toBeHidden();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: artifact(`identifier-first-${width === 1440 ? 'desktop' : 'mobile-320'}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await identifier.fill('001100');
    await employeeSubmit.click();
    assert.equal(report.authRequests.length, 0, 'Six digits cannot identify an employee');
    await identifier.fill('9999999');
    await expect(page.locator('#employeeAuthMessage')).not.toBeEmpty();
    await expect(identifier).toBeEnabled();
    await expect(page.locator('#employeePasswordField')).toBeHidden();
    assert.equal(report.authRequests.length, 1, 'An unknown seven-digit ID is checked once');
    await employeeSubmit.click();
    await expect(identifier).toBeEnabled();
    await expect(page.locator('#employeeAuthMessage')).not.toBeEmpty();
    assert.equal(report.authRequests.length, 2, 'Continue retries the same failed identifier once');
    assert.equal(authentication.state.sessions.length, 0, 'Invalid IDs cannot create a session');
    let releaseIdentification, heldIdentificationCount = 0;
    const identificationGate = new Promise(resolve => { releaseIdentification = resolve; });
    const holdIdentification = async route => {
      assert.deepEqual(Object.keys(route.request().postDataJSON()).sort(), ['employeeCode', 'identifyOnly']);
      heldIdentificationCount += 1;
      await identificationGate;
      return route.fallback();
    };
    await page.route('**/api/auth/login', holdIdentification);
    try {
      await identifier.fill('0011001');
      await expect(identifier).toBeDisabled();
      await expect(employeeSubmit).toBeDisabled();
      await identifier.dispatchEvent('change');
      await page.locator('#employeeLoginForm').dispatchEvent('submit');
      releaseIdentification();
      await expect(page.locator('#passwordSetupForm')).toBeVisible();
      assert.equal(heldIdentificationCount, 1, 'Seven digits auto-identify once despite change/submit events while pending');
    } finally {
      releaseIdentification();
      await page.unroute('**/api/auth/login', holdIdentification);
    }
    await assertPasswordCircles(page, '', false, 'setupPassword');
    await assertPasswordCircles(page, '', false, 'setupConfirmPassword');
    await page.screenshot({ path: artifact('setup-circles-empty-desktop.png'), fullPage: true });
    await assertPasswordCircles(page, '');
    const setupSession = await session(mainContext);
    assert.equal(setupSession.user.passwordSetupRequired, true);
    assert.equal(setupSession.user.mustChangePassword, true);
    const setupRemaining = new Date(setupSession.expiresAt).getTime() - Date.now();
    assert(setupRemaining > 0 && setupRemaining <= 600000);
    assert.equal(report.authRequests.at(-1).identifyOnly, true);
    assert.deepEqual(report.authRequests.at(-1).fields.sort(), ['employeeCode', 'identifyOnly']);
    for (const route of ['/api/pcns', '/api/admin/users', '/api/profile', '/api/master-data']) {
      assert.equal((await mainContext.request.get(`${origin}${route}`)).status(), 403, `Setup session cannot read ${route}`);
    }
    assert.equal((await post(mainContext, '/api/pcn-drafts', { clientDraftKey: crypto.randomUUID(), document: { documentType: 'ta' } }, setupSession.csrfToken)).status(), 403);
    assert.equal((await post(mainContext, '/api/auth/change-password', { currentPassword: passwords.numeric, newPassword: passwords.letters, confirmPassword: passwords.letters }, setupSession.csrfToken)).status(), 403);
    checked('ID-only entry rejects incomplete/unknown IDs, allows retry, and auto-identifies first use once; pending controls prevent duplicate requests');
    checked('First-use identification creates only ten-minute setup access and cannot read PCNs, profile, administration or perform writes');

    const setupWrites = authentication.state.writes.length;
    for (const invalid of ['1234567', '123456789', 'abcd!efg']) {
      const response = await post(mainContext, '/api/auth/setup-password', { newPassword: invalid, confirmPassword: invalid }, setupSession.csrfToken);
      assert.equal(response.status(), 400, 'Server rejects lengths other than eight or unsupported characters');
    }
    assert.equal((await post(mainContext, '/api/auth/setup-password', { newPassword: passwords.numeric, confirmPassword: passwords.letters }, setupSession.csrfToken)).status(), 400);
    assert.equal(authentication.state.writes.length, setupWrites);
    const setupInput = page.locator('#setupPassword');
    const setupConfirm = page.locator('#setupConfirmPassword');
    const setupIds = ['setupPassword', 'setupConfirmPassword'];
    const setupRequestsBefore = report.authRequests.length;
    for (const inputId of setupIds) {
      const input = page.locator(`#${inputId}`);
      await expect(input).toHaveAttribute('autocomplete', 'new-password');
      await expect(input).toHaveAttribute('maxlength', '8');
      await expect(input).toHaveAttribute('type', 'password');
      await input.click();
      await expect(input).toBeFocused();
      await expect(page.locator(`#${inputId}Digit1`)).toHaveClass(/is-active/);
      await input.pressSequentially(passwords.mixed);
      await input.pressSequentially('9');
      await expect(input).toHaveValue(passwords.mixed);
      await assertPasswordCircles(page, passwords.mixed, false, inputId);
      await input.press('Backspace');
      await expect(input).toHaveValue('Ab12Cd3');
      await assertPasswordCircles(page, 'Ab12Cd3', false, inputId);
      await page.evaluate(value => navigator.clipboard.writeText(value), passwords.letters);
      await input.press('Control+A');
      await input.press('Control+V');
      await expect(input).toHaveValue(passwords.letters);
      await assertPasswordCircles(page, passwords.letters, false, inputId);
      await input.press('Control+A');
      await input.pressSequentially(passwords.mixed);
      await expect(input).toHaveValue(passwords.mixed);
    }
    const newToggle = page.locator('#setupPasswordToggle');
    const confirmToggle = page.locator('#setupConfirmPasswordToggle');
    await expect(newToggle).toHaveAttribute('aria-label', 'Show new password');
    await expect(newToggle).toHaveAttribute('aria-controls', 'setupPassword');
    await expect(confirmToggle).toHaveAttribute('aria-label', 'Show confirm password');
    await expect(confirmToggle).toHaveAttribute('aria-controls', 'setupConfirmPassword');
    await newToggle.click();
    await expect(setupInput).toHaveAttribute('type', 'text');
    await expect(setupConfirm).toHaveAttribute('type', 'password');
    await assertPasswordCircles(page, passwords.mixed, true, 'setupPassword');
    await assertPasswordCircles(page, passwords.mixed, false, 'setupConfirmPassword');
    await confirmToggle.click();
    await assertPasswordCircles(page, passwords.mixed, true, 'setupConfirmPassword');
    await newToggle.click();
    await expect(setupInput).toHaveAttribute('type', 'password');
    await expect(setupConfirm).toHaveAttribute('type', 'text');
    await assertPasswordCircles(page, passwords.mixed, false, 'setupPassword');
    await confirmToggle.click();
    await assertPasswordCircles(page, passwords.mixed, false, 'setupConfirmPassword');
    await setupInput.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(newToggle).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(setupInput).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(confirmToggle).toBeFocused();
    await confirmToggle.press('Enter');
    await expect(setupConfirm).toHaveAttribute('type', 'text');
    await confirmToggle.press('Enter');
    await page.keyboard.press('Tab');
    await expect(setupConfirm).toBeFocused();
    assert.equal(report.authRequests.length, setupRequestsBefore, 'Setup editing and independent visibility buttons never submit');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
      for (const inputId of setupIds) await assertSetupCircleGeometry(page, inputId, width);
      await page.screenshot({ path: artifact(`setup-circles-${width === 1440 ? 'desktop' : `mobile-${width}`}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await newToggle.click();
    await confirmToggle.click();
    await page.screenshot({ path: artifact('setup-circles-revealed-desktop.png'), fullPage: true });
    await page.emulateMedia({ forcedColors: 'active' });
    await expect(page.locator('#passwordSetupForm .employee-password-circles')).toHaveCount(2);
    for (const inputId of setupIds) {
      await expect(page.locator(`#${inputId}`).locator('..').locator('.employee-password-circles')).toBeHidden();
      const nativeStyle = await page.locator(`#${inputId}`).evaluate(input => {
        const style = getComputedStyle(input);
        return { text: style.webkitTextFillColor, caret: style.caretColor, border: parseFloat(style.borderTopWidth) };
      });
      assert(nativeStyle.border >= 1 && ![nativeStyle.text, nativeStyle.caret].some(color => color === 'transparent' || color === 'rgba(0, 0, 0, 0)'),
        `${inputId} uses a visible native input in forced colors`);
    }
    await page.screenshot({ path: artifact('setup-circles-forced-colors.png'), fullPage: true });
    await page.emulateMedia({ forcedColors: 'none' });
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    for (const inputId of setupIds) {
      await expect(page.locator(`#${inputId}`)).toHaveValue('');
      await expect(page.locator(`#${inputId}`)).toHaveAttribute('type', 'password');
      await assertPasswordCircles(page, '', false, inputId);
    }
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(setupInput).toBeEnabled();
    await setupInput.fill(passwords.mixed);
    await setupConfirm.fill(passwords.numeric);
    await newToggle.click();
    await confirmToggle.click();
    await page.locator('#passwordSetupForm button[type=submit]').click();
    await expect(page.locator('#authMessage')).toContainText(/do not match/i);
    assert.equal(report.authRequests.length, setupRequestsBefore, 'Mismatch is rejected without a setup request');
    for (const inputId of setupIds) {
      await expect(page.locator(`#${inputId}`)).toHaveValue('');
      await expect(page.locator(`#${inputId}`)).toHaveAttribute('type', 'password');
      await assertPasswordCircles(page, '', false, inputId);
    }
    let releaseSetup;
    const setupGate = new Promise(resolve => { releaseSetup = resolve; });
    const holdSetup = async route => {
      await setupGate;
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic setup retry' }) });
    };
    await page.route('**/api/auth/setup-password', holdSetup);
    try {
      await setupInput.fill(passwords.numeric);
      await setupConfirm.fill(passwords.numeric);
      await newToggle.click();
      await confirmToggle.click();
      await page.locator('#passwordSetupForm button[type=submit]').click();
      for (const inputId of setupIds) {
        await expect(page.locator(`#${inputId}`)).toBeDisabled();
        await expect(page.locator(`#${inputId}`)).toHaveAttribute('type', 'password');
        await expect(page.locator(`#${inputId}Toggle`)).toBeDisabled();
        await expect(page.locator(`#${inputId}ToggleText`)).toHaveText('Show');
        await assertPasswordCircles(page, passwords.numeric, false, inputId);
      }
      releaseSetup();
      await expect(page.locator('#authMessage')).toContainText('Synthetic setup retry');
    } finally {
      releaseSetup();
      await page.unroute('**/api/auth/setup-password', holdSetup);
    }
    for (const inputId of setupIds) {
      await expect(page.locator(`#${inputId}`)).toBeEnabled();
      await expect(page.locator(`#${inputId}`)).toHaveValue('');
      await expect(page.locator(`#${inputId}Toggle`)).toBeEnabled();
      await assertPasswordCircles(page, '', false, inputId);
    }
    assert.equal(authentication.state.writes.length, setupWrites, 'Editing, mismatch and failed setup do not change any account');
    checked('New and Confirm password have independent eight-circle typing/paste/Show controls, keyboard order and desktop/390px/320px layouts');
    checked('Setup pagehide, mismatch and API failure clear both circles; pending setup masks and disables both native inputs and toggles');
    await page.locator('#setupPassword').fill('1234567');
    await page.locator('#setupConfirmPassword').fill('1234567');
    await page.locator('#passwordSetupForm button[type=submit]').click();
    await expect(page.locator('#passwordSetupForm')).toBeVisible();
    await assertPasswordCircles(page, '1234567', false, 'setupPassword');
    await assertPasswordCircles(page, '1234567', false, 'setupConfirmPassword');
    assert.equal(authentication.state.writes.length, setupWrites, 'Native validation does not submit a seven-character password');
    await page.locator('#setupPassword').fill(passwords.numeric);
    await page.locator('#setupConfirmPassword').fill(passwords.numeric);
    await page.locator('#setupPassword').focus();
    await page.screenshot({ path: artifact('setup-desktop.png'), fullPage: true });
    await login.setup(passwords.numeric);
    assert.equal((await session(mainContext)).authenticated, false);
    await expect(page.locator('#employeeAuthMessage')).toHaveCSS('color', 'rgb(22, 101, 52)');
    await expect(page.locator('#employeePassword')).toBeVisible();
    for (const inputId of setupIds) {
      await expect(page.locator(`#${inputId}`)).toHaveValue('');
      await expect(page.locator(`#${inputId}`)).toHaveAttribute('type', 'password');
      await assertPasswordCircles(page, '', false, inputId);
    }
    assert.match(authentication.state.users.find(user => user.employeeCode === '0011001').passwordHash, /^\$argon2id\$/);
    const { remember, passwordControl } = await exerciseEmployeeCircleControls({
      page, report, passwords, artifact, checked, assertPasswordCircles
    });
    await login.open();
    await identifier.fill('0011001');
    await expect(passwordControl).toBeVisible();
    const requestsBeforeIdEdit = report.authRequests.length;
    await remember.setChecked(true);
    await passwordControl.fill(passwords.mixed.slice(0, 7));
    await page.getByRole('button', { name: 'Show password', exact: true }).click();
    await identifier.fill('001100');
    await expect(page.locator('#employeePasswordField')).toBeHidden();
    await expect(passwordControl).toHaveValue('');
    await expect(passwordControl).toHaveAttribute('type', 'password');
    await expect(page.locator('#employeeRemember')).not.toBeChecked();
    await expect(page.locator('#employeeRemember')).toBeDisabled();
    await expect(employeeSubmit).toContainText('Continue');
    assert.equal(report.authRequests.length, requestsBeforeIdEdit, 'Editing to an incomplete ID clears the challenge without submitting');
    assert.equal((await post(mainContext, '/api/auth/login', { employeeCode: '0011001' })).status(), 401,
      'A normal enrolled login without a password remains unauthorized');
    const failuresBeforeChallenge = authentication.state.users.find(user => user.employeeCode === '0011001').failedLoginCount;
    const sessionsBeforeChallenge = authentication.state.sessions.length;
    const challengePending = page.waitForResponse(response => response.url() === `${origin}/api/auth/login`
      && response.request().postDataJSON()?.identifyOnly === true);
    await identifier.fill('0011001');
    const challengeResponse = await challengePending;
    assert.equal(challengeResponse.status(), 200);
    assert.deepEqual((await challengeResponse.json()).data, { authenticated: false, passwordRequired: true });
    assert.equal(challengeResponse.headers()['set-cookie'], undefined, 'Identification challenge cannot set an authentication cookie');
    await expect(passwordControl).toBeVisible();
    await expect(passwordControl).toBeFocused();
    await expect(remember).toBeEnabled();
    await expect(employeeSubmit).toContainText('Sign in');
    assert.equal(authentication.state.sessions.length, sessionsBeforeChallenge);
    assert.equal(authentication.state.users.find(user => user.employeeCode === '0011001').failedLoginCount, failuresBeforeChallenge);
    assert.equal((await mainContext.cookies()).some(cookie => cookie.name === 'pcn_session'), false);
    assert.equal((await session(mainContext)).authenticated, false);
    assert.equal((await mainContext.request.get(`${origin}/api/pcns`)).status(), 401);
    await identifier.dispatchEvent('change');
    await passwordControl.fill(passwords.numeric.slice(0, 7));
    assert.equal(report.authRequests.length, requestsBeforeIdEdit + 1, 'The challenge is checked once; entering seven password characters never submits');
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
      await page.screenshot({ path: artifact(`identifier-password-${width === 1440 ? 'desktop' : 'mobile-320'}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    checked('Editing Employee ID clears and hides password/remember; enrolled identification expands the challenge without cookies, sessions or failure-count changes');
    await exerciseAutomaticPassword({ page, report, passwords, artifact, checked, assertPasswordCircles });
    await passwordControl.fill(passwords.wrong.slice(0, 7));
    await page.getByRole('button', { name: 'Show password', exact: true }).click();
    let releaseLogin;
    const loginGate = new Promise(resolve => { releaseLogin = resolve; });
    const holdLogin = async route => { await loginGate; return route.fallback(); };
    await page.route('**/api/auth/login', holdLogin);
    try {
      await login.signIn('0011001', passwords.wrong, true);
      await expect(passwordControl).toHaveAttribute('type', 'password');
      await expect(passwordControl).toBeDisabled();
      await assertPasswordCircles(page, passwords.wrong);
      await expect(page.getByRole('button', { name: 'Show password', exact: true })).toBeDisabled();
      await expect(remember).toBeDisabled();
      await expect(page.locator('#employeePasswordToggleText')).toHaveText('Show');
      releaseLogin();
      await expect(page.locator('#employeeAuthMessage')).toContainText(/password|invalid|verified/i);
    } finally {
      releaseLogin();
      await page.unroute('**/api/auth/login', holdLogin);
    }
    await expect(page.locator('#employeeAuthMessage')).toContainText(/password|invalid|verified/i);
    await expect(remember).toBeChecked();
    await expect(remember).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Show password', exact: true })).toBeEnabled();
    await expect(passwordControl).toHaveValue('');
    await expect(passwordControl).toHaveAttribute('type', 'password');
    await assertPasswordCircles(page, '');
    assert.equal((await session(mainContext)).authenticated, false);
    const requestsAfterError = report.authRequests.length;
    await passwordControl.dispatchEvent('change');
    assert.equal(report.authRequests.length, requestsAfterError, 'A real wrong-password response never auto-retries');
    await login.signIn('0011001', passwords.numeric, true);
    await page.waitForURL(`${origin}/admin`);
    await expect(page.locator('.account-trigger')).toBeVisible();
    const fullSession = await session(mainContext);
    assert.equal(fullSession.user.canChangePassword, true);
    assertSessionDuration(fullSession, 30);
    const rememberedRequest = report.authRequests.filter(request => request.path === '/api/auth/login').at(-1);
    assert.equal(rememberedRequest.remember, true);
    const rememberedCookie = (await mainContext.cookies()).find(cookie => cookie.name === 'pcn_session');
    assert(Math.abs(rememberedCookie.expires * 1000 - new Date(fullSession.expiresAt).getTime()) < 2000,
      'Remember me cookie expiration matches the thirty-day server session');
    assert.deepEqual(fullSession.user.roles, ['admin']);
    assert(!JSON.stringify(fullSession).includes('passwordHash'));
    checked('Exactly-eight numeric setup is hashed with Argon2id, signs out, then requires the correct password and preserves Administrator access');

    const peerContext = await openContext();
    assert.equal((await post(peerContext, '/api/auth/login', { employeeCode: '0011001', password: passwords.numeric })).status(), 200);
    const peer = await session(peerContext);
    const openChange = async () => {
      await page.locator('.account-trigger').click();
      await page.getByRole('button', { name: 'Change password', exact: true }).click();
      await expect(page.locator('#accountPasswordDialog')).toBeVisible();
      await expect(page.locator('#accountCurrentPassword')).toBeFocused();
      await expect(page.locator('#accountProfilePanel')).not.toHaveClass(/pcn-dropdown-rendering/);
    };
    await openChange();
    await page.locator('#accountCurrentPassword').fill('87654321');
    await page.locator('#accountNewPassword').fill(passwords.letters);
    await page.locator('#accountConfirmPassword').fill(passwords.letters);
    await page.screenshot({ path: artifact('profile-change-desktop.png'), fullPage: true });
    await page.locator('#accountPasswordSubmit').click();
    await expect(page.locator('#accountPasswordMessage')).toContainText(/current password|incorrect|invalid/i);
    assert.equal((await session(peerContext)).authenticated, true, 'A failed password change does not revoke another valid session');
    await page.locator('#accountCurrentPassword').fill(passwords.numeric);
    await page.locator('#accountPasswordSubmit').click();
    await page.waitForURL(url => url.pathname === '/login' && url.searchParams.get('passwordChanged') === '1');
    assert.equal((await session(peerContext)).authenticated, false);
    assert.equal((await peerContext.request.get(`${origin}/api/pcns`)).status(), 401);
    assert.notEqual(peer.csrfToken, '');
    await expect(page.locator('#employeeAuthMessage')).toContainText(/password.*changed/i);
    await login.signIn('0011001', passwords.numeric);
    await expect(page.locator('#employeeAuthMessage')).toContainText(/password|invalid|verified/i);
    await login.signIn('0011001', passwords.letters);
    await page.waitForURL(`${origin}/admin`);
    assertSessionDuration(await session(mainContext), 1 / 3);
    assert.equal(report.authRequests.filter(request => request.path === '/api/auth/login').at(-1).remember, undefined,
      'Unchecked Remember me omits the option and keeps the default eight-hour duration');
    checked('Remember me gives thirty-day full sessions; unchecked gives eight hours, setup stays ten minutes, and failed login preserves the checkbox safely');
    checked('Profile change rejects a wrong current password, accepts letters only, revokes other sessions and rejects the old password');

    await openChange();
    await page.locator('#accountCurrentPassword').fill(passwords.letters);
    await page.locator('#accountNewPassword').fill(passwords.mixed);
    await page.locator('#accountConfirmPassword').fill(passwords.mixed);
    await page.locator('#accountPasswordDialog').press('Escape');
    await expect(page.locator('#accountPasswordDialog')).not.toBeVisible();
    for (const id of ['accountCurrentPassword', 'accountNewPassword', 'accountConfirmPassword']) await expect(page.locator(`#${id}`)).toHaveValue('');
    await expect(page.locator('.account-trigger')).toBeFocused();
    await openChange();
    await page.locator('#accountCurrentPassword').fill(passwords.letters);
    await page.locator('#accountNewPassword').fill(passwords.mixed);
    await page.locator('#accountConfirmPassword').fill(passwords.mixed);
    await page.locator('#accountPasswordSubmit').click();
    await page.waitForURL(url => url.pathname === '/login');
    await login.signIn('0011001', passwords.mixed);
    await page.waitForURL(`${origin}/admin`);
    checked('Closing the password dialog clears secret fields and returns focus; mixed letters/digits are accepted without a composition requirement');

    authentication.service.attempts.clear(); // Independent synthetic actor journeys share one loopback IP.
    const viewerContext = await openContext(390);
    const viewerPage = await viewerContext.newPage();
    viewerPage.setDefaultTimeout(12000); viewerPage.on('pageerror', error => report.errors.push(error.message));
    const viewerLogin = new EmployeeLoginPage(viewerPage, origin);
    await viewerLogin.open('/admin');
    await viewerPage.screenshot({ path: artifact('login-mobile.png'), fullPage: true });
    await viewerLogin.signIn('0011002');
    await expect(viewerPage.locator('#passwordSetupForm')).toBeVisible();
    await viewerPage.screenshot({ path: artifact('setup-mobile.png'), fullPage: true });
    await viewerLogin.setup(passwords.letters);
    await viewerLogin.signIn('0011002', passwords.letters);
    await viewerPage.waitForURL(`${origin}/records`);
    const viewerSession = await session(viewerContext);
    assert.deepEqual(viewerSession.user.roles, []);
    assert.equal((await post(viewerContext, '/api/pcn-drafts', { clientDraftKey: crypto.randomUUID(), document: { documentType: 'ta' } }, viewerSession.csrfToken)).status(), 403);
    assert.equal((await viewerContext.request.get(`${origin}/api/admin/users`)).status(), 403);
    await viewerPage.locator('.account-trigger').click();
    await viewerPage.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(viewerPage.locator('#accountPasswordDialog')).toBeVisible();
    await expect(viewerPage.locator('#accountProfilePanel')).not.toHaveClass(/pcn-dropdown-rendering/);
    assert(await viewerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile sign-in/profile has no horizontal overflow');
    const mobileDialog = await viewerPage.locator('#accountPasswordDialog').evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right,
        viewportHeight: innerHeight, viewportWidth: innerWidth, position: getComputedStyle(node).position };
    });
    assert(mobileDialog.top >= 0 && mobileDialog.bottom <= mobileDialog.viewportHeight,
      `Mobile password dialog stays inside the viewport: ${JSON.stringify(mobileDialog)}`);
    assert(mobileDialog.left >= 0 && mobileDialog.right <= mobileDialog.viewportWidth);
    await viewerPage.screenshot({ path: artifact('profile-change-mobile.png') });
    await viewerPage.locator('#accountCurrentPassword').fill(passwords.letters);
    await viewerPage.locator('#accountNewPassword').fill(passwords.numeric);
    await viewerPage.locator('#accountConfirmPassword').fill(passwords.numeric);
    await viewerPage.locator('#accountPasswordSubmit').click();
    await viewerPage.waitForURL(url => url.pathname === '/login');
    await viewerLogin.signIn('0011002', passwords.numeric);
    await viewerPage.waitForURL(`${origin}/records`);
    checked('Leading-zero roleless employees set a letters-only password and change it from their profile on mobile without gaining write access');

    authentication.service.attempts.clear(); // Keep rate limits active within each isolated actor journey.
    const developerContext = await openContext();
    const enrollByApi = async (context, code, password) => {
      const initial = await post(context, '/api/auth/login', { employeeCode: code, identifyOnly: true });
      assert.equal(initial.status(), 200);
      const setup = (await initial.json()).data;
      assert.equal(setup.user.passwordSetupRequired, true);
      assert(new Date(setup.expiresAt).getTime() - Date.now() <= 600000, 'Remember does not extend setup');
      assert.equal((await post(context, '/api/auth/setup-password', { newPassword: password, confirmPassword: password }, setup.csrfToken)).status(), 200);
      assert.equal((await post(context, '/api/auth/login', { employeeCode: code, password })).status(), 200);
      return session(context);
    };
    const developer = await enrollByApi(developerContext, '0011003', passwords.mixed);
    assert.deepEqual(developer.user.roles, ['developer']);
    assert.equal(developer.user.department, 'developer');
    assert.equal((await developerContext.request.get(`${origin}/api/admin/users`)).status(), 200);
    authentication.service.attempts.clear(); // Local-provider fixture starts its own actor journey.
    const localContext = await openContext();
    const lookupsBefore = authentication.state.lookups.filter(code => code === '0011004').length;
    const local = await enrollByApi(localContext, '0011004', passwords.numeric);
    assert.equal(local.user.identityProvider, 'pcn-local');
    assert.equal(authentication.state.lookups.filter(code => code === '0011004').length, lookupsBefore, 'Local identity never calls employee source');
    checked('Developer assignments remain intact, local employees enroll without source lookup, and remember-me never extends setup access');

    const enrolled = authentication.state.users.find(user => user.employeeCode === '0011001');
    for (const method of [null, 'employee-code']) {
      const context = await openContext();
      const token = crypto.randomBytes(32).toString('hex');
      await authentication.repository.saveSession({ id: crypto.randomUUID(), userId: enrolled.id, tokenHash: hashToken(token),
        csrfToken: crypto.randomBytes(32).toString('hex'), securityStamp: enrolled.securityStamp,
        expiresAt: new Date(Date.now() + 3600000).toISOString(), authenticationMethod: method });
      await context.addCookies([{ name: 'pcn_session', value: token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
      assert.equal((await session(context)).authenticated, false);
      assert.equal((await context.request.get(`${origin}/api/pcns`)).status(), 401);
    }
    checked('Old null-method and code-only cookies cannot become password-authenticated sessions after enrollment');
    assert.deepEqual(businessWrites, []);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.external, []);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.message;
    await page?.screenshot({ path: artifact('failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    for (const [index, context] of contexts.entries()) {
      await context.tracing.stop({ path: artifact(`trace-${index + 1}.zip`) }).catch(() => {});
      await context.close();
    }
    await fs.writeFile(artifact('report.json'), JSON.stringify(report, null, 2));
    await browser?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ status: report.status, checks: report.checks, errors: report.errors, external: report.external }));
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { memoryAuthentication };
