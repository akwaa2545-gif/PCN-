// Dedicated creation acceptance: synthetic loopback data, fake files/scanner and captured outbox only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: baseExpect } = require('@playwright/test');
const expect = baseExpect.configure({ timeout: 10000 });
const layoutOnly = process.argv.includes('--layout-only');
const retryOnly = process.argv.includes('--retry-only');
const identityOnly = process.argv.includes('--identity-only');
const previewOnly = process.argv.includes('--preview-only');
const entryMenuOnly = process.argv.includes('--entry-menu-only');
const artifactSuffix = entryMenuOnly ? '-entry-menu' : layoutOnly ? '-layout' : retryOnly ? '-retry' : identityOnly ? '-identity' : previewOnly ? '-preview' : '';
function checked(description) { report.checks.push(description); console.log(JSON.stringify({ creationCheck: description })); }
const report = { storage: 'isolated_memory_only', checks: [], errors: [], external: [], writes: [], outbox: [], submissions: [] };

function isolatedSystem(origin) {
  const { createRequestHandler } = require('../src/httpServer');
  const { PcnService } = require('../src/pcnService');
  const { PcnCreationService } = require('../src/pcnCreation');
  const { NotificationService } = require('../src/notificationService');
  const { applyDocumentControl, hasSignatures } = require('../src/documentControl');
  const { ApiError } = require('../src/apiError');
  const { memoryRepository, fakeAuthService, TEST_PASSWORD } = require('../test/helpers/apiHarness');
  const masterData = require('../src/masterData');
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const users = [{ username: 'create-admin', displayName: 'Creation Administrator', roles: ['admin'] },
    { username: 'create-preparer', displayName: 'Assigned GSC Preparer', roles: ['gsc'], department: 'gscTet', signingStep: 'prepared' }];
  const authService = fakeAuthService({ additionalUsers: users });
  const settings = { schemaVersion: 2, groups: [{ key: 'department.gscTet.prepared', emails: 'prepared@example.test' }] };
  let files = [], scanState = 'pendingScan', jobState = 'pending';
  const jobs = [];
  const metadata = file => Object.fromEntries(Object.entries(file).filter(([key]) => !['code','bytes'].includes(key)));
  const documents = {
    async list(code) { return structuredClone(files.filter(file => file.code === code && !file.deletedAt).map(metadata)); },
    async listForRecords(ids) {
      return new Map(await Promise.all(ids.map(async id => [id, { parentVersion: (await repository.findById(id))?.version,
        attachments: await this.list(id) }])));
    },
    async save(code, input, context) {
      const before = await repository.findById(code);
      if (hasSignatures(before)) throw new ApiError(409, 'Signed attachments are immutable');
      const file = { id: crypto.randomUUID(), code, fileName: input.fileName, contentType: input.contentType,
        bytes: Buffer.from(input.base64, 'base64'), sizeBytes: Buffer.from(input.base64, 'base64').length,
        scanStatus: scanState, requirementName: input.requirementName || null, uploadedAt: new Date().toISOString() };
      const saved = await repository.update(code, current => applyDocumentControl(current,
        { ...current, documentControl: { ...current.documentControl, attachmentGeneration: (current.documentControl?.attachmentGeneration || 0) + 1 } },
        context.user, file.uploadedAt), context.actor, context.version);
      files = [...files, { ...file, contentRevision: saved.documentControl.contentRevision }];
      return { id: file.id, version: saved.version };
    },
    async delete(code, id, context) {
      const saved = await repository.update(code, current => applyDocumentControl(current,
        { ...current, documentControl: { ...current.documentControl, attachmentGeneration: (current.documentControl?.attachmentGeneration || 0) + 1 } },
        context.user, new Date().toISOString()), context.actor, context.version);
      files = files.map(file => file.id === id && file.code === code ? { ...file, deletedAt: new Date().toISOString() } : file);
      return { id, version: saved.version };
    },
    async get(code, id) {
      const file = files.find(item => item.id === id && item.code === code && !item.deletedAt);
      if (!file) throw new ApiError(404, 'File not found');
      if (file.scanStatus !== 'clean') throw new ApiError(423, 'File is awaiting a trusted scan');
      return { FileName: file.fileName, ContentType: file.contentType, Bytes: file.bytes };
    }
  };
  const tx = { request() {
    const values = {};
    return { input(key, type, value) { values[key] = value; return this; }, async query(statement) {
      if (statement.includes('sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
      if (statement.includes('SELECT SettingsJson')) return { recordset: [{ SettingsJson: JSON.stringify(settings) }] };
      if (statement.includes('FROM pcn.Users')) return { recordset: [] };
      if (statement.includes('INSERT pcn.NotificationJobs')) {
        jobs.push({ ...values, payload: JSON.parse(values.payload) });
        return { recordset: [{ Id: values.id, Status: 'pending' }] };
      }
      if (statement.includes('UPDATE pcn.NotificationJobs')) return { recordset: [] };
      throw new Error('Unexpected isolated notification query');
    } };
  } };
  const notifications = new NotificationService(null, { repository, publicOrigin: origin, mailUrl: 'https://mail.example.test/captured-only' });
  const create = repository.create.bind(repository), update = repository.update.bind(repository);
  repository.create = async (record, actor, user, options) => {
    const prepared = await notifications.prepare(tx, null, record);
    const saved = await create(prepared.record, actor, user, options);
    await notifications.persisted(tx, saved, prepared.plan);
    return saved;
  };
  repository.update = async (id, updater, actor, version) => {
    let plan;
    const saved = await update(id, async current => {
      const proposed = await updater(current, { listAttachments: () => documents.list(id) });
      const prepared = await notifications.prepare(tx, current, proposed);
      plan = prepared.plan;
      return prepared.record;
    }, actor, version);
    await notifications.persisted(tx, saved, plan);
    return saved;
  };
  repository.getNotificationSettings = async () => structuredClone(settings);
  repository.getNotificationStatus = async (id, version) => jobs.filter(job => job.pcnId === id && job.version === version)
    .map(() => ({ Status: jobState, JobCount: 1, ...(jobState === 'sent' ? { LatestAcceptedAt: new Date().toISOString() } : {}) }));
  const service = new PcnService(repository);
  const creationService = new PcnCreationService({ repository, service, documents, authRepository: authService.repository,
    scannerConfigured: false, mailConfigurationStatus: () => 'configured' });
  return { repository, service, documents, creationService, jobs, password: TEST_PASSWORD,
    setScanState(value) { scanState = value; }, setJobState(value) { jobState = value; },
    handler: createRequestHandler({ repository, service, documents, creationService, authService,
      rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }) };
}

async function main() {
  const server = http.createServer();
  let browser, context, page, system;
  const contexts = [], releases = [];
  try {
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const available = await fs.access(path.resolve('create.html')).then(() => true, () => false);
    // Missing assets are an explicit first RED; unfinished modules are never substituted for production behavior.
    if (available) { system = isolatedSystem(origin); server.on('request', system.handler); }
    else server.on('request', (request, response) => { response.writeHead(404); response.end('Dedicated Create PCN page is not available'); });
    browser = await chromium.launch({ headless: true });
    const openContext = async (username = 'create-admin') => {
      const next = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      contexts.push(next);
      await next.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
      if (url.pathname === '/api/admin/notifications/health') return route.fulfill({ json: { success: true, data: { configuration: { status: 'configured' }, worker: { status: 'disabled' }, queue: {} } } });
      if (!['GET','HEAD'].includes(request.method())) report.writes.push({ method: request.method(), path: url.pathname });
      if (request.method() === 'PATCH' && /^\/api\/pcns\/PCN-\d{4}-\d{4}$/.test(url.pathname)) {
        const body = request.postDataJSON(); if (body.status === 'submitted') report.submissions.push({ path: url.pathname, body });
      }
      return route.continue();
      });
      if (system) {
        const response = await next.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: system.password } });
        assert.equal(response.status(), 200);
      }
      return next;
    };
    context = await openContext();
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', error => report.errors.push(error.message));
    if(entryMenuOnly){
      await page.goto(`${origin}/admin`);
      const trigger=page.getByRole('button',{name:'Create PCN',exact:true}),menu=page.locator('#createStartOptions');
      await expect(trigger).toHaveAttribute('aria-expanded','false');
      await expect(menu).toBeHidden();await trigger.hover();await expect(menu).toBeVisible();
      await expect(menu.locator('a')).toHaveText(['Blank PCN','Common change starter','Copy existing PCN','Resume draft']);
      await menu.getByRole('link',{name:'Blank PCN',exact:true}).hover();await expect(menu).toBeVisible();
      await page.screenshot({path:path.resolve('test-results/create-pcn-entry-menu-desktop.png')});
      await page.mouse.move(1,500);await expect(menu).toBeHidden();
      await trigger.focus();await page.keyboard.press('ArrowDown');
      await expect(menu.locator('a').first()).toBeFocused();await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();await expect(trigger).toBeFocused();
      await trigger.click();await expect(menu).toBeVisible();await page.locator('#adminRefreshButton').click();await expect(menu).toBeHidden();
      checked('Create dropdown supports hover without gaps, keyboard opening, Escape, click and outside dismissal');
      const choices=[['Blank PCN','#createEditor'],['Common change starter','#starterOption'],['Copy existing PCN','#templatePcnId'],['Resume draft','#entryChoices']];
      for(const [label,target]of choices){
        await page.goto(`${origin}/admin`);await trigger.hover();await menu.getByRole('link',{name:label,exact:true}).click();
        await expect(page.locator(target)).toBeVisible();
        if(label==='Resume draft')await expect(page.locator('#entryChoices')).toContainText('You have no unfinished drafts');
        assert.equal((await system.repository.list()).length,0);assert.deepEqual(system.jobs,[]);
      }
      checked('All four header choices open their matching Create flow without creating records or queuing mail');
      await page.setViewportSize({width:390,height:844});await page.goto(`${origin}/admin`);
      await trigger.click();await expect(menu).toBeVisible();
      const box=await menu.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390,'Dropdown stays inside mobile viewport');
      await page.screenshot({path:path.resolve('test-results/create-pcn-entry-menu-mobile.png')});
      await menu.getByRole('link',{name:'Copy existing PCN',exact:true}).click();await expect(page.locator('#templatePcnId')).toBeFocused();
      await page.goto(`${origin}/create?start=unrecognized`);await expect(page.locator('#createEntry')).toBeVisible();await expect(page.locator('#createEditor')).toBeHidden();
      checked('Small-screen click navigation fits the viewport and unknown start choices safely keep the entry chooser');
      assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);report.status='passed';return;
    }
    const response = await page.goto(`${origin}/create`);
    assert.equal(response.status(), 200, 'Dedicated Create PCN page is served');
    await expect(page.getByRole('heading', { name: 'Create a PCN', exact: true })).toBeVisible();
    assert.equal((await system.repository.list()).length, 0, 'Opening blank Create never creates a PCN');
    assert.deepEqual(system.jobs, [], 'Opening blank Create never queues mail');
    await page.locator('#startBlank').click();
    await expect(page.locator('#createEditor')).toBeVisible();
    checked('Dedicated blank Create page opens without allocating a PCN or sending notifications');
    await page.screenshot({ path: path.resolve('test-results/create-pcn-desktop.png'), fullPage: true });
    const verifyDocumentPreview = async (id, stress = false) => {
      const dialog = page.locator('#documentPreviewDialog'), frameElement = page.locator('#documentPreviewFrame');
      const status = page.locator('#documentPreviewStatus'), previewButton = page.locator('#previewDocument');
      const originalUrl = page.url(), originalPages = context.pages().length;
      let pending = null, release = () => {};
      const holdPreview = async route => {
        pending = new URL(route.request().url());
        await new Promise(resolve => { release = resolve; releases.push(resolve); });
        return route.continue();
      };
      await context.route(`${origin}/document-preview?*`, holdPreview);
      await previewButton.click();
      await expect(dialog).toBeVisible();
      assert.equal(await dialog.evaluate(node => node.tagName), 'DIALOG');
      await expect(status).toBeVisible(); await expect(status).toContainText(/loading/i);
      await expect(frameElement).toBeHidden();
      await expect.poll(() => pending !== null).toBe(true);
      const firstRequest = pending;
      const canonical = await system.repository.findById(id);
      assert.equal(firstRequest.searchParams.get('id'), id);
      assert.equal(firstRequest.searchParams.get('version'), canonical.version);
      assert(firstRequest.searchParams.get('request'), 'Every preview has a readiness generation');
      assert.equal(page.url(), originalUrl); assert.equal(context.pages().length, originalPages);
      assert.equal(canonical.status, 'draft'); assert.equal(require('../src/documentControl').hasSignatures(canonical), false);
      release();
      await expect(frameElement).toBeVisible(); await expect(status).toBeHidden();
      const frame = page.frameLocator('#documentPreviewFrame');
      await expect(frame.locator('body')).toHaveClass(/document-preview-only/);
      await expect(frame.locator('.supplier-sheet')).toBeVisible();
      await expect(frame.locator('#supplierName')).toHaveValue(canonical.supplierName);
      await expect(frame.locator('#documentTestBadge')).toBeVisible();
      await expect(frame.locator('#documentPrintIdentity')).toContainText('DRAFT');
      for (const chrome of ['.topbar', '.tabs', '.summary-panel', '.form-action-dock', '#appNotice']) await expect(frame.locator(chrome)).toBeHidden();
      assert.equal(await frame.locator('.supplier-sheet input:enabled, .supplier-sheet select:enabled, .supplier-sheet textarea:enabled, .supplier-sheet button:enabled').count(), 0);
      assert.equal(await frameElement.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
      await page.screenshot({ path: path.resolve('test-results/create-pcn-preview-desktop.png') });
      await frame.locator('body').press('Escape');
      await expect(dialog).toBeHidden(); await expect(previewButton).toBeFocused();
      checked('Native same-page preview flushes edits, waits for readiness and shows only the disabled official testing draft; child Escape restores focus');
      if (stress) {
        pending = null;
        await previewButton.click(); await expect(status).toBeVisible(); await expect(frameElement).toBeHidden();
        await expect.poll(() => pending !== null).toBe(true);
        assert.notEqual(pending.searchParams.get('request'), firstRequest.searchParams.get('request'));
        assert.equal(pending.searchParams.get('version'), firstRequest.searchParams.get('version'));
        const child = page.frames().find(candidate => candidate.parentFrame() === page.mainFrame());
        assert(child, 'Native preview owns one child frame');
        await child.evaluate(({ origin, id, version, request }) => parent.postMessage({ type: 'pcn-document-preview', state: 'ready', id, version, request }, origin),
          { origin, id, version: canonical.version, request: firstRequest.searchParams.get('request') });
        await expect(frameElement).toBeHidden(); await expect(status).toBeVisible();
        release(); await expect(frameElement).toBeVisible(); await expect(status).toBeHidden();
        const postFromChild = async payload => {
          const barrier = crypto.randomUUID();
          await page.evaluate(token => {
            window.previewTestBarrier = new Promise(resolve => {
              const listener = event => {
                if (event.data?.type !== 'preview-test-barrier' || event.data.token !== token) return;
                removeEventListener('message', listener); resolve();
              };
              addEventListener('message', listener);
            });
          }, barrier);
          await child.evaluate(({ payload, origin, barrier }) => {
            parent.postMessage(payload, origin);
            parent.postMessage({ type: 'preview-test-barrier', token: barrier }, origin);
          }, { payload, origin, barrier });
          await page.evaluate(() => window.previewTestBarrier);
        };
        const currentIdentity = { type: 'pcn-document-preview', id, version: canonical.version, request: pending.searchParams.get('request') };
        await postFromChild({ ...currentIdentity, state: 'error', message: 'Synthetic preview failed after loading' });
        await expect(status).toContainText('Synthetic preview failed after loading'); await expect(frameElement).toBeHidden();
        await postFromChild({ ...currentIdentity, state: 'ready' });
        await expect(status).toBeVisible(); await expect(status).toContainText('Synthetic preview failed after loading');
        await expect(frameElement).toBeHidden();
        await page.locator('#closeDocumentPreview').click(); await expect(dialog).toBeHidden(); await expect(previewButton).toBeFocused();
        await page.locator('#supplierName').fill('TEST Preview reopened latest edit');
        pending = null;
        await previewButton.click(); await expect.poll(() => pending !== null).toBe(true);
        release(); await expect(frameElement).toBeVisible();
        await expect(frame.locator('#supplierName')).toHaveValue('TEST Preview reopened latest edit');
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await dialog.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }), true);
        await expect(page.locator('#closeDocumentPreview')).toBeVisible();
        await page.screenshot({ path: path.resolve('test-results/create-pcn-preview-mobile.png') });
        await page.locator('#closeDocumentPreview').click(); await expect(previewButton).toBeFocused();
        await page.setViewportSize({ width: 1440, height: 1000 });
        pending = null;
        await previewButton.click(); await expect.poll(() => pending !== null).toBe(true);
        await page.locator('#closeDocumentPreview').click();
        release();
        await expect(dialog).toBeHidden(); await expect(frameElement).toBeHidden();
        assert.equal(page.url(), originalUrl); assert.equal(context.pages().length, originalPages);
        checked('Reopening ignores old-generation and error-following readiness, reloads current saved edits, fits mobile and cannot reveal a closed stale preview');
      }
      await context.unroute(`${origin}/document-preview?*`, holdPreview);
      assert.deepEqual(system.jobs, []);
    };
    if (previewOnly) {
      const model = require('../create-model'), master = require('../src/masterData');
      const created = await system.creationService.create({ clientDraftKey: crypto.randomUUID(),
        document: model.toPayload(model.sample(master)), testDocument: true }, 'preview-fixture',
        { id: 'create-admin-id', roles: ['admin'], isActive: true });
      await page.goto(`${origin}/create?draft=${created.record.id}`);
      await expect(page.locator('#createEditor')).toBeVisible();
      await page.locator('#supplierName').fill('TEST Preview latest unsaved edit');
      await verifyDocumentPreview(created.record.id, true);
      assert.equal((await system.repository.findById(created.record.id)).supplierName, 'TEST Preview reopened latest edit');
      assert.deepEqual(system.jobs, []);
      assert.deepEqual(report.submissions, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
      report.status = 'passed'; return;
    }
    if (identityOnly) {
      const model = require('../create-model'), master = require('../src/masterData');
      const user = { id: 'create-admin-id', roles: ['admin'], isActive: true };
      const oldKey = crypto.randomUUID();
      const original = (await system.creationService.create({ clientDraftKey: oldKey,
        document: { ...model.toPayload(model.blank(master)), supplierName: 'Original normal draft', materialName: 'Original normal material' } }, 'identity-fixture', user)).record;
      let source = (await system.creationService.create({ clientDraftKey: crypto.randomUUID(),
        document: model.toPayload(model.sample(master)), testDocument: true }, 'identity-fixture', user)).record;
      source = await system.repository.seedHistoricalReview(source.id, { signoff: { gscTet: {
        prepared: true, preparedName: 'Historical Testing Preparer', preparedDate: '2026-10-01'
      } } });
      assert.equal(require('../src/documentControl').hasSignatures(source), true);
      await page.goto(`${origin}/create?client=${oldKey}`);
      await page.locator('#startCopy').click();
      await page.locator('#templatePcnId').fill(source.id); await page.locator('#copyTemplate').click();
      await expect(page.locator('#testDocumentBadge')).toBeVisible();
      await page.locator('#saveDraftButton').click();
      await expect(page.locator('#draftSaveStatus')).toContainText('Saved at');
      const copied = await system.repository.findById((await page.locator('#draftIdentity').textContent()).trim());
      assert.notEqual(copied.id, original.id); assert.notEqual(copied.id, source.id);
      assert.notEqual(copied.creationDraftKey, oldKey); assert.equal(copied.isTestDocument, true);
      assert.equal(require('../src/documentControl').hasSignatures(copied), false);
      assert.equal(copied.supplierName, source.supplierName);
      assert.deepEqual(await system.repository.findById(original.id), original);
      assert.deepEqual(await system.repository.findById(source.id), source);
      checked('Copy from a committed normal client URL creates a fresh testing identity, strips source signatures and preserves both source records');
      await page.goto(`${origin}/create?client=${oldKey}`);
      await page.locator('#startCommon').click(); await page.locator('#useStarter').click();
      await page.locator('#saveDraftButton').click();
      await expect(page.locator('#draftSaveStatus')).toContainText('Saved at');
      const starter = await system.repository.findById((await page.locator('#draftIdentity').textContent()).trim());
      assert.notEqual(starter.id, original.id); assert.notEqual(starter.id, copied.id);
      assert.notEqual(starter.creationDraftKey, oldKey); assert.notEqual(starter.creationDraftKey, copied.creationDraftKey);
      assert.notEqual(starter.isTestDocument, true);
      assert.deepEqual(await system.repository.findById(original.id), original);
      assert.equal((await system.repository.list()).length, 4);
      assert.deepEqual(system.jobs, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
      checked('Common starter also replaces an old client URL with a fresh normal draft identity without replaying or overwriting the prior PCN');
      report.status = 'passed'; return;
    }
    if (retryOnly) {
      const attempts = [];
      await context.route(`${origin}/api/pcn-drafts`, route => {
        if (route.request().method() !== 'POST') return route.continue();
        const body = route.request().postDataJSON();
        attempts.push({ key: body.clientDraftKey, testing: body.testDocument });
        if (attempts.length === 1) return route.fulfill({ status: 409, json: { success: false, error: 'Draft creation is busy; retry this draft.' } });
        return route.continue();
      });
      await page.locator('#fillTestDocument').click();
      await expect(page.locator('#testDocumentBadge')).toBeVisible();
      await expect(page.locator('#draftSaveStatus')).toContainText(/changed|attention/i);
      await expect(page.locator('#retrySave')).toHaveText('Retry save');
      assert.equal((await system.repository.list()).length, 0);
      await page.locator('#retrySave').click();
      await expect(page.locator('#createConfirm')).toBeHidden();
      await expect(page.locator('#draftSaveStatus')).toContainText('Saved at');
      const id = (await page.locator('#draftIdentity').textContent()).trim();
      const canonical = await system.repository.findById(id);
      assert.equal(canonical.isTestDocument, true); assert.equal(canonical.status, 'draft');
      assert.equal(attempts.length, 2); assert.equal(attempts[0].key, attempts[1].key);
      assert.equal(attempts[0].testing, true); assert.equal(attempts[1].testing, true);
      await expect(page.locator('#supplierName')).toHaveValue(/TEST/i);
      await expect(page.locator('#testDocumentBadge')).toBeVisible();
      assert.deepEqual(system.jobs, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
      checked('An initial POST409 retries the same UUID and testing identity without a nonexistent-record reload, duplicate PCN or mail');
      report.status = 'passed'; return;
    }
    if (layoutOnly) {
      const model = require('../create-model'), master = require('../src/masterData');
      const created = await system.creationService.create({ clientDraftKey: crypto.randomUUID(), document: model.toPayload(model.sample(master)), testDocument: true },
        'layout-fixture', { id: 'create-admin-id', roles: ['admin'], isActive: true });
      await page.goto(`${origin}/create?draft=${created.record.id}`);
      await expect(page.locator('#createEditor')).toBeVisible();
      await expect(page.locator('#testDocumentBadge')).toBeVisible();
      await expect(page.locator('#draftSaveStatus')).toContainText(/^Saved(?: at| draft)/);
      await expect(page.locator('#draftSaveStatus')).not.toContainText('Loading');
      await page.locator('[data-stage="changes"]').click();
      if (await page.locator('#createNotice').isVisible()) await page.locator('#dismissNotice').click();
      for (const width of [350, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px creation page has no horizontal overflow`);
        assert((await page.locator('.create-topbar').boundingBox()).height < 100, `${width}px account header stays compact`);
        await page.screenshot({ path: path.resolve(`test-results/${width === 390 ? 'create-pcn-mobile' : 'create-pcn-mobile-350'}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: path.resolve('test-results/create-pcn-editor-desktop.png'), fullPage: true });
      assert.deepEqual(system.jobs, []);
      checked('Fresh 350px and 390px creation layouts have a compact account header, no overflow and clean editable testing-document captures');
      assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
      report.status = 'passed'; return;
    }
    await page.locator('#nextStage').click();
    await expect(page.locator('#supplierName')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#supplierName')).toBeFocused();
    await expect(page.locator('[data-error="supplierName"]')).toContainText(/required/i);
    await expect(page.locator('#createNotice')).toBeVisible();
    assert.equal(await page.locator('#createNotice').evaluate(node => getComputedStyle(node).position), 'fixed');
    await page.locator('#supplierName').fill('Creation supplier draft');
    await page.locator('#materialName').fill('Creation material draft');
    await expect(page.locator('#supplierName')).toHaveAttribute('aria-invalid', 'false');
    const saveDraft = async target => {
      await target.locator('#saveDraftButton').click();
      await expect(target.locator('#draftSaveStatus')).toContainText('Saved at');
      const id = (await target.locator('#draftIdentity').textContent()).trim();
      assert.match(id, /^PCN-\d{4}-\d{4}$/);
      return system.repository.findById(id);
    };
    const normal = await saveDraft(page);
    assert.equal(normal.status, 'draft'); assert.notEqual(normal.isTestDocument, true);
    assert.equal(system.jobs.length, 0);
    checked('Live required-field errors preserve input; explicit draft save remains unsigned and sends no notification');

    const { unsignedPayload } = require('../test/helpers/apiHarness');
    const other = await system.service.create({ ...unsignedPayload, status: 'draft', internalReview: {} }, 'other-owner-fixture', { id: 'other-id', roles: ['supplier'] });
    const second = await openContext(), secondPage = await second.newPage();
    secondPage.setDefaultTimeout(10000);
    await secondPage.goto(`${origin}/create`);
    await secondPage.locator('#startResume').click();
    await expect(secondPage.locator(`[data-draft="${normal.id}"]`)).toBeVisible();
    await expect(secondPage.locator(`[data-draft="${other.id}"]`)).toHaveCount(0);
    assert.equal((await second.request.get(`${origin}/api/pcn-drafts/${other.id}`)).status(), 404);
    await secondPage.locator(`[data-draft="${normal.id}"]`).click();
    await expect(secondPage.locator('#supplierName')).toHaveValue('Creation supplier draft');
    await secondPage.locator('#materialName').fill('Material from second device');
    await saveDraft(secondPage);
    await page.locator('#manufacturerName').fill('Unsaved first-device correction');
    await page.locator('#saveDraftButton').click();
    await expect(page.locator('#draftSaveStatus')).toContainText(/changed/i);
    await expect(page.locator('#manufacturerName')).toHaveValue('Unsaved first-device correction');
    await page.locator('#retrySave').click(); await page.locator('#confirmCancel').click();
    await expect(page.locator('#manufacturerName')).toHaveValue('Unsaved first-device correction');
    await page.locator('#retrySave').click(); await page.locator('#confirmAccept').click();
    await expect(page.locator('#materialName')).toHaveValue('Material from second device');
    await second.close();
    checked('Owned server drafts resume on another device, exclude another owner, and version conflicts preserve edits until explicit reload');

    await page.locator('#fillTestDocument').click();
    await expect(page.locator('#createConfirm')).toBeVisible();
    await page.locator('#confirmCancel').click();
    assert.notEqual((await system.repository.findById(normal.id)).isTestDocument, true);
    await page.locator('#fillTestDocument').click(); await page.locator('#confirmAccept').click();
    await expect(page.locator('#testDocumentBadge')).toBeVisible();
    await expect(page.locator('#supplierName')).toHaveValue(/TEST/i);
    let testing = await saveDraft(page);
    assert.notEqual(testing.id, normal.id); assert.equal(testing.isTestDocument, true);
    assert.equal(system.jobs.length, 0); assert.deepEqual(await system.documents.list(testing.id), []);
    await page.reload();
    await expect(page.locator('#testDocumentBadge')).toBeVisible();
    await expect(page.locator('#supplierName')).toHaveValue(/TEST/i);
    const third = await openContext(), thirdPage = await third.newPage();
    await thirdPage.goto(`${origin}/create?draft=${testing.id}`);
    await expect(thirdPage.locator('#testDocumentBadge')).toBeVisible();
    await third.close();
    checked('Test document creates a fresh marked draft, never converts a saved normal draft, and retains TESTING DOC through refresh and cross-device resume');

    await page.locator('[data-stage="documents"]').click();
    const card = page.locator('[data-requirement="greenProcurement"]');
    await card.getByRole('checkbox').check();
    await expect(card.locator('.create-document-status')).toContainText('Missing');
    await card.locator('input[type=file]').setInputFiles({ name: 'pending-report.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic report awaiting scan') });
    await expect(card.locator('.create-document-status')).toContainText(/Awaiting scan/);
    await expect(card).toContainText(/scanning unavailable|trusted malware scan/i);
    await page.locator('[data-stage="review"]').click();
    await expect(page.locator('#submitButton')).toBeEnabled();
    await page.locator('#submitButton').click();
    await expect(page.locator('#createNotice')).toContainText(/Green Procurement|green procurement/i);
    assert.equal((await system.repository.findById(testing.id)).status, 'draft');
    assert.equal(report.submissions.length, 0); assert.equal(system.jobs.length, 0);
    await page.locator('[data-stage="documents"]').click();
    await card.getByRole('button', { name: 'Remove pending-report.txt' }).click();
    await expect(card.locator('.create-document-status')).toContainText('Missing');
    system.setScanState('clean');
    await card.locator('input[type=file]').setInputFiles({ name: 'clean-report.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic trusted clean report') });
    await expect(card.locator('.create-document-status')).toContainText('Ready');
    testing = await system.repository.findById(testing.id);
    assert.equal((await system.documents.list(testing.id)).length, 1);
    assert.equal(system.jobs.length, 0);
    checked('Actual versioned uploads show pending/unavailable scan, block submission, support removal, and require a trusted clean replacement');

    await verifyDocumentPreview(testing.id);
    const preview = await context.newPage(); preview.setDefaultTimeout(10000);
    await preview.goto(`${origin}/form.html?id=${testing.id}`);
    await expect(preview.locator('#appNoticeTitle')).toContainText('PCN loaded');
    await expect(preview.getByText('TESTING DOC', { exact: true }).first()).toBeVisible();
    assert.equal(await preview.locator('.supplier-sheet').count(), 1);
    await preview.evaluate(() => { window.print = () => {}; });
    await preview.getByRole('button', { name: 'Print / PDF' }).click();
    await preview.emulateMedia({ media: 'print' });
    await expect(preview.getByText('TESTING DOC', { exact: true }).first()).toBeVisible();
    await preview.pdf({ path: path.resolve('test-results/create-pcn-testing-official.pdf'), printBackground: true, preferCSSPageSize: true });
    await preview.close();
    assert.equal(system.jobs.length, 0);
    checked('Separate official Print/PDF export retains the genuine sheet, DRAFT protection and persistent TESTING DOC without submitting');

    await page.locator('[data-stage="review"]').click();
    await expect(page.locator('#nextActionLabel')).toContainText(/GSC\/TET.*Prepared/);
    await expect(page.locator('#nextActionPeople')).toContainText('Assigned GSC Preparer');
    await expect(page.locator('#submitButton')).toBeEnabled();
    await page.locator('#submitButton').click({ clickCount: 2 });
    await expect(page.locator('#submissionReceipt')).toBeVisible();
    await expect(page.locator('#receiptDetails')).toContainText('Queued');
    await expect(page.locator('#receiptDetails')).toContainText(/GSC\/TET.*Prepared/);
    await expect(page.locator('#receiptDetails')).not.toContainText('prepared@example.test');
    assert.equal(report.submissions.length, 1);
    assert.deepEqual(Object.keys(report.submissions[0].body).sort(), ['status','version']);
    assert.equal(system.jobs.length, 1); assert.equal(system.jobs[0].payload.to, 'prepared@example.test');
    assert.match(system.jobs[0].payload.subject, /TESTING DOC/);
    system.setJobState('sent');
    await expect(page.locator('#receiptDetails')).toContainText('Accepted by workflow', { timeout: 10000 });
    assert.doesNotMatch(await page.locator('#receiptDetails').textContent(), /(?:email|mail) (?:was )?delivered/i);
    testing = await system.repository.findById(testing.id);
    assert.equal(testing.status, 'submitted'); assert.equal(testing.isTestDocument, true);
    checked('Only explicit submission changes status once and queues the exact Prepared recipient; receipt distinguishes Queued and workflow acceptance from delivery');

    testing = await system.service.update(testing.id, { version: testing.version, internalReview: { signoff: { gscTet: { prepared: true } } } }, 'fixture-preparer',
      { id: 'create-preparer-id', displayName: 'Assigned GSC Preparer', roles: ['gsc'], department: 'gscTet', signingStep: 'prepared' });
    await page.locator('#receiptNew').click(); await page.locator('#confirmAccept').click();
    await page.locator('#startCopy').click();
    await page.locator('#templatePcnId').fill(testing.id); await page.locator('#copyTemplate').click();
    await expect(page.locator('#testDocumentBadge')).toBeVisible();
    const copied = await saveDraft(page);
    assert.notEqual(copied.id, testing.id); assert.equal(copied.isTestDocument, true);
    assert.equal(require('../src/documentControl').hasSignatures(copied), false);
    assert.deepEqual(await system.documents.list(copied.id), []);
    assert.equal(copied.mailRoutingState, undefined);
    checked('Copying a signed testing PCN starts a fresh TESTING DOC without signatures, files, bindings or routing state');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Creation page fits mobile viewport');
    await page.locator('[data-stage="changes"]').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('[data-panel="changes"]')).toBeVisible();
    await page.screenshot({ path: path.resolve('test-results/create-pcn-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.resolve('test-results/create-pcn-editor-desktop.png'), fullPage: true });
    checked('Desktop/mobile creation layout fits, and keyboard stage navigation remains usable');

    await page.locator('[data-stage="documents"]').click();
    const noteCard = page.locator('[data-requirement="supplierDocument"]');
    await noteCard.getByRole('checkbox').check(); await saveDraft(page);
    await page.locator('[data-stage="details"]').click();
    let enterDocuments, releaseDocuments;
    const documentsEntered = new Promise(resolve => { enterDocuments = resolve; });
    const documentsGate = new Promise(resolve => { releaseDocuments = resolve; }); releases.push(releaseDocuments);
    let holdDocuments = true;
    const documentsUrl = `${origin}/api/pcns/${copied.id}/documents`;
    const heldDocuments = async route => {
      if (route.request().method() === 'GET' && holdDocuments) { holdDocuments = false; enterDocuments(); await documentsGate; }
      return route.continue();
    };
    await context.route(documentsUrl, heldDocuments);
    await page.locator('[data-stage="documents"]').click(); await documentsEntered;
    const note = noteCard.locator('input[type=text]');
    await note.fill('Description kept while files refresh');
    await note.evaluate(node => { node.focus(); node.setSelectionRange(9, 9); });
    const documentsReply = page.waitForResponse(documentsUrl);
    releaseDocuments(); await documentsReply;
    await expect(note).toHaveValue('Description kept while files refresh');
    await expect(note).toBeFocused();
    assert.deepEqual(await note.evaluate(node => [node.selectionStart, node.selectionEnd]), [9, 9]);
    await note.blur(); await saveDraft(page); await context.unroute(documentsUrl, heldDocuments);
    checked('A delayed document-list response preserves the active requirement description, keyboard focus and caret');

    let restrictedDraft = await system.service.create({ ...unsignedPayload, supplierName: 'Restricted owner fixture', status: 'draft', internalReview: {} }, 'restricted-owner-fixture', { id: 'supplier-id', roles: ['supplier'] });
    restrictedDraft = await system.repository.seedHistoricalReview(restrictedDraft.id, { docs: { greenProcurement: true } });
    const restricted = await openContext('supplier'), restrictedPage = await restricted.newPage();
    await restrictedPage.goto(`${origin}/create?draft=${restrictedDraft.id}`);
    await restrictedPage.locator('#manufacturerName').fill('Owner correction without requirement grant');
    await saveDraft(restrictedPage);
    await restrictedPage.locator('[data-stage="documents"]').click();
    const restrictedCard = restrictedPage.locator('[data-requirement="greenProcurement"]');
    await expect(restrictedCard.getByRole('checkbox')).toBeChecked();
    await expect(restrictedCard.getByRole('checkbox')).toBeDisabled();
    await expect(restrictedCard.locator('input[type=file]')).toBeEnabled();
    await restrictedCard.locator('input[type=file]').setInputFiles({ name: 'owner-clean-report.txt', mimeType: 'text/plain', buffer: Buffer.from('Restricted owner attachment') });
    await expect(restrictedCard.locator('.create-document-status')).toContainText('Ready');
    assert.equal((await system.repository.findById(restrictedDraft.id)).internalReview.docs.greenProcurement, true);
    await restricted.close();
    checked('An owner without requirement-edit permission retains department-required flags after autosave and can upload the required clean file');

    const race = await openContext(), racePage = await race.newPage();
    await racePage.goto(`${origin}/create`); await racePage.locator('#startResume').click();
    let enterDraft;
    const draftEntered = new Promise(resolve => { enterDraft = resolve; });
    let releaseDraft;
    const draftGate = new Promise(resolve => { releaseDraft = resolve; }); releases.push(releaseDraft);
    const heldDraft = async route => { enterDraft(); await draftGate; return route.continue(); };
    await race.route(`${origin}/api/pcn-drafts/${normal.id}`, heldDraft);
    await racePage.locator(`[data-draft="${normal.id}"]`).click(); await draftEntered;
    await racePage.locator('#startBlank').click();
    await racePage.locator('#supplierName').fill('Newer entry choice kept');
    const releasedDraft = racePage.waitForResponse(`${origin}/api/pcn-drafts/${normal.id}`);
    releaseDraft(); await releasedDraft;
    await expect(racePage.locator('#supplierName')).toHaveValue('Newer entry choice kept');
    await saveDraft(racePage); await race.close();
    checked('A delayed earlier resume response cannot replace a newer blank document and its edits');

    const delayed = await openContext(), delayedPage = await delayed.newPage();
    let enterCreate, releaseCreate, heldKey;
    const createEntered = new Promise(resolve => { enterCreate = resolve; });
    const createGate = new Promise(resolve => { releaseCreate = resolve; }); releases.push(releaseCreate);
    let holdCreate = true;
    await delayed.route(`${origin}/api/pcn-drafts`, async route => {
      if (route.request().method() === 'POST' && holdCreate) { holdCreate = false; heldKey = route.request().postDataJSON().clientDraftKey; enterCreate(); await createGate; }
      return route.continue();
    });
    await delayedPage.goto(`${origin}/create`); await delayedPage.locator('#startBlank').click();
    await delayedPage.locator('#supplierName').fill('Delayed normal draft'); await createEntered;
    await delayedPage.locator('#fillTestDocument').click(); await delayedPage.locator('#confirmAccept').click();
    const freshTest = await saveDraft(delayedPage);
    assert.equal(freshTest.isTestDocument, true); assert.notEqual(freshTest.creationDraftKey, heldKey);
    const oldReply = delayedPage.waitForResponse(response => response.url() === `${origin}/api/pcn-drafts` && response.request().postDataJSON()?.clientDraftKey === heldKey);
    releaseCreate(); const priorNormal = (await (await oldReply).json()).data.record;
    assert.notEqual(priorNormal.id, freshTest.id); assert.notEqual(priorNormal.isTestDocument, true);
    await expect(delayedPage.locator('#draftIdentity')).toHaveText(freshTest.id);
    await expect(delayedPage.locator('#testDocumentBadge')).toBeVisible();
    await expect(delayedPage.locator('#supplierName')).toHaveValue(/TEST/i);
    await delayed.close();
    checked('Replacing a held initial normal save with Test document uses a fresh UUID and ignores the late normal reply');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
    if (page) await page.screenshot({ path: path.resolve(`test-results/create-pcn${artifactSuffix}-failure.png`), fullPage: true }).catch(() => {});
  } finally {
    releases.forEach(release => release());
    if (system) report.outbox = system.jobs.map(job => ({ to: job.payload.to, subject: job.payload.subject }));
    if (context) await context.tracing.stop({ path: path.resolve(`test-results/create-pcn${artifactSuffix}-trace.zip`) });
    for (const candidate of contexts) await candidate.close();
    if (browser) await browser.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await fs.writeFile(path.resolve(`test-results/create-pcn${artifactSuffix}-acceptance.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
