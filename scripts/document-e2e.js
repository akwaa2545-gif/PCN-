// Isolated browser journeys: never uses SQL, mail providers, or production records.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { ApiError } = require('../src/apiError');
const { applyDocumentControl, hasSignatures } = require('../src/documentControl');
const { memoryRepository, fakeAuthService, TEST_PASSWORD } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');

function isolatedDocuments(repository) {
  let files = [];
  return {
    async list(code) { return structuredClone(files.filter(file => file.code === code).map(({ code: omitted, bytes: ignored, ...metadata }) => metadata)); },
    async save(code, input, context) {
      const before = await repository.findById(code);
      if (hasSignatures(before)) throw new ApiError(409, 'Start a new revision before changing signed document attachments');
      if (input.requirementName && before.internalReview?.docs?.[input.requirementName] !== true) throw new ApiError(400, 'Category not requested');
      const file = { id: crypto.randomUUID(), code, fileName: input.fileName, contentType: input.contentType,
        bytes: Buffer.from(input.base64, 'base64'), sizeBytes: Buffer.from(input.base64, 'base64').length,
        scanStatus: 'pendingScan', requirementName: input.requirementName || null,
        uploadedBy: context.user.displayName || context.user.username, uploadedAt: new Date().toISOString() };
      const saved = await repository.update(code, current => applyDocumentControl(current,
        { ...current, documentControl: { ...current.documentControl, attachmentGeneration: (current.documentControl?.attachmentGeneration || 0) + 1 } },
        context.user, file.uploadedAt), context.actor, context.version);
      file.contentRevision = saved.documentControl.contentRevision;
      files = [...files, file];
      return { id: file.id, version: saved.version };
    },
    async get(code, id) {
      const file = files.find(item => item.code === code && item.id === id);
      if (!file) throw new ApiError(404, 'Document not found');
      if (file.scanStatus !== 'clean') throw new ApiError(423, 'Document download requires a trusted malware scan');
      return { ContentType: file.contentType, FileName: file.fileName, Bytes: file.bytes };
    },
    clearForTest(id) { files = files.map(file => file.id === id ? { ...file, scanStatus: 'clean' } : file); }
  };
}

