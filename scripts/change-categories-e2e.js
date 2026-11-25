// Versioned Content of Changes acceptance on disposable loopback memory data only.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, expect: baseExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { applyDocumentControl } = require('../src/documentControl');
const { categorySettings } = require('../src/changeCategories');
const { memoryRepository, fakeAuthService, unsignedPayload, TEST_PASSWORD } = require('../test/helpers/apiHarness');
const expect = baseExpect.configure({ timeout: 12000 });
const artifact = name => path.resolve('test-results', `change-categories-${name}`);
const admin = { id: 'admin-id', username: 'admin', roles: ['admin'], displayName: 'Fixture administrator', isActive: true };
const malicious = '<img src=x onerror="window.masterInjected=true"> New master option';

async function fixture() {
  const repository = memoryRepository(), service = new PcnService(repository);
  const master = await repository.getMasterData();
  const draft = await service.create({ ...unsignedPayload, documentType: 'ta', supplierName: 'Pinned TA draft', status: 'draft' }, 'user:admin-id', admin);
  // This option will be disabled for future PCNs; the signed SC must retain it.
  const option = master.formDefinitions.packaging.riskOptions[1];
  const signed = await service.create({ ...unsignedPayload, documentType: 'sc', supplierName: 'Pinned signed SC', status: 'submitted',
    changeForm: 'packaging', riskLevel: option.risk, selectedChange: option.text,
    currentCondition: 'Old packaging', newCondition: 'Updated packaging',
    changeRows: [{ optionText: option.text, text: option.text, risk: option.risk, currentCondition: 'Old packaging', newCondition: 'Updated packaging' }] }, 'user:admin-id', admin);
  const { documentType: omitted, ...legacyInput } = unsignedPayload;
  const normalized = service.normalizeInput({ ...legacyInput, supplierName: 'Pinned legacy PCN', status: 'submitted' });
  const now = new Date().toISOString();
  const legacy = await repository.create(applyDocumentControl(null, { ...normalized, ownerUserId: admin.id, createdAt: now, updatedAt: now,
    submittedAt: now, documents: [], route: [], internalReview: { signoff: { gscTet: { prepared: true, preparedName: 'Legacy signer' } } } }, admin, now), 'Legacy fixture', admin);
  return { repository, service, master, draft, signed, legacy };
}

class CategoriesPage {
  constructor(page, origin) { this.page = page; this.origin = origin; }
  field(form, index, key) { return this.page.locator(`#changeCategory-${form}-${index}-${key}`); }
  group(form, risk) { return this.page.locator(`#changeCategoriesRisk-${form}-${risk}`); }
  async expand(form, risk) {
    const group = this.group(form, risk);
    if (!(await group.evaluate(element => element.open))) await group.locator('summary').click();
  }
  async expandAll() {
    for (const form of ['rawMaterial', 'packaging']) for (const risk of ['RL3', 'RL2', 'RL1', 'RL0']) await this.expand(form, risk);
  }
  async open() {
    await this.page.goto(`${this.origin}/system-settings`);
    await expect(this.page.locator('#settingsHome')).toBeVisible();
    await this.page.locator('#settingsChangeCategories').focus();
    await this.page.keyboard.press('Enter');
    await expect(this.page.locator('#changeCategoriesTitle')).toBeFocused();
    await expect(this.page.locator('#settingsStatus')).toContainText('Content of Changes loaded.');
  }
  async save(reason, status = 200) {
    await this.page.locator('#changeCategoriesReason').fill(reason);
    const response = this.page.waitForResponse(item => new URL(item.url()).pathname === '/api/admin/change-categories' && item.request().method() === 'PUT');
    await this.page.locator('#changeCategoriesSave').click();
    const result = await response;
    assert.equal(result.status(), status, await result.text());
    if (status === 200) await expect(this.page.locator('#settingsStatus')).toContainText('Content of Changes saved for new PCNs.');
    return (await result.json()).data;
  }
}

