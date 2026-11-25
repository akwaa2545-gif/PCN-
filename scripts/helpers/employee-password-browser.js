// Isolated employee-password browser controls; never calls a live account or profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

async function exerciseEmployeePasswordControls({ page, report, passwords, artifact, checked }) {
  const before = report.authRequests.length;
  const remember = page.getByRole('checkbox', { name: 'Remember me', exact: true });
  const passwordControl = page.locator('#employeePassword');
  await expect(remember).not.toBeChecked();
  await expect(remember).toBeEnabled();
  await expect(passwordControl).toBeVisible();
  await expect(passwordControl).toBeEnabled();
  await expect(passwordControl).toHaveAttribute('autocomplete', 'current-password');
  await expect(passwordControl).toHaveAttribute('maxlength', '8');
  await expect(page.locator('#employeeLoginForm input[name="password"]')).toHaveCount(1);
  await expect(page.locator('#employeePasswordField .employee-password-circles')).toBeHidden();
  await passwordControl.click();
  await passwordControl.pressSequentially(passwords.mixed);
  await expect(passwordControl).toHaveValue(passwords.mixed);
  await passwordControl.press('Backspace');
  await expect(passwordControl).toHaveValue(passwords.mixed.slice(0, 7));
  await page.evaluate(value => navigator.clipboard.writeText(value), passwords.letters);
  await passwordControl.press('Control+A');
  await passwordControl.press('Control+V');
  await expect(passwordControl).toHaveValue(passwords.letters);
  await passwordControl.evaluate((input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, passwords.numeric);
  await expect(passwordControl).toHaveValue(passwords.numeric);
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(passwordControl).toHaveAttribute('type', 'text');
  await expect(passwordControl).toHaveValue(passwords.numeric);
  await page.getByRole('button', { name: 'Hide password', exact: true }).press('Enter');
  await expect(passwordControl).toHaveAttribute('type', 'password');
  await remember.focus();
  await remember.press('Space');
  await expect(remember).toBeChecked();
  assert.equal(report.authRequests.length, before, 'Password typing, paste, autofill, visibility and Remember me never submit credentials');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
    const bounds = await passwordControl.evaluate(input => {
      const box = input.getBoundingClientRect();
      return { left: box.left, right: box.right, height: box.height, viewport: innerWidth,
        scrollWidth: document.documentElement.scrollWidth, color: getComputedStyle(input).webkitTextFillColor,
        border: getComputedStyle(input).borderTopColor };
    });
    assert(bounds.left >= 0 && bounds.right <= width && bounds.height >= 40, 'Ordinary password input stays readable and usable');
    assert(bounds.scrollWidth <= bounds.viewport, 'Standard sign-in fits the viewport');
    assert.equal(bounds.border, 'rgb(114, 137, 156)', 'Standard input keeps the approved accessible border color');
    await expect(page.locator('#employeeCode')).toBeVisible();
    await expect(passwordControl).toBeVisible();
    await expect(remember).toBeVisible();
    await page.screenshot({ path: artifact(`standard-login-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ forcedColors: 'active' });
  const forced = await passwordControl.evaluate(input => {
    const style = getComputedStyle(input);
    return { color: style.color, fill: style.webkitTextFillColor, caret: style.caretColor };
  });
  assert(!Object.values(forced).some(value => value === 'transparent' || value === 'rgba(0, 0, 0, 0)'), 'Forced colors keeps native password text and caret visible');
  await page.screenshot({ path: artifact('standard-login-forced-colors.png'), fullPage: true });
  await page.emulateMedia({ forcedColors: 'none' });
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(passwordControl).toHaveValue('');
  await expect(passwordControl).toHaveAttribute('type', 'password');
  assert.equal(report.authRequests.length, before, 'Leaving sign-in clears secrets without submitting credentials');
  checked('Employee ID boxes, ordinary password and Remember me remain visible; password typing, paste and autofill wait for explicit Sign in at desktop/390px/320px');
  checked('Native password editing, Show/Hide, keyboard Remember me, forced colors and pagehide cleanup remain usable');
  return { remember, passwordControl };
}

async function exerciseExplicitPassword({ page, report, passwords, artifact, checked }) {
  const input = page.locator('#employeePassword'), remember = page.locator('#employeeRemember');
  const requests = [];
  let release, gate;
  const rejectCredential = async route => {
    const body = route.request().postDataJSON();
    if (body?.identifyOnly) return route.fallback();
    requests.push({ fields: Object.keys(body), remember: body.remember === true });
    await gate;
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic explicit-password rejection' }) });
  };
  await page.route('**/api/auth/login', rejectCredential);
  try {
    for (const [name, selectRemember, fill] of [
      ['typed password', true, () => input.pressSequentially(passwords.mixed)],
      ['pasted password', false, async () => { await page.evaluate(value => navigator.clipboard.writeText(value), passwords.letters); await input.focus(); await input.press('Control+V'); }],
      ['autofill change', false, () => input.evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }, passwords.numeric)],
      ['event-free autofill', false, () => input.evaluate((node, value) => { node.value = value; }, passwords.numeric)]
    ]) {
      gate = new Promise(resolve => { release = resolve; });
      const before = requests.length;
      await remember.setChecked(selectRemember);
      await fill();
      assert.equal(requests.length, before, `${name} must wait for the explicit submit button`);
      await page.locator('#employeeLoginForm button[type=submit]').click();
      await expect.poll(() => requests.length).toBe(before + 1);
      await expect(input).toBeDisabled();
      await expect(input).toHaveAttribute('type', 'password');
      await expect(remember).toBeDisabled();
      await page.locator('#employeeLoginForm').dispatchEvent('submit');
      assert.equal(requests.length, before + 1, 'Pending duplicate submissions cannot create another request');
      assert.equal(requests.at(-1).remember, selectRemember);
      if (name === 'typed password') await page.screenshot({ path: artifact('explicit-password-pending.png'), fullPage: true });
      release();
      await expect(page.locator('#employeeAuthMessage')).toHaveText('Synthetic explicit-password rejection');
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue('');
      await input.dispatchEvent('change');
      assert.equal(requests.length, before + 1, 'Error and cleanup never auto-retry');
    }
    report.explicitPasswordRequests = requests;
    checked('Typed, pasted, autofilled and event-free credentials submit only on Sign in, once; failures clear secrets and preserve explicit retry/Remember me');
  } finally {
    release?.();
    await page.unroute('**/api/auth/login', rejectCredential);
  }
}

async function exercisePasswordManagerHandoff({ context, origin, code, password, artifact, checked, report, browserName = 'chromium' }) {
  // Synthetic autofill models browser field population. It does not automate a browser's Save Password bubble.
  for (const cold of [true, false]) {
    const page = await context.newPage();
    const width = cold ? 1440 : 320;
    await page.setViewportSize({ width, height: cold ? 1000 : 844 });
    const requests = [], nativeSubmissions = [];
    let navigationSnapshot;
    let releaseIdentification;
    const identificationGate = new Promise(resolve => { releaseIdentification = resolve; });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.exposeFunction('recordNativePasswordSubmit', value => nativeSubmissions.push(value));
    await page.exposeFunction('recordPasswordNavigation', value => { navigationSnapshot = value; });
    await page.addInitScript(({ code, password, cold }) => {
      document.addEventListener('submit', event => {
        if (event.target.id !== 'employeeLoginForm') return;
        const form = event.target, data = new FormData(form);
        window.recordNativePasswordSubmit({ code: data.get('employeeCode') === code,
          password: data.get('password') === password, method: form.method, action: new URL(form.action).pathname });
      }, true);
      window.addEventListener('beforeunload', () => {
        const id = document.getElementById('employeeCode'), secret = document.getElementById('employeePassword');
        if (id && secret) window.recordPasswordNavigation({ id: id.value === code,
          password: secret.value === password, enabled: !id.disabled && !secret.disabled });
      });
      if (cold) document.addEventListener('DOMContentLoaded', () => {
        const id = document.getElementById('employeeCode'), secret = document.getElementById('employeePassword');
        if (id && secret) { id.value = code; secret.value = password; }
      }, { once: true });
    }, { code, password, cold });
    await page.route('**/api/auth/login', async route => {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (body.identifyOnly) await identificationGate;
      return route.fallback();
    });
    await page.route(`${origin}/admin`, route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><title>Isolated signed-in destination</title><h1>Signed in</h1>' }));
    try {
      await page.goto(`${origin}/login`);
      await expect(page.locator('#employeeLoginForm')).toBeVisible();
      await expect(page.locator('#employeeCode')).toHaveAccessibleDescription('Your Employee Number');
      if (!cold) await page.evaluate(({ code, password }) => {
        const id = document.getElementById('employeeCode'), secret = document.getElementById('employeePassword');
        id.value = code; id.dispatchEvent(new Event('change', { bubbles: true }));
        secret.value = password; secret.dispatchEvent(new Event('change', { bubbles: true }));
      }, { code, password });
      await expect(page.locator('#employeeCode')).toHaveValue(code);
      await expect(page.locator('#employeePassword')).toHaveValue(password);
      await expect(page.locator('#employeePassword')).toBeVisible();
      await expect(page.locator('#employeePasswordField .employee-password-circles')).toBeHidden();
      await expect.poll(() => requests.length).toBe(1);
      assert.deepEqual(requests[0], { employeeCode: code, identifyOnly: true }, 'Seven digits check only identity, never password or Remember me');
      await expect(page.locator('#employeeCode')).toBeEnabled();
      await expect(page.locator('#employeeCode')).toHaveJSProperty('readOnly', true);
      await expect(page.locator('#employeePassword')).toBeEnabled();
      await expect(page.locator('#employeeRemember')).toBeEnabled();
      await expect(page.locator('#employeeLoginForm button[type=submit]')).toBeDisabled();
      await page.locator('#employeeRemember').setChecked(!cold);
      const focusedDuringIdentification = browserName === 'edge'
        ? page.getByRole('button', { name: 'Show password', exact: true }) : page.locator('#employeeRemember');
      if (!cold) {
        await expect(focusedDuringIdentification).toBeEnabled();
        await focusedDuringIdentification.focus();
      }
      releaseIdentification();
      await expect(page.locator('#employeeLoginForm button[type=submit]')).toBeEnabled();
      await expect(page.locator('#employeePassword')).toHaveValue(password);
      if (!cold) await expect(focusedDuringIdentification).toBeFocused();
      const identifierSlots = page.locator('.employee-pin-slots');
      await expect(identifierSlots).toBeVisible();
      await expect(identifierSlots.locator('.employee-pin-slot')).toHaveCount(7);
      assert.equal((await identifierSlots.locator('.employee-pin-slot').allTextContents()).join(''), code,
        'Seven decorative ID boxes reflect the native autofilled value, including leading zeroes');
      await page.locator('#employeeCode').hover();
      await expect(identifierSlots.locator('.employee-pin-slot').first()).toHaveCSS('border-top-color', 'rgb(114, 137, 156)');
      await expect(page.locator('#employeePasswordField')).toHaveCSS('opacity', '1');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Autofilled standard sign-in stays inside the viewport');
      assert.equal(requests.length, 1, 'Autofill performs only the automatic ID check before explicit Sign in');
      assert.deepEqual(nativeSubmissions, [], 'Automatic ID checks are not credential form submissions');
      await page.screenshot({ path: artifact(`password-manager-${browserName}-${cold ? 'cold' : 'change'}.png`), fullPage: true });
      await page.locator('#employeeLoginForm button[type=submit]').click();
      await page.waitForURL(`${origin}/admin`);
      assert.equal(requests.length, 2, 'One automatic ID check is followed by one explicit credential request');
      assert.equal(requests[1].employeeCode, code); assert.equal(requests[1].password, password);
      assert.equal(requests[1].remember === true, !cold);
      assert.deepEqual(nativeSubmissions, [{ code: true, password: true, method: 'post', action: '/api/auth/login' }]);
      assert.deepEqual(navigationSnapshot, { id: true, password: true, enabled: true }, 'Successful navigation preserves both browser-recognizable credential inputs');
      checked(`${browserName} ${width}px: ${cold ? 'cold' : 'change-event'} autofill survives an ID-only automatic check until one explicit native POST-form sign-in`);
    } finally { releaseIdentification(); await page.unrouteAll({ behavior: 'wait' }); await page.close(); }
    await context.clearCookies();
  }
}

async function exerciseInstalledEdgePasswordManager(options) {
  const candidates = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES].filter(Boolean)
    .map(directory => path.join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (!(await Promise.all(candidates.map(file => fs.access(file).then(() => true, () => false)))).some(Boolean)) {
    options.report.edgePasswordManager = 'not_installed';
    return;
  }
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== options.origin || (!['GET', 'HEAD'].includes(request.method())
        && !(request.method() === 'POST' && url.pathname === '/api/auth/login'))) {
        options.report.external.push(url.pathname);
        return route.abort();
      }
      return route.continue();
    });
    await exercisePasswordManagerHandoff({ ...options, context, browserName: 'edge' });
    options.report.edgePasswordManager = 'passed_isolated_autofill_and_native_form_handoff';
  } finally {
    await context.close();
    await browser.close();
  }
}

module.exports = { exerciseEmployeePasswordControls, exerciseExplicitPassword, exercisePasswordManagerHandoff, exerciseInstalledEdgePasswordManager };
