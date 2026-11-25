// Disposable loopback fixtures only: no SQL, real accounts, mail or deployment.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium, expect: browserExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { applyDocumentControl } = require('../src/documentControl');
const { actions } = require('../src/signingPermissions');
const { memoryRepository, fakeAuthService, unsignedPayload, TEST_PASSWORD } = require('../test/helpers/apiHarness');
const expect = browserExpect.configure({ timeout: 10000 });
const artifact = name => path.resolve('test-results', `developer-corrections-${name}`);
const developer = { id: 'correction-developer', username: 'correction-developer', displayName: 'Correction Developer',
  roles: ['developer'], department: 'developer', signingStep: null, isActive: true };
const actor = `user:${developer.id}`;
const at = (object, field) => field.split('.').reduce((value, part) => value?.[part], object);
async function usableFocus(page) {
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active.matches(':disabled')) return false;
    const box = active.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (!box.width || !box.height || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (active === hit || active.contains(hit) || hit.contains(active)));
  }), { message: 'Focus stays on an enabled, visible control or heading inside the viewport' }).toBe(true);
}

function signedReview() {
  const done = Object.fromEntries(actions.flatMap(action => [[action, true], [`${action}Name`, 'Fixture signer'], [`${action}Date`, '2026-11-24']]));
  return { signoff: { gscTet: { ...done }, prodEngTet: { ...done }, qaTet: { ...done } },
    tapbu: { need: true, noNeed: false, gsc: { ...done }, qa: { ...done } },
    qateFinal: { approve: true, reject: false, signoff: { ...done } },
    supplierSignoff: Object.fromEntries(actions.map(action => [action, { checked: true, name: 'Fixture header signer', date: '2026-11-24' }])) };
}

async function fixtures() {
  const repository = memoryRepository();
  const service = new PcnService(repository), now = '2026-11-24T08:00:00.000Z';
  const master = await repository.getMasterData();
  const fullRows = master.formDefinitions.rawMaterial.riskOptions.map(option => ({ optionText: option.text, text: option.text, risk: option.risk,
    currentCondition: option.text === unsignedPayload.selectedChange ? unsignedPayload.currentCondition : '',
    newCondition: option.text === unsignedPayload.selectedChange ? unsignedPayload.newCondition : '' }));
  const ta = await service.create({ ...unsignedPayload, changeRows: fullRows, documentType: 'ta', supplierName: 'TA correction fixture', status: 'submitted' }, actor, developer);
  let sc = await service.create({ ...unsignedPayload, documentType: 'sc', supplierName: 'SC closed correction fixture', status: 'submitted' }, actor, developer);
  sc = await repository.update(sc.id, current => applyDocumentControl(current, { ...current, status: 'closed', internalReview: { ...signedReview(), pcnCode: current.id } }, developer, now), actor, sc.version);
  const { documentType: omitted, ...legacyInput } = unsignedPayload;
  const legacyData = service.normalizeInput({ ...legacyInput, supplierName: 'Legacy correction fixture', status: 'submitted' });
  const legacy = await repository.create(applyDocumentControl(null, { ...legacyData, createdAt: now, updatedAt: now, submittedAt: now,
    ownerUserId: developer.id, internalReview: signedReview(), documents: [], route: [] }, developer, now), actor, developer);
  return { repository, service, ta, sc, legacy };
}