async function main() {
  const report = { storage: 'isolated_memory_only', checks: [], browserWrites: [], errors: [], external: [] };
  const check = message => { report.checks.push(message); console.log(message); };
  const system = await fixture(), { repository, service, master, draft, signed, legacy } = system;
  let handler, browser, context, page;
  const server = http.createServer((request, response) => handler(request, response));
  try {
    await fs.mkdir('test-results', { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const documents = { async list() { return []; }, async listForRecords(ids) {
      return new Map(await Promise.all(ids.map(async id => [id, { parentVersion: (await repository.findById(id))?.version, attachments: [] }])));
    } };
    handler = createRequestHandler({ repository, service, documents, authService: fakeAuthService(), publicOrigin: origin, secureCookies: false });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
      if (!['GET', 'HEAD'].includes(request.method())) report.browserWrites.push({ method: request.method(), path: url.pathname });
      return route.continue();
    });
    async function login(username) {
      const response = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: TEST_PASSWORD } });
      assert.equal(response.status(), 200, await response.text()); return (await response.json()).data;
    }
    const principal = await login('admin'), headers = { origin, 'x-csrf-token': principal.csrfToken };
    page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
    const ui = new CategoriesPage(page, origin);
    await ui.open();
    await expect(page.locator('#changeCategoriesVersion')).toContainText('1');
    await expect(ui.group('rawMaterial', 'RL3')).toHaveAttribute('open', '');
    await expect(ui.group('rawMaterial', 'RL2')).not.toHaveAttribute('open', '');
    await ui.group('rawMaterial', 'RL2').locator('summary').focus(); await page.keyboard.press('Enter');
    await expect(ui.group('rawMaterial', 'RL2')).toHaveAttribute('open', '');
    await page.keyboard.press('Enter'); await expect(ui.group('rawMaterial', 'RL2')).not.toHaveAttribute('open', '');
    await ui.expandAll();
    const rawIndex = master.formDefinitions.rawMaterial.riskOptions.findIndex(row => row.text === unsignedPayload.selectedChange);
    const rawAdded = master.formDefinitions.rawMaterial.riskOptions.length;
    const packagingAdded = master.formDefinitions.packaging.riskOptions.length;
    await ui.field('rawMaterial', rawIndex, 'text').fill('Updated specification wording for future PCNs');
    await ui.field('rawMaterial', rawIndex, 'risk').selectOption('RL1');
    await expect(ui.group('rawMaterial', 'RL1').locator(`#changeCategory-rawMaterial-${rawIndex}-risk`)).toHaveValue('RL1');
    await expect(ui.field('rawMaterial', rawIndex, 'risk')).toBeFocused();
    await ui.field('rawMaterial', 0, 'enabled').uncheck();
    await page.locator('#changeCategoriesAdd-rawMaterial-RL3').click();
    await expect(ui.field('rawMaterial', rawAdded, 'text')).toBeFocused();
    await expect(ui.field('rawMaterial', rawAdded, 'risk')).toHaveValue('RL3');
    await ui.field('rawMaterial', rawAdded, 'text').fill(malicious);
    await ui.field('rawMaterial', rawAdded, 'risk').selectOption('RL3');
    await ui.field('packaging', 0, 'text').fill('Updated packaging wording for future PCNs');
    await ui.field('packaging', 0, 'risk').selectOption('RL1');
    await ui.field('packaging', 1, 'enabled').uncheck();
    await ui.expand('packaging', 'RL0');
    await page.locator('#changeCategoriesAdd-packaging-RL0').click();
    await expect(ui.field('packaging', packagingAdded, 'risk')).toHaveValue('RL0');
    await ui.field('packaging', packagingAdded, 'text').fill('Added packaging option for future PCNs');
    await ui.field('packaging', packagingAdded, 'risk').selectOption('RL0');
    const saved = await ui.save('Publish future-PCN wording, risk, enabled state and new options');
    assert.equal(saved.versionId, 2);
    const publication = (await repository.getMasterData()).changeCategoriesPublication;
    assert.equal(publication.reason, 'Publish future-PCN wording, risk, enabled state and new options');
    assert.equal(publication.actor, 'user:admin-id');
    await expect(page.locator('#changeCategoriesRows img')).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.masterInjected), undefined);
    await page.locator('#settingsReload').click();
    await expect(page.locator('#settingsStatus')).toContainText('Content of Changes loaded.');
    await expect(ui.field('rawMaterial', rawIndex, 'text')).toHaveValue('Updated specification wording for future PCNs');
    await expect(ui.field('rawMaterial', rawIndex, 'risk')).toHaveValue('RL1');
    await expect(ui.field('rawMaterial', 0, 'enabled')).not.toBeChecked();
    await expect(ui.field('rawMaterial', rawAdded, 'text')).toHaveValue(malicious);
    await expect(ui.field('packaging', packagingAdded, 'risk')).toHaveValue('RL0');
    await page.screenshot({ path: artifact('settings-desktop.png'), fullPage: true });
    check('Collapsible RL groups support keyboard toggling and per-risk Add assigns its risk; publishing both forms preserves wording/RL/disabled/new options, version2 audit and inert HTML-like text');

    const latest = await (await context.request.get(`${origin}/api/master-data`)).json();
    assert.equal(latest.data.versionId, 2);
    assert.equal(latest.data.formDefinitions.rawMaterial.riskOptions.some(row => row.text === master.formDefinitions.rawMaterial.riskOptions[0].text), false);
    assert.equal(latest.data.formDefinitions.packaging.riskOptions.some(row => row.text === master.formDefinitions.packaging.riskOptions[1].text), false);
    for (const record of [draft, signed, legacy]) {
      const response = await context.request.get(`${origin}/api/pcns/${record.id}/master-data`);
      assert.equal(response.status(), 200); const pinned = (await response.json()).data;
      assert.deepEqual(pinned.formDefinitions.rawMaterial.riskOptions, master.formDefinitions.rawMaterial.riskOptions);
      assert.deepEqual(pinned.formDefinitions.packaging.riskOptions, master.formDefinitions.packaging.riskOptions);
    }
    check('Latest public master hides disabled options while existing TA, signed SC and legacy PCNs retain their original master snapshots');

    async function newDraft(type, form, risk, optionText) {
      await page.goto(`${origin}/create`); await page.locator('#startBlank').click();
      await page.getByRole('radio', { name: type.toUpperCase(), exact: true }).check();
      await page.locator('#supplierName').fill(`New ${type.toUpperCase()} master fixture`);
      await page.locator('#materialName').fill('Synthetic future material');
      await page.locator('#changeForm').selectOption(form);
      await page.locator('#riskLevelTrigger').click();
      await page.locator(`[data-risk-value="${risk}"]`).click();
      await page.locator('[data-stage="changes"]').click();
      await page.locator('#changeCategory').selectOption(optionText);
      await expect(page.locator('#changeCategory')).toHaveValue(optionText);
      await expect(page.locator('#changeCategory img')).toHaveCount(0);
      assert.equal(await page.evaluate(() => window.masterInjected), undefined);
      const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/pcn-drafts' && item.request().method() === 'POST');
      await page.locator('#saveDraftButton').click();
      const saved = await response; assert.equal(saved.status(), 201, await saved.text());
      const record = (await saved.json()).data.record;
      assert.equal(record.masterDataVersionId, 2); assert.equal(record.selectedChange, optionText); assert.equal(record.riskLevel, risk);
      await expect(page.locator('#draftIdentity')).toHaveText(record.id);
      return record;
    }
    await newDraft('ta', 'rawMaterial', 'RL3', malicious);
    await newDraft('sc', 'packaging', 'RL0', 'Added packaging option for future PCNs');
    check('New TA and SC guided drafts use newly published options and RL values, pin version2, and safely display literal HTML-like option text');

    await page.goto(`${origin}/create?draft=${draft.id}`);
    await expect(page.locator('#draftIdentity')).toHaveText(draft.id);
    await expect(page.locator('#riskLevel')).toHaveValue('RL2');
    await page.locator('[data-stage="changes"]').click();
    await expect(page.locator('#changeCategory')).toHaveValue(unsignedPayload.selectedChange);
    await page.locator('#reason').fill('Pinned draft still saves under its original categories');
    const resumeSave = page.waitForResponse(item => new URL(item.url()).pathname === `/api/pcn-drafts/${draft.id}` && item.request().method() === 'PATCH');
    await page.locator('#saveDraftButton').click(); assert.equal((await resumeSave).status(), 200);
    const resumed = await repository.findById(draft.id);
    assert.equal(resumed.masterDataVersionId, 1); assert.equal(resumed.riskLevel, 'RL2'); assert.equal(resumed.selectedChange, unsignedPayload.selectedChange);
    assert.equal(resumed.reason, 'Pinned draft still saves under its original categories');
    check('Resuming an older guided draft renders and saves with version1 options/RL despite changed latest wording and risk');

    for (const record of [signed, legacy]) {
      await page.goto(`${origin}/${record.id}`);
      const texts = page.locator('.option-change-textarea');
      await expect(texts.first()).toBeVisible();
      assert.ok((await texts.evaluateAll(items => items.map(item => item.value))).includes(record.selectedChange));
      await expect(page.locator('#riskLevel')).toHaveValue(record.riskLevel);
      const preparedBefore = (await repository.findById(record.id)).documentControl.signatureBindings['signoff.gscTet.prepared'];
      const next = page.locator('[data-internal-field="signoff.gscTet.checked"]');
      await expect(next).toBeEnabled(); await next.check();
      const save = page.waitForResponse(item => new URL(item.url()).pathname === `/api/pcns/${record.id}` && item.request().method() === 'PATCH');
      await page.locator('#submitButton').click(); const response = await save;
      if (response.status() !== 200) {
        const sent = response.request().postDataJSON(), stored = await repository.findById(record.id);
        report.failedSaveFields = Object.entries(sent).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(stored[key])).map(([key]) => key);
      }
      assert.equal(response.status(), 200, await response.text());
      const saved = await repository.findById(record.id);
      assert.equal(saved.selectedChange, record.selectedChange); assert.equal(saved.riskLevel, record.riskLevel);
      assert.equal(saved.internalReview.signoff.gscTet.checked, true);
      assert.deepEqual(saved.documentControl.signatureBindings['signoff.gscTet.prepared'], preparedBefore);
    }
    check('Normal signed SC and legacy documents render original categories and accept the next ordered signature without migrating content or invalidating old evidence');

    await ui.open();
    await ui.field('rawMaterial', 0, 'text').fill('Unsaved competing wording');
    const concurrent = categorySettings(await repository.getMasterData());
    concurrent.forms.packaging[packagingAdded].text = 'Concurrent packaging publication';
    const externalSave = await context.request.put(`${origin}/api/admin/change-categories`, { headers,
      data: { ...concurrent, reason: 'Simulate concurrent administrator publication' } });
    assert.equal(externalSave.status(), 200);
    await ui.save('Attempt stale publication', 409);
    await expect(ui.field('rawMaterial', 0, 'text')).toHaveValue('Unsaved competing wording');
    await expect(page.locator('#settingsStatus')).toContainText('Your edits are preserved');
    page.once('dialog', dialog => dialog.dismiss()); await page.locator('#settingsReload').click();
    await expect(ui.field('rawMaterial', 0, 'text')).toHaveValue('Unsaved competing wording');
    page.once('dialog', dialog => dialog.accept()); await page.locator('#settingsReload').click();
    await expect(page.locator('#changeCategoriesVersion')).toContainText('3');
    await expect(ui.field('packaging', packagingAdded, 'text')).toHaveValue('Concurrent packaging publication');
    check('Concurrent publication rejects stale saves, retains dirty edits and requires an explicit discard before reloading version3');

    await page.setViewportSize({ width: 320, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Settings fits a 320px viewport');
    await page.screenshot({ path: artifact('settings-mobile.png'), fullPage: true });
    const activeVersion = (await repository.getMasterData()).versionId;
    const supplierSession = await login('supplier');
    await page.goto(`${origin}/system-settings`);
    await expect(page.locator('#settingsHome')).toBeHidden();
    await expect(page.locator('#changeCategoriesEditor')).toBeHidden();
    const denied = await context.request.put(`${origin}/api/admin/change-categories`, {
      headers: { origin, 'x-csrf-token': supplierSession.csrfToken }, data: { ...concurrent, versionId: activeVersion, reason: 'Unauthorized attempt' } });
    assert.equal(denied.status(), 403); assert.equal((await repository.getMasterData()).versionId, activeVersion);
    check('Content of Changes settings fit 320px and supplier sessions cannot view or publish the administrative master');
    assert.deepEqual(report.external, []); assert.deepEqual(report.errors, []); report.status = 'passed';
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
