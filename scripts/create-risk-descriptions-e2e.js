// Read-only browser guidance acceptance with disposable memory masters/drafts.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, expect: baseExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { categorySettings } = require('../src/changeCategories');
const { memoryRepository, fakeAuthService, unsignedPayload, TEST_PASSWORD } = require('../test/helpers/apiHarness');
const expect = baseExpect.configure({ timeout: 12000 });
const artifact = name => path.resolve('test-results', `create-risk-descriptions-${name}`);
const unsafeText = '<img src=x onerror="window.riskInjected=true"> Configured raw material specification wording that remains literal and readable in the full guidance list, including its complete final sentence.';
const admin = { id: 'admin-id', username: 'admin', roles: ['admin'], isActive: true };

class RiskPage {
  constructor(page, origin) { this.page = page; this.origin = origin; }
  trigger() { return this.page.locator('#riskLevelTrigger'); }
  popup() { return this.page.locator('#riskLevelOptions'); }
  choice(value) { return this.page.locator(`[data-risk-value="${value}"]`); }
  async open(draft) {
    await this.page.goto(`${this.origin}/create${draft ? `?draft=${draft.id}` : ''}`);
    if (!draft) await this.page.locator('#startBlank').click();
    await expect(this.page.locator('#createEditor')).toBeVisible();
    await expect(this.trigger()).toBeEnabled();
    await expect(this.page.locator('#riskLevel')).toBeHidden();
  }
  async expand() {
    if (await this.trigger().getAttribute('aria-expanded') !== 'true') await this.trigger().click();
    await expect(this.trigger()).toHaveAttribute('aria-expanded', 'true');
    await expect(this.trigger()).toHaveAttribute('aria-controls', 'riskLevelOptions');
    await expect(this.popup()).toBeVisible(); await expect(this.popup()).toHaveAttribute('role', 'listbox');
  }
  async close() {
    await this.trigger().press('Escape');
    await expect(this.popup()).toBeHidden(); await expect(this.trigger()).toHaveAttribute('aria-expanded', 'false');
    await expect(this.trigger()).toBeFocused();
  }
  async risk(value) {
    await this.expand(); await this.choice(value).click();
    await expect(this.page.locator('#riskLevel')).toHaveValue(value);
    await expect(this.page.locator('#riskLevelValue')).toHaveText(value);
    await expect(this.trigger()).toHaveText(value); await expect(this.popup()).toBeHidden();
  }
  async guidance(form) {
    const native = this.page.locator('#riskLevel');
    assert.deepEqual(await native.locator('option').evaluateAll(items => items.map(item => item.value)), ['RL3', 'RL2', 'RL1', 'RL0']);
    await expect(this.trigger()).toHaveAttribute('aria-describedby', /riskLevelHelp/);
    assert.equal(await this.page.locator('#riskLevelError').count(), 1);
    await this.expand(); await expect(this.popup().locator('[data-risk-value]')).toHaveCount(4);
    for (const risk of ['RL3', 'RL2', 'RL1', 'RL0']) {
      await expect(this.page.locator(`#riskLevelHeading-${risk}`)).toHaveText(risk);
      const texts = form.riskOptions.filter(option => option.risk === risk && option.enabled !== false).map(option => option.text);
      const descriptions = this.page.locator(`#riskLevelDescriptions-${risk}`);
      assert.deepEqual(await descriptions.locator('li').allTextContents(), texts);
      if (!texts.length) await expect(descriptions).toContainText(/no.*description/i);
    }
    await expect(this.popup().locator('img')).toHaveCount(0);
    assert.equal(await this.page.evaluate(() => window.riskInjected), undefined);
  }
}

