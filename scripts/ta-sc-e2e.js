// Real application acceptance against disposable memory storage on loopback only.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, expect: baseExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const { bangkokDay, formatCode } = require('../pcn-types');
const masterData = require('../src/masterData');
const expect = baseExpect.configure({ timeout: 12000 });
const artifact = name => path.resolve('test-results', `ta-sc-${name}`);
const report = { storage: 'isolated_memory_only', checks: [], errors: [], external: [], writes: [] };
function checked(description) { report.checks.push(description); console.log(JSON.stringify({ taScCheck: description })); }
const typeChoice = (page, type) => page.getByRole('radio', { name: type.toUpperCase(), exact: true });
async function expectTypeLocked(page) {
  for (const type of ['ta', 'sc']) await expect(typeChoice(page, type)).toBeDisabled();
}

async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const service = new PcnService(repository);
  const actions = ['prepared', 'checked', 'approved'];
  const users = ['ta', 'sc'].flatMap(type => actions.map(signingStep => ({
    username: `${type}-${signingStep}`, displayName: `${type.toUpperCase()} ${signingStep}`,
    roles: ['productionengineering'], department: type === 'ta' ? 'prodEngTa' : 'prodEngSc', signingStep
  })));
  const authService = fakeAuthService({ additionalUsers: users });
  const documents = {
    async list() { return []; },
    async listForRecords(ids) { return new Map(await Promise.all(ids.map(async id => [id, {
      parentVersion: (await repository.findById(id))?.version, attachments: []
    }]))); }
  };
  const server = http.createServer();
  let browser, context, page;
  try {
    await fs.mkdir(path.dirname(artifact('report.json')), { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, service, authService, documents,
      rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
      return route.continue();
    });
    context.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === origin && !['GET', 'HEAD'].includes(request.method())) report.writes.push({ method: request.method(), path: url.pathname,
        ...(url.pathname === '/api/pcn-drafts' ? { documentType: request.postDataJSON()?.document?.documentType || null } : {}) });
    });
    const login = async username => {
      const response = await context.request.post(`${origin}/api/auth/login`, {
        headers: { origin }, data: { username, password: TEST_PASSWORD }
      });
      assert.equal(response.status(), 200, `Login ${username}`);
      return (await response.json()).data.csrfToken;
    };
    let csrf = await login('admin');
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.clock.install();
    page.on('pageerror', error => report.errors.push(error.message));

    // No clock override: derive the expected daily code from the server's actual creation instant.
    const createInBrowser = async (type, form, sequence, hold = false) => {
      await page.goto(`${origin}/create`);
      await page.locator('#startBlank').click();
      await expect(typeChoice(page, 'ta')).toBeVisible();
      await expect(typeChoice(page, 'sc')).toBeVisible();
      await expect(page.locator('#documentTypeGroup').getByRole('radio')).toHaveCount(2);
      await expect(page.locator('#documentTypeGroup')).not.toContainText(/Prod\.?\s*Eng/i);
      await expect(typeChoice(page, 'ta')).toHaveAttribute('aria-describedby', 'documentTypeHelp');
      await expect(typeChoice(page, 'sc')).toHaveAttribute('aria-describedby', 'documentTypeHelp');
      await expect(page.locator('#documentType')).toHaveValue('');
      await expect(typeChoice(page, 'ta')).not.toBeChecked();
      await expect(typeChoice(page, 'sc')).not.toBeChecked();
      await page.locator('#supplierName').fill(`Acceptance ${type.toUpperCase()} supplier`);
      await page.locator('#materialName').fill(`Acceptance ${type.toUpperCase()} material`);
      await page.locator('#changeForm').selectOption(form);
      const countBefore = (await repository.list()).length;
      const postsBefore = report.writes.filter(item => item.method === 'POST' && item.path === '/api/pcn-drafts').length;
      // Advance beyond both the real 1.5s debounce and 10s throttle without a wall-clock sleep.
      await page.clock.fastForward(10001);
      assert.equal(report.writes.filter(item => item.method === 'POST' && item.path === '/api/pcn-drafts').length, postsBefore, 'Untyped edits must never autosave');
      await page.locator('#saveDraftButton').click();
      await expect(page.locator('#createNotice')).toContainText(/type|TA|SC/i);
      assert.equal((await repository.list()).length, countBefore, 'Untyped save must not issue a code');
      assert.equal(report.writes.filter(item => item.method === 'POST' && item.path === '/api/pcn-drafts').length, postsBefore, 'Untyped save sends no POST');
      for (const selection of [type, type === 'ta' ? 'sc' : 'ta', type]) {
        await typeChoice(page, selection).check();
        await page.clock.fastForward(10001);
        await expect(typeChoice(page, selection)).toBeEnabled();
        await expect(typeChoice(page, selection)).toBeChecked();
        await expect(page.locator('#documentType')).toHaveValue(selection);
        await expect(page.locator('#draftIdentity')).toHaveText('New document');
        assert.equal(report.writes.filter(item => item.method === 'POST' && item.path === '/api/pcn-drafts').length, postsBefore, 'Changing a typed draft does not implicitly issue a code');
      }
      await page.locator('[data-stage="review"]').click();
      await expect(page.locator('#nextActionLabel')).toContainText('Save draft');
      await page.locator('#refreshReview').click();
      await expect(page.locator('#createNotice')).toContainText('Save draft first');
      await page.locator('#previewDocument').click();
      await expect(page.locator('#createNotice')).toContainText('Save draft first');
      await expect(page.locator('#documentPreviewDialog')).not.toBeVisible();
      await page.locator('[data-stage="documents"]').click();
      await page.locator('[data-requirement="supporting"] input[type=file]').setInputFiles({
        name: 'before-first-save.txt', mimeType: 'text/plain', buffer: Buffer.from('Disposable unsaved attachment attempt')
      });
      await expect(page.locator('#createNotice')).toContainText('Save draft first');
      await page.locator('[data-stage="details"]').click();
      await expect(typeChoice(page, type)).toBeEnabled();
      await expect(page.locator('#documentTypeHelp')).toContainText('until you click Save draft');
      assert.equal((await repository.list()).length, countBefore, 'Review, readiness, Preview and upload leave the draft unissued');
      assert.equal(report.writes.filter(item => item.method === 'POST' && item.path === '/api/pcn-drafts').length, postsBefore, 'Other creation actions cannot bypass first Save draft');
      if (hold) {
        await page.locator('#dismissNotice').click();
        await typeChoice(page, 'ta').check();
        await typeChoice(page, 'ta').focus();
        await typeChoice(page, 'ta').press('ArrowRight');
        await expect(typeChoice(page, 'sc')).toBeChecked();
        await expect(typeChoice(page, 'sc')).toBeFocused();
        await typeChoice(page, 'sc').press('ArrowLeft');
        await expect(typeChoice(page, 'ta')).toBeChecked();
        await typeChoice(page, 'ta').press('Tab');
        await expect(page.locator('#supplierName')).toBeFocused();
        await page.locator('#supplierName').press('Shift+Tab');
        await expect(typeChoice(page, 'ta')).toBeFocused();
        const selectedCard = typeChoice(page, 'ta').locator('..').locator('.create-type-card');
        await expect(selectedCard).toHaveCSS('outline-style', 'solid');
        await expect(selectedCard).toHaveCSS('outline-width', '3px');
        await expect(selectedCard).toHaveCSS('outline-color', 'rgb(6, 63, 123)');
        await expect(selectedCard.locator('.create-type-indicator')).toHaveCSS('background-color', 'rgb(6, 63, 123)');
        const desktopCards = await Promise.all(['ta', 'sc'].map(value => typeChoice(page, value).locator('..').boundingBox()));
        assert(desktopCards.every(bounds => bounds && bounds.height >= 80 && bounds.width >= 160), 'Desktop type choices are large clickable cards');
        assert(Math.abs(desktopCards[0].y - desktopCards[1].y) < 2, 'Desktop type cards align side by side');
        await expect(typeChoice(page, 'ta').locator('..').getByText('Selected', { exact: true })).toBeVisible();
        await expect(typeChoice(page, 'sc').locator('..').getByText('Selected', { exact: true })).not.toBeVisible();
        await page.screenshot({ path: artifact('type-before-first-save-desktop.png'), fullPage: true });
        await page.locator('#documentTypeGroup').screenshot({ path: artifact('type-cards-desktop.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Editable type selection fits mobile');
        const mobileCards = await Promise.all(['ta', 'sc'].map(value => typeChoice(page, value).locator('..').boundingBox()));
        assert(mobileCards.every(bounds => bounds && bounds.height >= 80 && bounds.width >= 90), 'Mobile type cards retain comfortable touch targets');
        await typeChoice(page, 'ta').evaluate(control => control.closest('label').scrollIntoView({ block: 'center' }));
        await page.screenshot({ path: artifact('type-before-first-save-mobile.png') });
        await page.locator('#documentTypeGroup').screenshot({ path: artifact('type-cards-mobile.png') });
        await page.setViewportSize({ width: 320, height: 844 });
        await typeChoice(page, 'ta').evaluate(control => control.closest('label').scrollIntoView({ block: 'center' }));
        const compactBounds = await page.locator('#documentTypeGroup').evaluate(group =>
          [...group.querySelectorAll('.create-type-card')].map(card => ({
            card: card.getBoundingClientRect().toJSON(),
            label: card.querySelector('.create-type-label').getBoundingClientRect().toJSON(),
            indicator: card.querySelector('.create-type-indicator').getBoundingClientRect().toJSON()
          })));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Type cards do not overflow a 320px page');
        for (const { card, label, indicator } of compactBounds) {
          assert(card.left >= 0 && card.right <= 320, 'Both compact cards remain within the viewport');
          assert(label.left >= card.left && label.right < indicator.left && indicator.right <= card.right,
            'Compact TA/SC labels and selected indicators remain inside their cards without overlap');
        }
        await page.locator('#documentTypeGroup').screenshot({ path: artifact('type-cards-mobile-320.png') });
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const interceptor = async route => { if (route.request().method() === 'POST') { await gate; } await route.continue(); };
      if (hold) await page.route('**/api/pcn-drafts', interceptor);
      const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pcn-drafts' && response.request().method() === 'POST');
      await typeChoice(page, type).check();
      await page.locator('#saveDraftButton').click();
      if (hold) {
        await expectTypeLocked(page);
        await expect(page.locator('#newDocument')).toBeDisabled();
        release();
      }
      const response = await created;
      assert.equal(response.status(), 201, await response.text());
      const record = (await response.json()).data.record;
      if (hold) await page.unroute('**/api/pcn-drafts', interceptor);
      await expect(page.locator('#draftIdentity')).toHaveText(record.id);
      await expect(page.locator('#draftSaveStatus')).toContainText('Saved at');
      await expectTypeLocked(page);
      await expect(typeChoice(page, type)).toBeChecked();
      assert.equal(record.id, formatCode(type, bangkokDay(record.createdAt), sequence));
      assert.equal(record.documentType, type);
      assert.equal(record.changeForm, form);
      const changed = await context.request.patch(`${origin}/api/pcn-drafts/${record.id}`, {
        headers: { origin, 'x-csrf-token': csrf }, data: { version: record.version,
          document: { ...unsignedPayload, documentType: type === 'ta' ? 'sc' : 'ta' } }
      });
      assert.equal(changed.status(), 400, 'Issued type is immutable through API');
      await page.reload();
      await expect(page.locator('#documentType')).toHaveValue(type);
      await expectTypeLocked(page);
      await expect(typeChoice(page, type)).toBeChecked();
      const autoSaved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/pcn-drafts/${record.id}` && response.request().method() === 'PATCH');
      await page.locator('#manufacturerName').fill(`Resumed ${type.toUpperCase()} manufacturer`);
      await page.clock.fastForward(10001);
      const autoResponse = await autoSaved;
      assert.equal(autoResponse.status(), 200, await autoResponse.text());
      const resumed = (await autoResponse.json()).data.record;
      assert.equal(resumed.id, record.id, 'Resumed edits keep the issued code');
      assert.equal(resumed.documentType, type, 'Resumed edits keep the issued type');
      assert.equal(resumed.manufacturerName, `Resumed ${type.toUpperCase()} manufacturer`);
      await expect(page.locator('#draftSaveStatus')).toContainText('Saved at');
      return resumed;
    };
    const firstTa = await createInBrowser('ta', 'rawMaterial', 1, true);
    const firstSc = await createInBrowser('sc', 'packaging', 1);
    const secondTa = await createInBrowser('ta', 'packaging', 2);
    checked('Browser creation requires TA/SC; separate Bangkok daily T/S counters issue 01, 01, 02 independently of Form-1/Form-2');
    checked('TA/SC stays editable through typing, Review, Preview and upload until explicit first Save draft; pending save and issued type stay locked');
    checked('Large TA/SC-only cards support pointer, arrow keys and tab focus, expose native selection, fit desktop/mobile and retain issued selection');
    checked('Resumed drafts continue autosaving later edits without issuing a new code or changing their type');
    const mobileValidation = await context.newPage();
    await mobileValidation.setViewportSize({ width: 390, height: 844 });
    await mobileValidation.goto(`${origin}/create`);
    await mobileValidation.locator('#startBlank').click();
    await mobileValidation.locator('#nextStage').click();
    await expect(typeChoice(mobileValidation, 'ta')).toBeFocused();
    await expect(typeChoice(mobileValidation, 'ta')).toHaveAttribute('aria-invalid', 'true');
    await expect(typeChoice(mobileValidation, 'ta')).toHaveAttribute('aria-describedby', /documentTypeHelp.*documentTypeError/);
    const visibleCard = await typeChoice(mobileValidation, 'ta').locator('..').boundingBox();
    const actionBar = await mobileValidation.locator('.create-actionbar').boundingBox();
    assert(visibleCard && actionBar && visibleCard.y >= 0 && visibleCard.y + visibleCard.height <= actionBar.y,
      'Missing-type validation scrolls the whole focused card above the mobile action bar');
    await mobileValidation.close();
    checked('Required-type errors focus the visible mobile TA card and retain both helper and error descriptions');
    const { documentType: noType, ...untyped } = unsignedPayload;
    const missingType = await context.request.post(`${origin}/api/pcns`, {
      headers: { origin, 'x-csrf-token': csrf }, data: { ...untyped, status: 'draft' }
    });
    assert.equal(missingType.status(), 400, 'Server also rejects creation without a type');
    await page.screenshot({ path: artifact('creation-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Create layout has no mobile horizontal overflow');
    await page.screenshot({ path: artifact('creation-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Seed only completed historical prerequisites. All PE signatures below use real UI/API authorization.
    const admin = { id: 'admin-id', roles: ['admin'], displayName: 'Acceptance Administrator' };
    for (const type of ['ta', 'sc']) {
      let record = await service.create({ ...unsignedPayload, documentType: type, status: 'draft', internalReview: {} }, 'fixture', admin);
      record = await repository.seedHistoricalReview(record.id, { signoff: { gscTet: {
        prepared: true, preparedName: 'Historical GSC', preparedDate: '2026-01-01',
        checked: true, checkedName: 'Historical GSC', checkedDate: '2026-01-01',
        approved: true, approvedName: 'Historical GSC', approvedDate: '2026-01-01'
      } } });
      record = await repository.update(record.id, current => ({ ...current, status: 'submitted' }), 'fixture', record.version);
      for (const action of actions) {
        csrf = await login(`${type === 'ta' ? 'sc' : 'ta'}-${action}`);
        await page.goto(`${origin}/${record.id}`);
        await expect(page.locator('#productionEngineeringLabel')).toHaveText(`Prod.Eng/${type.toUpperCase()}`);
        const control = page.locator(`[data-internal-field="signoff.prodEngTet.${action}"]`);
        await expect(control).toBeDisabled();
        const denied = await context.request.patch(`${origin}/api/pcns/${record.id}`, {
          headers: { origin, 'x-csrf-token': csrf }, data: { version: record.version,
            internalReview: { signoff: { prodEngTet: { [action]: true } } } }
        });
        assert.equal(denied.status(), 403, `${type} ${action}: other PE team rejected`);
        csrf = await login(`${type}-${action}`);
        await page.reload();
        await expect(control).toBeEnabled();
        await control.check();
        const saved = page.waitForResponse(response => response.url().endsWith(`/api/pcns/${record.id}`) && response.request().method() === 'PATCH');
        await page.locator('#submitButton').click();
        const response = await saved;
        assert.equal(response.status(), 200, await response.text());
        record = (await response.json()).data;
        assert.equal(record.internalReview.signoff.prodEngTet[action], true);
        assert.equal(record.internalReview.signoff.prodEngTet[`${action}Name`], `${type.toUpperCase()} ${action}`);
        await expect(page.locator('#pcnSaveOverlay')).toBeHidden();
      }
      await page.reload();
      await expect(page.locator('[data-internal-field="signoff.prodEngTet.approved"]')).toBeChecked();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: artifact(`${type}-engineering-desktop.png`), fullPage: true });
    }
    checked('TA and SC each complete Prepared, Checked, Approved with their assigned PE users; opposite team is disabled in UI and denied by API');

    csrf = await login('admin');
    const { documentType: omitted, ...legacyPayload } = unsignedPayload;
    const legacy = await repository.create({ ...legacyPayload, status: 'draft', internalReview: {},
      ownerUserId: 'admin-id', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 'historical-fixture');
    await page.goto(`${origin}/${legacy.id}`);
    await expect(page.locator('#supplierName')).toHaveValue(legacy.supplierName);
    await expect(page.locator('#documentType')).toHaveValue('');
    await expect(page.locator('#productionEngineeringLabel')).toHaveText('Prod.Eng/TET');
    checked('Legacy PCN URL remains readable without automatic classification or a renamed PE team');
    // Terminal fixtures exercise the real dashboard lifecycle/filter composition without forging closure through HTTP.
    for (const source of [firstTa, firstSc, legacy]) {
      const current = await repository.findById(source.id);
      await repository.update(source.id, value => ({ ...value, status: 'closed' }), 'terminal-dashboard-fixture', current.version);
    }
    await page.goto(`${origin}/admin`);
    const rows = page.locator('#adminPcnRows');
    const filter = page.getByRole('combobox', { name: 'PCN type', exact: true });
    await expect(filter).toBeVisible();
    assert.deepEqual(await filter.locator('option').evaluateAll(options => options.map(option => option.value)), ['', 'ta', 'sc', 'legacy']);
    await filter.selectOption('ta');
    await expect(rows).toContainText(secondTa.id);
    await expect(rows).not.toContainText(firstSc.id);
    await page.locator('#adminSearchInput').fill('does-not-exist');
    await expect(rows).toContainText('No open documents match');
    await page.locator('#adminSearchInput').fill('');
    await page.locator('#rdLifecycleTab-closed').click();
    await expect(rows).toContainText(firstTa.id);
    await expect(rows).not.toContainText(firstSc.id);
    await filter.selectOption('sc');
    await expect(rows).toContainText(firstSc.id);
    await expect(rows).not.toContainText(firstTa.id);
    await page.locator('#rdViewEditor summary').click();
    await page.locator('#rdViewName').fill('SC completed acceptance');
    await page.getByRole('button', { name: 'Save current view', exact: true }).click();
    await filter.selectOption('legacy');
    await expect(rows).toContainText(legacy.id);
    await expect(rows).not.toContainText(firstSc.id);
    await page.getByRole('combobox', { name: 'Saved views', exact: true }).selectOption('SC completed acceptance');
    await expect(filter).toHaveValue('sc');
    await expect(page.locator('#rdLifecycleTab-closed')).toHaveAttribute('aria-selected', 'true');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export filtered CSV', exact: true }).click();
    const download = await downloadEvent;
    await download.saveAs(artifact('filtered-records.csv'));
    const csv = await fs.readFile(artifact('filtered-records.csv'), 'utf8');
    assert(csv.includes(firstSc.id) && csv.includes('SC'));
    assert(!csv.includes(firstTa.id) && !csv.includes(legacy.id));
    checked('Records type filter composes with Open/Closed and search; saved view restores SC/Closed and CSV contains only the matching document');
    await page.screenshot({ path: artifact('records-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(filter).toBeVisible();
    await page.screenshot({ path: artifact('records-mobile.png'), fullPage: true });
    assert.deepEqual(report.errors, [], 'No browser runtime errors');
    assert.deepEqual(report.external, [], 'No external browser requests');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.stack;
    if (page) await page.screenshot({ path: artifact('failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context?.tracing.stop({ path: artifact('trace.zip') }).catch(() => {});
    await fs.writeFile(artifact('report.json'), JSON.stringify(report, null, 2));
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