class CorrectionPage {
  constructor(page, origin) { this.page = page; this.origin = origin; }
  async open() {
    await this.page.goto(`${this.origin}/developer`);
    await expect(this.page.locator('#developerMain')).toBeVisible();
    await this.page.locator('#correctionsTab').click();
    await expect(this.page.locator('#correctionChoices input[type=checkbox]').first()).toBeEnabled();
    await expect(this.page.locator('#correctionSelectionStage')).toBeVisible();
    await expect(this.page.locator('#correctionEditStage')).toBeHidden();
    await expect(this.page.locator('#loadCorrections')).toBeDisabled();
  }
  async select(ids) {
    const choices = this.page.locator('#correctionChoices input[type=checkbox]');
    for (const choice of await choices.all()) await choice.setChecked(ids.includes(await choice.getAttribute('value')));
    await this.page.locator('#loadCorrections').focus(); await this.page.locator('#loadCorrections').press('Enter');
    await expect(this.page.locator('#correctionEditStage')).toBeVisible();
    await expect(this.page.locator('#correctionSelectionStage')).toBeHidden();
    await expect(this.page.locator('#correctionEditHeading')).toBeFocused();
    for (const id of ids) await expect(this.editor(id)).toBeVisible();
  }
  editor(id) { return this.page.locator(`#correctionEditors details[data-pcn-id="${id}"]`); }
  async expand(id) {
    const editor = this.editor(id);
    if (!(await editor.evaluate(element => element.open))) await editor.locator('summary').first().click();
    return editor;
  }
  async field(id, field, value) {
    const editor = await this.expand(id);
    const control = editor.locator(`[data-correction-field="${field}"]`).first();
    const group = control.locator('xpath=ancestor::details[@data-correction-group][1]');
    if (await group.count() && !(await group.evaluate(element => element.open))) await group.locator('summary').first().click();
    await control.fill(value);
  }
  async changeText(id, value) {
    const editor = await this.expand(id);
    await editor.locator('[data-correction-group="content"] [data-correction-field="text"]').first().fill(value);
  }
  async preview(reason) {
    await this.page.locator('#correctionReason').fill(reason);
    await this.page.locator('#previewCorrections').click();
    await expect(this.page.locator('#correctionPreviewDialog')).toBeVisible();
  }
  async apply() {
    const response = this.page.waitForResponse(item => new URL(item.url()).pathname === '/api/developer/pcns/corrections' && item.request().method() === 'POST');
    await this.page.locator('#applyCorrections').click();
    const saved = await response; assert.equal(saved.status(), 200, await saved.text());
    await expect(this.page.locator('#correctionPreviewDialog')).toBeHidden();
    await usableFocus(this.page);
    return (await saved.json()).data;
  }
}