async function main() {
  const report = { storage: 'isolated_memory_only', checks: [], browserWrites: [], errors: [], external: [] };
  const check = message => { report.checks.push(message); console.log(message); };
  const repository = memoryRepository(), service = new PcnService(repository), master = await repository.getMasterData();
  const draft = await service.create({ ...unsignedPayload, documentType: 'ta', status: 'draft' }, 'user:admin-id', admin);
  const before = await repository.findById(draft.id), revisions = await repository.getRevisions(draft.id);
  let handler, browser, context, page;
  const server = http.createServer((request, response) => handler(request, response));
  try {
    await fs.mkdir('test-results', { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    handler = createRequestHandler({ repository, service, authService: fakeAuthService(), publicOrigin: origin, secureCookies: false,
      documents: { async list() { return []; }, async listForRecords(ids) {
        return new Map(await Promise.all(ids.map(async id => [id, { parentVersion: (await repository.findById(id))?.version, attachments: [] }])));
      } } });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
      if (!['GET', 'HEAD'].includes(request.method())) { report.browserWrites.push({ method: request.method(), path: url.pathname }); return route.abort(); }
      if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
      return route.continue();
    });
    const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username: 'admin', password: TEST_PASSWORD } });
    assert.equal(login.status(), 200);
    async function open(draft) {
      page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => report.errors.push(error.message));
      if (draft) await page.clock.install();
      const ui = new RiskPage(page, origin); await ui.open(draft); return ui;
    }
    let ui = await open();
    await ui.risk('RL2');
    assert(!(await page.locator('.create-risk-field').innerText()).includes(unsignedPayload.selectedChange), 'Collapsed field shows only the risk code');
    await page.screenshot({ path: artifact('collapsed-desktop.png') });
    await ui.guidance(master.formDefinitions.rawMaterial);
    await page.screenshot({ path: artifact('raw-material-desktop.png') });
    await ui.trigger().press('Home'); await expect(page.locator('#riskLevel')).toHaveValue('RL2');
    await ui.close(); await expect(page.locator('#riskLevelValue')).toHaveText('RL2');
    await ui.expand(); await ui.trigger().press('End');
    await page.locator('#manufacturerName').click(); await expect(ui.popup()).toBeHidden();
    await expect(page.locator('#riskLevel')).toHaveValue('RL2');
    await ui.expand();
    await page.evaluate(() => window.scrollTo(0, scrollY > 0 ? 0 : Math.min(60, document.documentElement.scrollHeight - innerHeight)));
    await expect(ui.popup()).toBeHidden(); await expect(page.locator('#riskLevel')).toHaveValue('RL2');
    await ui.expand(); await ui.trigger().press('Home'); await ui.trigger().press('Enter');
    await expect(page.locator('#riskLevel')).toHaveValue('RL3'); await expect(ui.trigger()).toHaveText('RL3'); await expect(ui.trigger()).toBeFocused();
    await ui.expand(); await ui.trigger().press('Home'); await ui.trigger().press('ArrowDown'); await ui.trigger().press('Enter');
    await expect(page.locator('#riskLevel')).toHaveValue('RL2'); await expect(ui.trigger()).toHaveText('RL2'); await expect(ui.trigger()).toBeFocused();
    check('Collapsed risk field shows only its code; the grouped popup exposes all four risks and full configured descriptions, supports keyboard commit, and cancels pending choices on Escape or outside click');

    await page.locator('#changeForm').selectOption('packaging');
    await ui.risk('RL2'); await ui.guidance(master.formDefinitions.packaging);
    await page.screenshot({ path: artifact('packaging-desktop.png') });
    await ui.choice('RL0').click(); await expect(page.locator('#riskLevel')).toHaveValue('RL0'); await expect(ui.trigger()).toHaveText('RL0');
    check('Changing forms replaces every grouped description; empty Packaging RL0 remains selectable and does not force a different risk');

    const oldSettings = categorySettings(master), raw = oldSettings.forms.rawMaterial;
    const first = raw.findIndex(option => option.risk === 'RL2'), second = raw.findIndex((option, index) => index > first && option.risk === 'RL2');
    await repository.saveChangeCategories({ ...oldSettings, reason: 'Isolated risk guidance publication', forms: { ...oldSettings.forms,
      rawMaterial: raw.map((option, index) => index === first ? { ...option, text: unsafeText } : index === second ? { ...option, enabled: false } : { ...option }) } }, 'user:admin-id', admin);
    const latest = await repository.getMasterData();
    ui = await open(); await ui.risk('RL2');
    await ui.guidance(latest.formDefinitions.rawMaterial);
    assert(!(await ui.popup().textContent()).includes(raw[second].text), 'Disabled latest options are not exposed');
    await page.screenshot({ path: artifact('latest-desktop.png') });
    await page.setViewportSize({ width: 320, height: 844 });
    await expect(ui.popup()).toBeHidden(); await expect(page.locator('#riskLevel')).toHaveValue('RL2');
    await ui.trigger().scrollIntoViewIfNeeded(); await ui.expand();
    await expect(ui.trigger()).toBeFocused();
    const popupBox = await ui.popup().boundingBox();
    assert.ok(popupBox.x >= 0 && popupBox.y >= 0 && popupBox.x + popupBox.width <= 321 && popupBox.y + popupBox.height <= 845, 'Risk popup stays inside the mobile viewport');
    const geometry = await ui.popup().evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
    assert.ok(geometry.client <= 600 && ['auto', 'scroll'].includes(geometry.overflow), 'Long grouped descriptions scroll within a bounded mobile popup');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Risk guidance fits 320px');
    await page.screenshot({ path: artifact('mobile-320.png') });
    await ui.trigger().press('Tab'); await expect(ui.popup()).toBeHidden();
    await expect(page.locator('#riskLevel')).toHaveValue('RL2');
    check('New documents use latest enabled administrator wording safely; the 320px popup stays bounded and scrollable, and Tab closes without changing the committed code');

    ui = await open(draft);
    await expect(page.locator('#riskLevel')).toHaveValue('RL2');
    await ui.guidance(master.formDefinitions.rawMaterial);
    assert(!(await ui.popup().textContent()).includes(unsafeText));
    await page.screenshot({ path: artifact('pinned-draft-desktop.png') });
    await ui.trigger().press('Home'); await ui.close();
    await ui.risk('RL2');
    await page.locator('[data-stage="changes"]').click();
    await expect(page.locator('#changeCategory')).toHaveValue(draft.selectedChange);
    await page.clock.fastForward(11001);
    assert.deepEqual(await repository.findById(draft.id), before); assert.deepEqual(await repository.getRevisions(draft.id), revisions);
    assert.equal((await repository.list()).length, 1);
    assert.deepEqual(report.browserWrites, []); assert.deepEqual(report.external, []); assert.deepEqual(report.errors, []);
    check('Resumed owned drafts retain their pinned descriptions after publication; all guidance interactions are browser GET-only and leave documents, bindings and audit history unchanged');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
    if (page) await page.screenshot({ path: artifact('failure.png'), fullPage: true }).catch(() => {});
  } finally {
    if (context) await context.close(); if (browser) await browser.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await fs.writeFile(artifact('acceptance.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