async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const documents = isolatedDocuments(repository);
  const update = repository.update.bind(repository);
  repository.update = (id, updater, actor, version) => update(id,
    current => updater(current, { listAttachments: () => documents.list(id) }), actor, version);
  const passwordAuth = fakeAuthService({ additionalUsers: [
    { username: '0000001', employeeCode: '0000001', displayName: 'Document Administrator', roles: ['admin'] },
    { username: '0000002', employeeCode: '0000002', displayName: 'Exact GSC Approver', roles: ['gsc'], department: 'gscTet', signingStep: 'approved' },
    { username: '0000003', displayName: 'Different GSC Checker', roles: ['gsc'], department: 'gscTet', signingStep: 'checked' }
  ] });
  const authService = { ...passwordAuth, authMode: 'employee-code', login: body => passwordAuth.login({ username: body.employeeCode, password: TEST_PASSWORD }) };
  const server = http.createServer();
  let browser, context;
  let releaseHeldRead = () => {};
  let tracingStarted = false;
  const checks = [], errors = [], external = [], notifications = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, authService, documents, rootDir: path.resolve(__dirname, '..'),
      publicOrigin: origin, secureCookies: false, notificationService: { async workflow(record, body) { notifications.push({ id: record.id, body }); return { accepted: 0 }; } } }));
    // Full Chromium's new headless mode includes the built-in PDF viewer.
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    context = await browser.newContext({ viewport: { width: 1500, height: 1050 } });
    await context.route('**/*', route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === origin ||
          (requestUrl.protocol === 'chrome-extension:' && requestUrl.hostname === 'mhjfbmdgcfjbbpaeojofohoefgiehjai') ||
          (requestUrl.protocol === 'chrome:' && requestUrl.hostname === 'resources')) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracingStarted = true;
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/login?returnTo=%2Fcreate`);
    await page.locator('#employeeCode').fill('0000001');
    await page.locator('#employeeLoginForm button[type=submit]').click();
    await page.waitForURL(`${origin}/create`);
    await expect(page.locator('#saveDraftButton')).toBeEnabled();
    const save = async (draft = false) => {
      const response = page.waitForResponse(res => /\/api\/pcns(?:\/PCN-\d{4}-\d{4})?$/.test(new URL(res.url()).pathname) && ['POST', 'PATCH'].includes(res.request().method()));
      await page.locator(draft ? '#saveDraftButton' : '#submitButton').click();
      const result = await response;
      assert.ok(result.ok(), `Save failed: ${result.status()} ${await result.text()}`);
      const record = (await result.json()).data;
      await expect(page.locator('#pcnSaveOverlay')).toBeHidden();
      return record;
    };
    let record = await save(true);
    assert.equal(record.status, 'draft');
    assert.equal(record.supplierName, '');
    assert.deepEqual(notifications, []);
    checks.push('incomplete-draft-save-without-notifications');
    await page.waitForURL(`${origin}/form.html?id=${record.id}`);
    await page.reload();
    await expect(page.locator('#submitButton')).toBeEnabled();
    const workspace = page.locator('#documentWorkspace');
    await workspace.getByRole('tab', { name: 'Checks', exact: true }).click();
    const missingSupplier = workspace.locator('.dw-checks li').filter({ has: page.getByText('Supplier name', { exact: true }) });
    await missingSupplier.getByRole('button', { name: 'Go to field' }).click();
    await expect(page.locator('#supplierName')).toBeFocused();
    checks.push('missing-check-links-to-real-document-field');
    await page.locator('#supplierName').fill('Browser Supplier');
    await page.locator('#materialName').fill('Material A');
    await page.locator('#reason').fill('First documented reason');
    await page.locator('#desiredStart').fill('Lot B-001');
    const option = page.locator('input[name=changeOption]').nth(4);
    await option.check();
    const selectedRow = page.locator('.option-row').filter({ has: page.locator('input[name=changeOption]:checked') });
    await selectedRow.getByLabel(/Current condition/).fill('Original specification');
    await selectedRow.getByLabel(/New condition/).fill('Revised specification');
    await page.locator('input[name=sampleSubmittedChoice][value=no]').check();
    await page.locator('[data-internal-field="docs.hazardousReport"]').check();
    record = await save(true);
    await workspace.getByRole('tab', { name: 'Attachments', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await workspace.getByRole('button', { name: 'Upload file', exact: true }).click();
    await (await chooser).setFiles({ name: 'browser-report.txt', mimeType: 'text/plain', buffer: Buffer.from('Trusted fixture report\nLine two.') });
    const uploadDialog = page.getByRole('dialog', { name: 'Upload supporting file' });
    await uploadDialog.getByRole('combobox').selectOption('hazardousReport');
    const uploaded = page.waitForResponse(res => res.url().endsWith('/documents') && res.request().method() === 'POST');
    await uploadDialog.getByRole('button', { name: 'Upload', exact: true }).click();
    const uploadResponse = await uploaded;
    assert.equal(uploadResponse.status(), 201);
    const fileId = (await uploadResponse.json()).data.id;
    await expect(workspace.getByText('Awaiting security scan')).toBeVisible();
    assert.equal(await workspace.getByRole('button', { name: 'Download', exact: true }).count(), 0);
    assert.equal((await page.request.get(`${origin}/api/pcns/${record.id}/documents/${fileId}`)).status(), 423);
    checks.push('requested-file-category-quarantine-blocks-download');
    documents.clearForTest(fileId);
    await page.reload();
    await expect(page.locator('#submitButton')).toBeEnabled();
    await workspace.getByRole('tab', { name: 'Attachments', exact: true }).click();
    await workspace.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'browser-report.txt' }).locator('pre')).toHaveText('Trusted fixture report\nLine two.');
    await page.getByRole('dialog', { name: 'browser-report.txt' }).getByRole('button', { name: 'Close' }).click();
    const download = page.waitForEvent('download');
    await workspace.getByRole('button', { name: 'Download', exact: true }).click();
    assert.equal((await download).suggestedFilename(), 'browser-report.txt');
    checks.push('clean-file-preview');
    const pdfFixturePage = await context.newPage();
    await pdfFixturePage.setContent('<!doctype html><html lang="en"><title>Isolated PDF fixture</title><body><h1>Browser PDF attachment</h1><p>Trusted fixture content.</p></body></html>');
    const pdfFixture = await pdfFixturePage.pdf({ format: 'A4' });
    await pdfFixturePage.close();
    const pdfChooser = page.waitForEvent('filechooser');
    await workspace.getByRole('button', { name: 'Upload file', exact: true }).click();
    await (await pdfChooser).setFiles({ name: 'browser-fixture.pdf', mimeType: 'application/pdf', buffer: pdfFixture });
    const pdfUploadResponse = page.waitForResponse(res => res.url().endsWith('/documents') && res.request().method() === 'POST');
    await page.getByRole('dialog', { name: 'Upload supporting file' }).getByRole('button', { name: 'Upload', exact: true }).click();
    const pdfFileId = (await (await pdfUploadResponse).json()).data.id;
    await expect(workspace.getByText('Awaiting security scan')).toBeVisible();
    documents.clearForTest(pdfFileId);
    await page.reload();
    await expect(page.locator('#submitButton')).toBeEnabled();
    await workspace.getByRole('tab', { name: 'Attachments', exact: true }).click();
    const pdfFileRow = workspace.locator('.dw-files li').filter({ has: page.getByText('browser-fixture.pdf', { exact: true }) });
    const pdfReadResponse = page.waitForResponse(res => res.url().endsWith(`/documents/${pdfFileId}`));
    await pdfFileRow.getByRole('button', { name: 'Open PDF', exact: true }).click();
    const pdfPreview = page.getByRole('dialog', { name: 'browser-fixture.pdf' });
    const viewerLink = pdfPreview.getByRole('link', { name: 'Open in PDF viewer' });
    await expect(viewerLink).toHaveAttribute('href', /^blob:/);
    await expect(viewerLink).toHaveAttribute('target', '_blank');
    await expect(viewerLink).toHaveAttribute('rel', 'noopener noreferrer');
    assert.equal(await pdfPreview.locator('iframe').count(), 0);
    const pdfResponse = await pdfReadResponse;
    assert.equal(pdfResponse.status(), 200);
    assert.equal(pdfResponse.headers()['content-type'], 'application/pdf');
    // Server preview responses retain their restrictive policy; the user may
    // explicitly open the trusted scanned bytes in the native browser viewer.
    const rawPdf = await page.request.get(`${origin}/api/pcns/${record.id}/documents/${pdfFileId}/preview`);
    assert.equal(rawPdf.status(), 200);
    assert.match(rawPdf.headers()['content-security-policy'], /sandbox/);
    const viewerPopup = page.waitForEvent('popup');
    await viewerLink.click();
    const pdfViewer = await viewerPopup;
    await expect(pdfViewer).toHaveURL(/^blob:/);
    assert.equal(await pdfViewer.evaluate(() => window.opener), null);
    await pdfViewer.waitForLoadState('domcontentloaded');
    await pdfViewer.screenshot({ path: path.resolve('test-results/document-native-pdf-viewer.png') });
    await pdfViewer.close();
    const pdfDownloadEvent = page.waitForEvent('download');
    await pdfPreview.getByRole('link', { name: 'Download PDF' }).click();
    const pdfDownload = await pdfDownloadEvent;
    assert.equal(pdfDownload.suggestedFilename(), 'browser-fixture.pdf');
    assert.deepEqual(await fs.readFile(await pdfDownload.path()), pdfFixture);
    await pdfPreview.screenshot({ path: path.resolve('test-results/document-pdf-attachment-preview.png') });
    await pdfPreview.getByRole('button', { name: 'Close' }).click();
    checks.push('clean-pdf-explicit-viewer-and-byte-exact-download-with-restrictive-server-preview');
    record = await save();
    assert.equal(record.status, 'submitted');
    await expect(workspace.getByText('Exact GSC Approver', { exact: true })).toBeVisible();
    assert.equal(await workspace.getByText('Different GSC Checker', { exact: true }).count(), 0);
    await workspace.getByRole('button', { name: 'Go to signing box' }).click();
    await expect(page.locator('[data-internal-field="signoff.gscTet.approved"]')).toBeFocused();
    checks.push('exact-next-stage-person-and-signing-link');
    await page.locator('[data-internal-field="signoff.gscTet.approved"]').check();
    record = await save();
    assert.equal(record.documentControl.signatureBindings['signoff.gscTet.approved'].contentRevision, record.documentControl.contentRevision);
    assert.equal(record.documentControl.signatureBindings['signoff.gscTet.approved'].userId, '0000001-id');
    const signedHistory = await repository.getRevisions(record.id);
    const signedRevision = signedHistory[0].revision;
    await workspace.getByRole('tab', { name: 'History', exact: true }).click();
    await workspace.getByRole('button', { name: `Save ${signedRevision}`, exact: true }).click();
    await expect(page.getByRole('dialog', { name: `Save ${signedRevision}`, exact: true })).toContainText('internalReview.signoff.gscTet.approved');
    await page.getByRole('dialog', { name: `Save ${signedRevision}`, exact: true }).getByRole('button', { name: 'Close' }).click();
    checks.push('immutable-saved-revision-diff-signature-binding');
    await workspace.getByRole('button', { name: 'Start new revision' }).click();
    const revisionDialog = page.getByRole('dialog', { name: 'Start a new revision' });
    await revisionDialog.getByRole('textbox', { name: 'Reason for revision' }).fill('Specification correction after review');
    let releaseMutationRead;
    const mutationReadGate = new Promise(resolve => { releaseMutationRead = resolve; });
    releaseHeldRead = releaseMutationRead;
    let mutationReadReached = false;
    let holdMutationRead = true;
    const holdCanonicalRead = async route => {
      if (holdMutationRead && route.request().method() === 'GET') {
        holdMutationRead = false; mutationReadReached = true; await mutationReadGate;
      }
      return route.continue();
    };
    await page.route(`${origin}/api/pcns/${record.id}`, holdCanonicalRead);
    const started = page.waitForResponse(res => res.url().endsWith('/revisions') && res.request().method() === 'POST');
    await revisionDialog.getByRole('button', { name: 'Start revision', exact: true }).click();
    assert.equal((await started).status(), 201);
    await expect.poll(() => mutationReadReached).toBe(true);
    await expect(page.locator('#pcnForm')).toHaveAttribute('inert', '');
    releaseMutationRead();
    await expect(page.locator('[data-internal-field="signoff.gscTet.approved"]')).not.toBeChecked();
    await expect(page.locator('#reason')).toBeEnabled();
    await expect(page.locator('#pcnForm')).not.toHaveAttribute('inert', '');
    await page.unroute(`${origin}/api/pcns/${record.id}`, holdCanonicalRead);
    const historical = await repository.getRevision(record.id, signedRevision);
    assert.equal(historical.snapshot.internalReview.signoff.gscTet.approved, true);
    checks.push('new-revision-reason-clears-current-signatures-preserves-history');
    checks.push('revision-refresh-blocks-editing-until-canonical-signatures-reset');
    await page.locator('#reason').fill('Recovered ordinary unsaved text');
    await selectedRow.getByLabel(/Current condition/).fill('Recovered current condition');
    await selectedRow.getByLabel(/New condition/).fill('Recovered new condition');
    await selectedRow.locator('.option-change-textarea').fill('Recovered change description');
    await page.locator('[data-internal-field="signoff.gscTet.approved"]').check();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('pcn.document-draft.v1:')))).toBe(true);
    const beforeRecovery = await repository.findById(record.id);
    page.once('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(page.locator('#documentRecoveryOffer')).toBeVisible();
    await expect(page.locator('#reason')).toHaveValue('First documented reason');
    await page.locator('#documentRecoveryRestore').click();
    await expect(page.locator('#reason')).toHaveValue('Recovered ordinary unsaved text');
    await expect(selectedRow.getByLabel(/Current condition/)).toHaveValue('Recovered current condition');
    await expect(selectedRow.getByLabel(/New condition/)).toHaveValue('Recovered new condition');
    await expect(selectedRow.locator('.option-change-textarea')).toHaveValue('Recovered change description');
    await expect(page.locator('[data-internal-field="signoff.gscTet.approved"]')).not.toBeChecked();
    assert.equal((await repository.findById(record.id)).version, beforeRecovery.version);
    await expect(workspace.getByRole('button', { name: 'Print / PDF' })).toBeDisabled();
    checks.push('explicit-recovery-restores-text-only-without-server-write-or-signatures');
    // A concurrent saved revision makes the local recovery copy stale, including
    // any delayed recovery write that is still bound to the loaded version.
    const concurrent = await repository.findById(record.id);
    await repository.update(record.id, current => ({ ...current, reason: 'Reason saved by another tab' }), 'other-tab-fixture', concurrent.version);
    page.once('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(page.locator('#documentRecoveryOffer')).toBeVisible();
    await expect(page.locator('#documentRecoveryRestore')).toBeHidden();
    await expect(page.locator('#documentRecoveryMessage')).toContainText('older saved version');
    await page.locator('#documentRecoveryDiscard').click();
    checks.push('stale-recovery-cannot-replace-saved-document');
    await page.locator('[data-internal-field="signoff.gscTet.approved"]').check();
    record = await save(true);
    await expect(page.locator('[data-internal-field="signoff.gscTet.approved"]')).toBeChecked();
    await page.evaluate(() => { window.__printCalls = 0; window.print = () => { window.__printCalls++; }; });
    await workspace.getByRole('button', { name: 'Print / PDF' }).click();
    await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
    await expect(page.locator('#documentPrintIdentity')).toContainText(record.id);
    await expect(page.locator('#documentPrintWatermark')).toHaveText('DRAFT');
    const exportConcurrent = await repository.findById(record.id);
    await repository.update(record.id, current => ({ ...current, updatedAt: new Date().toISOString() }), 'export-race-fixture', exportConcurrent.version);
    await workspace.getByRole('button', { name: 'Print / PDF' }).click();
    await expect(page.locator('#appNoticeTitle')).toHaveText('Document changed');
    assert.equal(await page.evaluate(() => window.__printCalls), 1);
    checks.push('export-refuses-stale-version-before-opening-print');
    await page.reload();
    await expect(page.locator('#submitButton')).toBeEnabled();
    await page.evaluate(() => { window.print = () => {}; });
    await workspace.getByRole('button', { name: 'Print / PDF' }).click();
    await expect(page.locator('#documentPrintIdentity')).toContainText(record.id);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await workspace.isVisible(), false);
    await expect(page.locator('.topbar')).toBeHidden();
    await expect(page.locator('.summary-panel')).toBeHidden();
    await expect(page.locator('.tabs')).toBeHidden();
    await expect(page.locator('[data-internal-field="signoff.gscTet.approved"]').locator('..').locator('.signoff-handwritten-name')).toContainText('Document');
    assert.match(await page.locator('[data-internal-field="signoff.gscTet.approved"]').evaluate(control => getComputedStyle(control).backgroundImage), /data:image\/svg\+xml/);
    const pdf = await page.pdf({ path: path.resolve('test-results/document-controlled-draft.pdf'), preferCSSPageSize: true, printBackground: true });
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.length > 10000);
    await page.screenshot({ path: path.resolve('test-results/document-print-layout.png'), fullPage: true });
    await page.emulateMedia({ media: 'screen' });
    await page.setViewportSize({ width: 390, height: 844 });
    await workspace.scrollIntoViewIfNeeded();
    const mobileBounds = await workspace.boundingBox();
    assert.ok(mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 390, 'Document controls fit the mobile viewport');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.resolve('test-results/document-controls-mobile.png'), fullPage: false });
    checks.push('clean-current-version-export-draft-stamp-standalone-pdf-print-layout');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(JSON.stringify({ browser: 'passed', checks, storage: 'isolated_test_adapters' }));
  } finally {
    releaseHeldRead();
    try {
      if (tracingStarted) await context.tracing.stop({ path: path.resolve('test-results/document-control-trace.zip') });
    } finally {
      try { if (browser) await browser.close(); }
      finally { if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