async function main() {
  const report = { storage: 'isolated_memory_only', checks: [], writes: [], external: [], errors: [] };
  const check = message => { report.checks.push(message); console.log(message); };
  const fixture = await fixtures(), { repository, service, ta, sc, legacy } = fixture;
  let handler;
  const server = http.createServer((request, response) => handler(request, response));
  let browser, context, page;
  try {
    await fs.mkdir('test-results', { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    handler = createRequestHandler({ repository, service, authService: fakeAuthService({ additionalUsers: [developer] }),
      documents: { list: async () => [] }, publicOrigin: origin, secureCookies: false });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
      if (!['GET', 'HEAD'].includes(request.method()) && !url.pathname.endsWith('/login')) report.writes.push({ path: url.pathname, method: request.method() });
      return route.continue();
    });
    async function login(username) {
      const response = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: TEST_PASSWORD } });
      assert.equal(response.status(), 200, await response.text()); return (await response.json()).data;
    }
    const session = await login(developer.username);
    const mutate = (route, data, csrf = session.csrfToken) => context.request.post(`${origin}${route}`, {
      headers: { origin, 'x-csrf-token': csrf }, data });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => report.errors.push(error.message));
    const ui = new CorrectionPage(page, origin);
    await ui.open();
    await page.screenshot({ path: artifact('selection-desktop.png') });
    await page.locator('#correctionsTab').focus(); await page.locator('#correctionsTab').press('Home');
    await expect(page.locator('#workflowTab')).toBeFocused(); await page.locator('#workflowTab').press('End');
    await expect(page.locator('#adminToolsTab')).toBeFocused(); await page.locator('#adminToolsTab').press('ArrowLeft');
    await expect(page.locator('#correctionsTab')).toBeFocused();
    await ui.select([ta.id, sc.id, legacy.id]);
    const original = new Map(await Promise.all([ta, sc, legacy].map(async item => [item.id, await repository.findById(item.id)])));
    await expect(ui.editor(ta.id)).toHaveAttribute('open', '');
    await expect(ui.editor(sc.id)).not.toHaveAttribute('open', '');
    const taEditor = ui.editor(ta.id), selectedIndex = ta.changeRows.findIndex(row => row.text === ta.selectedChange);
    await expect(taEditor.locator('[data-correction-group="content"]')).toHaveAttribute('open', '');
    await expect(taEditor.locator('[data-correction-group="content"] [data-correction-field="text"]').first()).toHaveAttribute('data-correction-row', String(selectedIndex));
    await expect(taEditor.locator('[data-correction-group="otherChanges"]')).not.toHaveAttribute('open', '');
    await expect(taEditor.locator('[data-correction-group="otherChanges"] > summary')).toContainText(String(ta.changeRows.length - 1));
    for (const group of ['supplier', 'additional', 'signatures']) await expect(taEditor.locator(`[data-correction-group="${group}"]`)).not.toHaveAttribute('open', '');
    await expect(page.locator('#previewCorrections')).toBeDisabled();
    await page.screenshot({ path: artifact('edit-desktop.png') });
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator('#changeCorrectionSelection').click();
    await expect(page.locator('#correctionSelectionHeading')).toBeFocused(); await usableFocus(page);
    await page.locator('#resumeCorrectionEditing').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#correctionEditHeading')).toBeFocused(); await usableFocus(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Progressive editor fits 320px');
    await page.screenshot({ path: artifact('mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await ui.changeText(ta.id, 'Staged TA wording stays while changing selection');
    await page.locator('#changeCorrectionSelection').click();
    await expect(page.locator('#correctionSelectionHeading')).toBeFocused();
    await expect(page.locator('#correctionEditStage')).toBeHidden();
    await expect(page.locator(`#correctionChoices input[value="${ta.id}"]`)).toBeDisabled();
    await page.locator('#resumeCorrectionEditing').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#correctionEditHeading')).toBeFocused();
    await expect(taEditor.locator('[data-correction-group="content"] [data-correction-field="text"]').first()).toHaveValue('Staged TA wording stays while changing selection');
    check('Selection advances by keyboard to focused editing; selected change appears first with stable row identity, other items/secondary fields stay collapsed, and changing selection preserves staged edits');
    const shared = page.locator('details').filter({ has: page.locator('#sharedCorrectionField') });
    await expect(shared).not.toHaveAttribute('open', '');
    await shared.locator('summary').first().click();
    await page.locator('#sharedCorrectionField').selectOption('reason');
    await page.locator('#sharedCorrectionValue').fill('Shared supplier reason applied to all three selected fixtures');
    await page.locator('#setSharedCorrection').click();
    for (const item of [ta, sc, legacy]) {
      await ui.changeText(item.id, `Corrected change description for ${item.id}`);
    }
    await expect(page.locator('#correctionChangeCount')).toContainText('3 documents changed');
    await expect(page.locator('#previewCorrections')).toBeDisabled();
    await page.screenshot({ path: artifact('editing-desktop.png'), fullPage: true });
    await ui.preview('Correct supplier wording in the disposable acceptance fixtures');
    await expect(page.locator('#correctionPreviewDialog')).toContainText('Corrected change description');
    await expect(page.locator('#correctionPreviewDialog')).toContainText(ta.id);
    await page.screenshot({ path: artifact('preview-desktop.png') });
    await page.setViewportSize({ width: 320, height: 844 });
    const applied = await ui.apply();
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(applied.results.filter(item => item.success).length, 3);
    await expect(page.locator('#correctionResults')).toContainText(ta.id);
    for (const item of [ta, sc, legacy]) {
      const before = original.get(item.id), after = await repository.findById(item.id);
      const selected = before.changeRows.findIndex(row => row.text === before.selectedChange);
      assert.equal(after.changeRows[selected].text, `Corrected change description for ${item.id}`);
      assert.equal(after.selectedChange, after.changeRows[selected].text);
      for (let index = 0; index < before.changeRows.length; index++) if (index !== selected) assert.deepEqual(after.changeRows[index], before.changeRows[index]);
      assert.equal(after.reason, 'Shared supplier reason applied to all three selected fixtures');
      assert.equal(after.status, before.status); assert.equal(after.documentControl.contentRevision, before.documentControl.contentRevision);
      assert.deepEqual(after.internalReview, before.internalReview); assert.deepEqual(after.documentControl.signatureBindings, before.documentControl.signatureBindings);
      const history = await repository.getRevisions(item.id);
      assert.ok(history[0].changes.some(change => change.path.startsWith('changeRows')));
      assert.equal((await repository.getRevision(item.id, history[0].revision)).snapshot.documentControl.lastDeveloperCorrection.reason,
        'Correct supplier wording in the disposable acceptance fixtures');
    }
    check('Developer bulk correction updates legacy, TA and closed SC wording, preserves signatures/status/document revision and records before/after audit reason');
    await page.goto(`${origin}/${sc.id}`);
    await expect(page.locator('#developerCorrectionNotice')).toBeVisible();
    await expect(page.locator('#developerCorrectionNotice')).toContainText(/corrected|correction/i);
    check('Normal document displays the retained-signature correction notice');

    await page.locator('#developerCorrectDocument').click();
    await expect(page).toHaveURL(`${origin}/developer?pcn=${sc.id}#corrections`);
    await expect(ui.editor(sc.id)).toBeVisible();
    const closedEditor = await ui.expand(sc.id), chosenPath = 'signoff.prodEngTet.checked';
    const signatureManagement = closedEditor.locator('[data-correction-group="signatures"]');
    await expect(signatureManagement).not.toHaveAttribute('open', '');
    await signatureManagement.locator('summary').focus(); await page.keyboard.press('Enter');
    await closedEditor.locator('[data-unsign-select]').selectOption(chosenPath);
    await closedEditor.locator('[data-unsign-preview]').click();
    await expect(page.locator('#unsignDialog')).toBeVisible();
    await expect(page.locator('#unsignImpact')).toContainText(/reopen/i);
    await page.locator('#unsignReason').fill('Remove incorrect fixture signoff for reapproval');
    await page.setViewportSize({ width: 320, height: 844 });
    await page.screenshot({ path: artifact('unsign-mobile.png') });
    const unsignResponse = page.waitForResponse(item => new URL(item.url()).pathname === `/api/developer/pcns/${sc.id}/unsign` && item.request().method() === 'POST');
    await page.locator('#confirmUnsign').click();
    const unsign = await unsignResponse; assert.equal(unsign.status(), 200, await unsign.text());
    const unsignData = (await unsign.json()).data;
    assert.equal(unsignData.reopened, true); assert.equal(unsignData.status, 'submitted');
    await expect(page.locator('#unsignDialog')).toBeHidden();
    await usableFocus(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const reopened = await repository.findById(sc.id);
    assert.equal(reopened.internalReview.signoff.gscTet.approved, true);
    assert.equal(reopened.internalReview.signoff.prodEngTet.prepared, true);
    assert.equal(reopened.internalReview.signoff.prodEngTet.checked, false);
    assert.equal(reopened.internalReview.signoff.prodEngTet.approved, false);
    for (const stage of ['signoff.qaTet', 'tapbu.gsc', 'tapbu.qa', 'qateFinal.signoff']) {
      for (const action of actions) assert.equal(at(reopened.internalReview, `${stage}.${action}`), false);
    }
    for (const action of actions) assert.equal(reopened.internalReview.supplierSignoff[action].checked, false);
    assert.equal(reopened.documentControl.signatureBindings[chosenPath], undefined);
    assert.deepEqual(reopened.documentControl.signatureBindings['signoff.gscTet.approved'], original.get(sc.id).documentControl.signatureBindings['signoff.gscTet.approved']);
    const resign = await context.request.patch(`${origin}/api/pcns/${sc.id}`, { headers: { origin, 'x-csrf-token': session.csrfToken },
      data: { version: reopened.version, internalReview: { signoff: { prodEngTet: { checked: true } } } } });
    assert.equal(resign.status(), 200, await resign.text());
    assert.equal((await resign.json()).data.internalReview.signoff.prodEngTet.checked, true);
    check('Document shortcut opens corrections; signature removal previews reopening, clears downstream/header steps, preserves prior evidence and permits ordered re-signing');

    await ui.open(); await ui.select([ta.id, legacy.id]);
    await ui.field(ta.id, 'reason', 'TA update with a deliberately stale fixture');
    await ui.field(legacy.id, 'reason', 'Legacy update still succeeds');
    let stale = await repository.findById(ta.id);
    await repository.update(ta.id, current => ({ ...current, updatedAt: new Date().toISOString() }), 'Concurrent fixture update', stale.version);
    await ui.preview('Check partial success and stale versions');
    const partial = await ui.apply();
    assert.equal(partial.results.find(item => item.id === ta.id).success, false);
    assert.equal(partial.results.find(item => item.id === ta.id).status, 409);
    assert.equal(partial.results.find(item => item.id === legacy.id).success, true);
    assert.equal(report.writes.filter(item => item.path === '/api/developer/pcns/corrections').length, 2, 'Only explicit apply actions submit corrections');
    await expect(page.locator('#correctionResults')).toContainText(ta.id);
    await expect(page.locator('#correctionResults')).toContainText(/reload|conflict|changed/i);
    await expect(page.locator('#correctionChangeCount')).toContainText('1 document changed');
    await expect(ui.editor(ta.id).locator('[data-correction-field="reason"]').first()).toHaveValue('TA update with a deliberately stale fixture');
    assert.notEqual((await repository.findById(ta.id)).reason, 'TA update with a deliberately stale fixture');
    assert.equal((await repository.findById(legacy.id)).reason, 'Legacy update still succeeds');
    check('A stale document fails honestly while another bulk correction succeeds; no automatic stale retry occurs');

    stale = await repository.findById(ta.id);
    const ordinary = await context.request.patch(`${origin}/api/pcns/${ta.id}`, { headers: { origin, 'x-csrf-token': session.csrfToken },
      data: { version: stale.version, reason: 'Forbidden ordinary edit' } });
    assert.equal(ordinary.status(), 403);
    const csrf = await mutate('/api/developer/pcns/corrections', { reason: 'CSRF fixture', items: [{ id: ta.id, version: stale.version, changes: { reason: 'Rejected request' } }] }, 'invalid-token');
    assert.equal(csrf.status(), 403);
    check('Normal submitted-content PATCH and missing/invalid CSRF still reject Developer writes');

    await page.setViewportSize({ width: 320, height: 844 });
    await expect(page.locator('#correctionsPanel')).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Correction page stays within a 320px viewport');
    await page.screenshot({ path: artifact('mobile-results.png'), fullPage: true });
    await page.locator('#previewCorrections').click();
    await expect(page.locator('#correctionPreviewDialog')).toBeVisible();
    const dialogBox = await page.locator('#correctionPreviewDialog').boundingBox();
    assert.ok(dialogBox.x >= 0 && dialogBox.width <= 320, 'Correction preview fits the mobile viewport');
    await expect(page.locator('#cancelCorrectionPreview')).toBeFocused();
    await page.screenshot({ path: artifact('preview-mobile.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('#correctionPreviewDialog')).toBeHidden();
    await expect(page.locator('#previewCorrections')).toBeFocused();
    await usableFocus(page);
    const adminSession = await login('admin'); await page.goto(`${origin}/developer`);
    await expect(page.locator('#developerMain')).toBeHidden();
    const denied = await mutate('/api/developer/pcns/corrections', { reason: 'Administrator denied', items: [{ id: ta.id, version: stale.version, changes: { reason: 'Rejected' } }] }, adminSession.csrfToken);
    assert.equal(denied.status(), 403);
    check('Mobile corrections stay contained and Administrator cannot use Developer-only corrections');
    assert.deepEqual(report.external, []); assert.deepEqual(report.errors, []);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
    if (page) report.focusDiagnostic = await page.evaluate(() => {
      const active = document.activeElement, box = active?.getBoundingClientRect(), header = document.querySelector('.developer-topbar')?.getBoundingClientRect();
      const hit = box ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
      return { active: active?.id || active?.tagName, activeClass: active?.className, box: box?.toJSON(), header: header?.toJSON(), hit: hit?.id || hit?.className || hit?.tagName, viewport: { width: innerWidth, height: innerHeight } };
    }).catch(() => null);
    if (page) await page.screenshot({ path: artifact('failure.png'), fullPage: true }).catch(() => {});
  } finally {
    if (context) await context.close(); if (browser) await browser.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await fs.writeFile(artifact('acceptance.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
