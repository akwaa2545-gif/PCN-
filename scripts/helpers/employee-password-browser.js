// Isolated employee-password browser controls; never calls a live account.
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

async function exerciseEmployeeCircleControls({ page, report, passwords, artifact, checked, assertPasswordCircles }) {
  const passwordRequestsBefore = report.authRequests.length;
  const remember = page.getByRole('checkbox', { name: 'Remember me', exact: true });
  const passwordControl = page.locator('#employeePassword');
  await expect(remember).not.toBeChecked();
  await expect(remember).toBeEnabled();
  await expect(passwordControl).toHaveAttribute('autocomplete', 'current-password');
  await expect(passwordControl).toHaveAttribute('maxlength', '8');
  await expect(page.locator('#employeeLoginForm input[name="password"]')).toHaveCount(1);
  await assertPasswordCircles(page, '');
  await page.screenshot({ path: artifact('circles-empty-desktop.png'), fullPage: true });
  await passwordControl.click();
  await expect(passwordControl).toBeFocused();
  await expect(page.locator('#employeePasswordDigit1')).toHaveClass(/is-active/);
  await passwordControl.pressSequentially(passwords.mixed.slice(0, 7));
  await expect(passwordControl).toHaveValue(passwords.mixed.slice(0, 7));
  await assertPasswordCircles(page, passwords.mixed.slice(0, 7));
  await passwordControl.press('Backspace');
  await expect(passwordControl).toHaveValue('Ab12Cd');
  await assertPasswordCircles(page, 'Ab12Cd');
  await page.evaluate(value => navigator.clipboard.writeText(value), passwords.letters.slice(0, 7));
  await passwordControl.press('Control+A');
  await passwordControl.press('Control+V');
  await expect(passwordControl).toHaveValue(passwords.letters.slice(0, 7));
  await assertPasswordCircles(page, passwords.letters.slice(0, 7));
  await passwordControl.press('Control+A');
  await passwordControl.pressSequentially(passwords.mixed.slice(0, 7));
  await expect(passwordControl).toHaveValue(passwords.mixed.slice(0, 7));
  await assertPasswordCircles(page, passwords.mixed.slice(0, 7));
  await passwordControl.evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'a1B2');
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await assertPasswordCircles(page, 'a1B2');
  await passwordControl.fill(passwords.mixed.slice(0, 7));
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(passwordControl).toHaveAttribute('type', 'text');
  await expect(passwordControl).toHaveValue(passwords.mixed.slice(0, 7));
  await assertPasswordCircles(page, passwords.mixed.slice(0, 7), true);
  await page.screenshot({ path: artifact('circles-shown-desktop.png'), fullPage: true });
  await expect(page.locator('#employeePasswordToggle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Hide password', exact: true }).press('Enter');
  await expect(passwordControl).toHaveAttribute('type', 'password');
  await expect(passwordControl).toHaveValue(passwords.mixed.slice(0, 7));
  await assertPasswordCircles(page, passwords.mixed.slice(0, 7));
  await page.locator('#employeeCode').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Show password', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(passwordControl).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(remember).toBeFocused();
  await page.keyboard.press('Space');
  await expect(remember).toBeChecked();
  assert.equal(report.authRequests.length, passwordRequestsBefore, 'Visibility and Remember me controls never submit credentials');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
    await passwordControl.scrollIntoViewIfNeeded();
    const bounds = await page.locator('#employeePasswordField').evaluate(node => {
      const field = node.getBoundingClientRect(), input = node.querySelector('#employeePassword').getBoundingClientRect();
      const frame = node.querySelector('.employee-password-circles').getBoundingClientRect();
      const toggle = node.querySelector('#employeePasswordToggle').getBoundingClientRect();
      const options = node.querySelector('.employee-signin-options').getBoundingClientRect();
      const rememberLabel = node.querySelector('.employee-remember');
      return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, fieldLeft: field.left, fieldRight: field.right,
        inputLeft: input.left, inputRight: input.right, frameLeft: frame.left, frameRight: frame.right,
        inputWidth: input.width, frameBottom: frame.bottom, frameHeight: frame.height,
        toggleLeft: toggle.left, toggleRight: toggle.right, toggleBottom: toggle.bottom,
        frameTop: frame.top, toggleHeight: toggle.height, toggleWidth: toggle.width,
        slots: [...node.querySelector('.employee-password-circles').children].map(slot => {
          const rect = slot.getBoundingClientRect(), style = getComputedStyle(slot);
          return { left: rect.left, right: rect.right, width: rect.width, height: rect.height,
            radius: style.borderTopLeftRadius, pointerEvents: style.pointerEvents };
        }),
        optionsLeft: options.left, optionsRight: options.right, rememberTop: rememberLabel.getBoundingClientRect().top,
        rememberPosition: getComputedStyle(rememberLabel).position };
    });
    assert(bounds.scrollWidth <= bounds.viewport, `${width}px login has no horizontal overflow`);
    assert(bounds.frameHeight >= 28 && bounds.toggleHeight >= 44, 'Circles remain legible and the visibility button is a large target');
    assert(bounds.toggleWidth <= 80 && bounds.inputWidth >= 200,
      `${width}px native password field remains usable across the circle row: ${JSON.stringify(bounds)}`);
    assert(bounds.fieldLeft >= 0 && bounds.fieldRight <= width);
    assert(bounds.inputLeft >= bounds.frameLeft && bounds.inputRight <= bounds.frameRight);
    assert(bounds.toggleLeft >= bounds.fieldLeft && bounds.toggleRight <= bounds.fieldRight);
    assert(bounds.toggleBottom <= bounds.frameTop + 1, 'Show/Hide sits above the circles without covering a slot');
    assert(bounds.optionsLeft >= bounds.fieldLeft && bounds.optionsRight <= bounds.fieldRight);
    for (const slot of bounds.slots) {
      assert(slot.left >= bounds.frameLeft - 1 && slot.right <= bounds.frameRight + 1, `${width}px circles fit inside their row`);
      assert(Math.abs(slot.width - slot.height) <= 1, 'Password indicators are circular');
      assert(slot.radius.endsWith('%') ? parseFloat(slot.radius) >= 50 : parseFloat(slot.radius) >= slot.width / 2 - 1,
        'Password indicators have round borders');
      assert.equal(slot.pointerEvents, 'none', 'Decorative slots do not intercept native password editing');
    }
    assert.equal(bounds.rememberPosition, 'static', 'The checked/focused Remember me label does not inherit floating-label positioning');
    assert(bounds.rememberTop >= bounds.frameBottom, 'Remember me remains below the password control');
    await page.screenshot({ path: artifact(`circles-${width === 1440 ? 'desktop' : `mobile-${width}`}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(page.locator('#employeePasswordField .employee-password-circles')).toBeHidden();
  const forcedInput = await passwordControl.evaluate(input => {
    const style = getComputedStyle(input);
    return { color: style.color, textFill: style.webkitTextFillColor, caret: style.caretColor, border: parseFloat(style.borderTopWidth) };
  });
  assert(forcedInput.border >= 1 && ![forcedInput.color, forcedInput.textFill, forcedInput.caret].some(color => color === 'transparent' || color === 'rgba(0, 0, 0, 0)'),
    'Forced colors restores a visible native password control, text and caret');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(passwordControl).toHaveAttribute('type', 'text');
  await page.screenshot({ path: artifact('circles-forced-colors.png'), fullPage: true });
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await page.emulateMedia({ forcedColors: 'none' });
  await assertPasswordCircles(page, passwords.mixed.slice(0, 7));
  checked('Eight-circle field preserves partial typing, paste, Backspace, selection, autofill updates and Show/Hide without submitting');
  checked('Heading toggle and Remember me work by keyboard; circles fit desktop/390px/320px and forced colors restores the native field');
  await page.screenshot({ path: artifact('login-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(passwordControl).toHaveValue('');
  await expect(passwordControl).toHaveAttribute('type', 'password');
  await assertPasswordCircles(page, '');
  assert.equal(report.authRequests.length, passwordRequestsBefore, 'Editing, visibility, keyboard and pagehide never submit credentials');
  return { remember, passwordControl, passwordRequestsBefore };
}

async function exerciseAutomaticPassword({ page, report, passwords, artifact, checked, assertPasswordCircles }) {
  const input = page.locator('#employeePassword');
  const remember = page.locator('#employeeRemember');
  const requests = [];
  let release, pendingGate, triggerName;
  const rejectCredential = async route => {
    const body = route.request().postDataJSON();
    if (body?.identifyOnly) return route.fallback();
    requests.push({ trigger: triggerName, fields: Object.keys(body), remember: body.remember === true });
    await pendingGate;
    return route.fulfill({ status: 401, contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Synthetic automatic-password rejection' }) });
  };
  async function attempt(name, selectRemember, trigger) {
    triggerName = name;
    pendingGate = new Promise(resolve => { release = resolve; });
    const before = requests.length;
    await remember.setChecked(selectRemember);
    await trigger();
    await expect.poll(() => requests.length).toBe(before + 1);
    await expect(input).toBeDisabled();
    await expect(input).toHaveAttribute('type', 'password');
    await expect(page.locator('#employeePasswordToggle')).toBeDisabled();
    await expect(remember).toBeDisabled();
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');
    await page.locator('#employeeLoginForm').dispatchEvent('submit');
    assert.equal(requests.length, before + 1, 'Pending input/change/submit events cannot duplicate automatic sign-in');
    assert.equal(requests.at(-1).remember, selectRemember, 'Remember me is captured before the eighth character');
    if (name === 'eighth typed character') {
      await assertPasswordCircles(page, passwords.mixed);
      await page.screenshot({ path: artifact('automatic-password-pending-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 320, height: 844 });
      await page.screenshot({ path: artifact('automatic-password-pending-mobile-320.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    release();
    await expect(page.locator('#employeeAuthMessage')).toHaveText('Synthetic automatic-password rejection');
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('');
    await assertPasswordCircles(page, '');
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');
    assert.equal(requests.length, before + 1, 'Clearing and error events never retry automatically');
  }
  await page.route('**/api/auth/login', rejectCredential);
  try {
    await input.fill(passwords.mixed.slice(0, 7));
    assert.equal(requests.length, 0, 'Seven password characters do not submit');
    await page.locator('#employeePasswordToggle').click();
    await expect(input).toHaveAttribute('type', 'text');
    await attempt('eighth typed character', true, () => input.pressSequentially(passwords.mixed.at(-1)));
    await expect(remember).toBeChecked();
    await page.evaluate(value => navigator.clipboard.writeText(value), passwords.letters);
    await attempt('full clipboard paste', false, async () => {
      await input.focus();
      await input.press('Control+V');
    });
    await attempt('autofill change event', false, () => input.evaluate((node, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, passwords.numeric));
    await attempt('manual fallback without autofill events', false, async () => {
      await input.evaluate((node, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
      }, passwords.numeric);
      assert.equal(requests.length, 3, 'Programmatic autofill without events waits for manual Sign in');
      await page.locator('#employeeLoginForm button[type=submit]').click();
    });
    await input.fill('abcd!efg');
    assert.equal(requests.length, 4, 'Unsupported characters cannot start automatic sign-in');
    await input.fill('');
    report.automaticPasswordRequests = requests;
    checked('Eighth typed character, full paste and autofill change auto-submit once; pending/clearing events never duplicate or retry, and Remember me is captured before completion');
    checked('Wrong-password reentry can retry, manual Sign in supports event-free autofill, and invalid or incomplete passwords never auto-submit');
  } finally {
    release?.();
    await page.unroute('**/api/auth/login', rejectCredential);
  }
}

module.exports = { exerciseEmployeeCircleControls, exerciseAutomaticPassword };
