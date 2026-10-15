// Synthetic loopback PCNs only. Real API and routing logic; outbox writes are captured in memory.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: baseExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { NotificationService } = require('../src/notificationService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');
const expect = baseExpect.configure({ timeout: 10000 });
const actions = ['prepared', 'checked', 'approved'];
const stages = ['signoff.gscTet', 'signoff.prodEngTet', 'signoff.qaTet', 'tapbu.gsc', 'tapbu.qa', 'qateFinal.signoff'];
const report = { storage: 'isolated_memory_only', checks: [], errors: [], external: [], outbox: [] };

async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const users = actions.map(action => ({ username: `order-${action}`, displayName: `Order ${action}`, roles: ['gsc'],
    department: 'gscTet', signingStep: action }));
  const settings = { schemaVersion: 2, groups: [...actions.map(action => ({ key: `department.gscTet.${action}`, emails: `${action}@example.test` })),
    { key: 'department.prodEngTet.prepared', emails: 'engineering-prepared@example.test' }] };
  const jobs = [];
  const tx = { request() {
    const values = {};
    return { input(key, type, value) { values[key] = value; return this; }, async query(statement) {
      if (statement.includes('sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
      if (statement.includes('SELECT SettingsJson')) return { recordset: [{ SettingsJson: JSON.stringify(settings) }] };
      if (statement.includes('FROM pcn.Users')) return { recordset: [] };
      if (statement.includes('INSERT pcn.NotificationJobs')) {
        jobs.push(JSON.parse(values.payload)); return { recordset: [{ Id: `job-${jobs.length}`, Status: 'pending' }] };
      }
      if (statement.includes('UPDATE pcn.NotificationJobs')) return { recordset: [] };
      throw new Error('Unexpected isolated routing query');
    } };
  } };
  const notifications = new NotificationService(null, { repository, publicOrigin: 'http://127.0.0.1', mailUrl: 'https://power-automate.example.test/capture-only' });
  const originalUpdate = repository.update.bind(repository);
  repository.update = async (id, updater, actor, version) => {
    let plan;
    const saved = await originalUpdate(id, async current => {
      const proposed = await updater(current);
      const prepared = await notifications.prepare(tx, current, proposed);
      plan = prepared.plan;
      return prepared.record;
    }, actor, version);
    await notifications.persisted(tx, saved, plan);
    return saved;
  };
  const service = new PcnService(repository);
  const admin = { id: 'admin-id', displayName: 'Order Administrator', roles: ['admin'] };
  let record = await service.create({ ...unsignedPayload, status: 'draft', internalReview: {} }, admin.displayName, admin);
  const historical = await service.create({ ...unsignedPayload, status: 'draft', internalReview: {} }, admin.displayName, admin);
  const legacyReview = { signoff: { gscTet: { approved: true, approvedName: 'Legacy Approver', approvedDate: '2026-01-01' } } };
  await repository.seedHistoricalReview(historical.id, legacyReview);
  const authService = fakeAuthService({ additionalUsers: users });
  const server = http.createServer();
  let browser, context, page;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, service, authService, rootDir: path.resolve(__dirname, '..'), publicOrigin: origin,
      secureCookies: false, documents: { async list() { return []; } } }));
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true });
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
      return route.continue();
    });
    const login = async username => {
      const result = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: TEST_PASSWORD } });
      assert.equal(result.status(), 200); return (await result.json()).data.csrfToken;
    };
    let csrf = await login('admin');
    page = await context.newPage();
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', error => report.errors.push(error.message));
    const load = async () => { await page.goto(`${origin}/form.html?id=${record.id}`); await expect(page.locator('#submitButton')).toBeEnabled(); };
    await load();
    const assertPhysicalOrder = async () => {
      for (const stage of stages) {
        const controls = page.locator(`input.internal-check[data-internal-field^="${stage}."]`);
        assert.deepEqual(await controls.evaluateAll(nodes => nodes.map(node => node.dataset.internalField.split('.').at(-1))), actions, `${stage} physical order`);
        const checks = await controls.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { action: node.dataset.internalField.split('.').at(-1), x: r.x }; }));
        assert(checks[0].x < checks[1].x && checks[1].x < checks[2].x, `${stage} left-to-right order`);
      }
      assert.deepEqual(await page.locator('.pcn-header-signatures input.internal-check').evaluateAll(nodes => nodes.map(node => node.dataset.internalField.split('.')[1])), actions);
    };
    await assertPhysicalOrder();
    report.checks.push('All six department groups and supplier columns display Prepared, Checked, Approved in physical left-to-right order');
    await page.screenshot({ path: path.resolve('test-results/signing-order-desktop.png'), fullPage: true });
    await page.emulateMedia({ media: 'print' }); await assertPhysicalOrder();
    await page.pdf({ path: path.resolve('test-results/signing-order-print.pdf'), printBackground: true, preferCSSPageSize: true });
    await page.emulateMedia({ media: 'screen' });
    await page.setViewportSize({ width: 390, height: 844 }); await assertPhysicalOrder();
    await page.screenshot({ path: path.resolve('test-results/signing-order-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    report.checks.push('Printed PDF and 390px layout preserve action order');

    const patch = async (body, expected = 200) => {
      const response = await context.request.patch(`${origin}/api/pcns/${record.id}`, { headers: { origin, 'x-csrf-token': csrf }, data: { version: record.version, ...body } });
      assert.equal(response.status(), expected, `API step write expected ${expected}`);
      if (response.ok()) record = (await response.json()).data;
      return response;
    };
    const firstRecord = record;
    const saveReturned = async (draft = false, expected = 200) => {
      const saving = page.waitForResponse(response => response.url().endsWith(`/api/pcns/${record.id}`) && response.request().method() === 'PATCH');
      await page.locator(draft ? '#saveDraftButton' : '#submitButton').click();
      const response = await saving;
      assert.equal(response.status(), expected, 'Returned PCN save response');
      if (response.ok()) record = (await response.json()).data;
      await expect(page.locator('#pcnSaveOverlay')).toBeHidden();
      return response;
    };
    record = await service.create({ ...unsignedPayload, status: 'draft', internalReview: {} }, admin.displayName, admin);
    record = await repository.update(record.id, current => ({ ...current, status: 'supplier_action' }), 'returned-fixture', record.version);
    csrf = await login('order-prepared'); await load();
    const beforeReturnedJobs = jobs.length;
    await page.locator('[data-internal-field="signoff.gscTet.prepared"]').check();
    await saveReturned(true);
    assert.equal(record.status, 'supplier_action', 'Save draft preserves returned status');
    assert.equal(record.internalReview.signoff.gscTet.prepared, true);
    assert.equal(record.internalReview.signoff.gscTet.preparedName, 'Order prepared');
    const retainedIdentity = { name: record.internalReview.signoff.gscTet.preparedName, date: record.internalReview.signoff.gscTet.preparedDate };
    assert.equal(jobs.length, beforeReturnedJobs, 'Save draft queues no action-required handoff');
    await saveReturned();
    assert.equal(record.status, 'submitted', 'Normal save resubmits a returned supplier-action PCN');
    assert.equal(jobs.length, beforeReturnedJobs + 1, 'Resubmission queues exactly one handoff');
    assert.equal(jobs.at(-1).to, 'checked@example.test');
    assert.match(jobs.at(-1).subject, /GSC\/TET Checked/);
    assert.deepEqual({ name: record.internalReview.signoff.gscTet.preparedName, date: record.internalReview.signoff.gscTet.preparedDate }, retainedIdentity);
    const returnedAction = await context.request.get(`${origin}/api/pcns/${record.id}/action`);
    assert.equal(returnedAction.status(), 200);
    assert.equal((await returnedAction.json()).data.signingStep, 'checked');
    await saveReturned();
    assert.equal(jobs.length, beforeReturnedJobs + 1, 'An unchanged extra save never repeats the handoff');
    report.checks.push('Returned PCN Save draft retains Supplier Action without action mail; normal save resubmits and queues Checked once, preserving Prepared identity');
    record = await service.create({ ...unsignedPayload, reason: '', currentCondition: '', newCondition: '', desiredStart: '', sampleSubmitted: 'pending',
      changeRows: unsignedPayload.changeRows.map(row => ({ ...row, currentCondition: '', newCondition: '' })),
      status: 'draft', internalReview: {} }, admin.displayName, admin);
    record = await repository.update(record.id, current => ({ ...current, status: 'supplier_action' }), 'incomplete-returned-fixture', record.version);
    await load();
    const incompleteBefore = await repository.findById(record.id), incompleteJobs = jobs.length;
    const documentTopBeforeMissing = await page.locator('main.workspace').evaluate(node => node.getBoundingClientRect().top + scrollY);
    const incompleteResponse = await saveReturned(false, 400);
    const incompleteError = await incompleteResponse.json();
    const missingLabels = ['Reason for change', 'Current condition', 'New condition', 'Target start date or lot', 'Sample submission choice'];
    assert.deepEqual(incompleteError.details.missing.map(item => item.label), missingLabels);
    assert.equal(incompleteError.error, `Complete required document information before advancing the PCN. Still missing: ${missingLabels.join('; ')}.`);
    const allLabels = ['Supplier name', 'Material / chemical name', 'Change description', ...missingLabels, 'Sample submission date'];
    assert.deepEqual(allLabels.filter(label => incompleteError.error.includes(label)), missingLabels, 'Save error names exactly the missing information');
    const missingPopup = await page.locator('.app-feedback-area').evaluate(node => {
      const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
      return { position: style.position, rightGap: innerWidth - bounds.right, bottom: innerHeight - bounds.bottom, width: bounds.width };
    });
    assert.equal(missingPopup.position, 'fixed', 'Missing items stay in the notification popup');
    assert(missingPopup.rightGap >= 12 && missingPopup.rightGap <= 30, 'Notification popup uses the selected right margin');
    assert(missingPopup.bottom >= 90 && missingPopup.width <= 420, 'Notification popup stays above the action dock and remains compact');
    const documentTopAfterMissing = await page.locator('main.workspace').evaluate(node => node.getBoundingClientRect().top + scrollY);
    assert.equal(Math.round(documentTopAfterMissing), Math.round(documentTopBeforeMissing), 'Missing-item popup does not push the document layout');
    await expect(page.locator('#appNotice')).toBeVisible();
    await expect(page.locator('#appNotice')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#appNoticeTitle')).toHaveText('Complete 5 required items');
    await expect(page.locator('#appNoticeMessage')).toHaveText('Your edits are kept. Complete the items below, then save again.');
    const missingItems = page.locator('#appNoticeMissing li');
    await expect(missingItems).toHaveCount(missingLabels.length);
    for (const [index, label] of missingLabels.entries()) {
      await expect(missingItems.nth(index)).toContainText(label);
      await expect(missingItems.nth(index).getByRole('button', { name: /^Go to field:/ })).toBeEnabled();
    }
    await expect(page.locator('#appNoticeMissing')).not.toContainText('Supplier name');
    await page.locator('#appNotice').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#appNotice').evaluate(node => node.scrollHeight <= node.clientHeight), true, 'Desktop checklist shows every required item without internal scrolling');
    await page.locator('#appNotice').screenshot({ path: path.resolve('test-results/missing-save-fields-desktop.png') });
    await page.screenshot({ path: path.resolve('test-results/missing-save-popup-desktop.png') });
    await page.screenshot({ path: path.resolve('test-results/missing-save-popup-full-page.png'), fullPage: true });
    await missingItems.nth(0).getByRole('button', { name: /^Go to field:/ }).click();
    await expect(page.locator('#reason')).toBeFocused();
    await missingItems.nth(1).getByRole('button', { name: /^Go to field:/ }).click();
    const missingConditionRow = page.locator('.option-row').filter({ has: page.locator('input[name=changeOption]:checked') });
    await expect(missingConditionRow.getByLabel(/Current condition/)).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#appNotice').scrollIntoViewIfNeeded();
    await expect(missingItems).toHaveCount(missingLabels.length);
    await expect(page.locator('#appNoticeMessage')).toHaveText('Your edits are kept. Complete the items below, then save again.');
    assert.equal(await page.locator('#appNotice').evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
        && node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight
        && [...node.querySelectorAll('#appNoticeMissing li')].every(item => {
          const row = item.getBoundingClientRect();
          return row.left >= bounds.left && row.right <= bounds.right && row.top >= bounds.top && row.bottom <= bounds.bottom;
        });
    }), true, 'All five missing-field rows fit mobile viewport without truncation or internal scrolling');
    await page.locator('#appNotice').screenshot({ path: path.resolve('test-results/missing-save-fields-mobile.png') });
    await page.screenshot({ path: path.resolve('test-results/missing-save-popup-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.deepEqual(await repository.findById(record.id), incompleteBefore, 'Incomplete returned PCN cannot resubmit');
    assert.equal(jobs.length, incompleteJobs, 'Rejected incomplete resubmission queues no action mail');
    report.checks.push('Incomplete returned save shows five required items with field-focus buttons and concise alert copy on mobile, leaving completed fields, record and handoff unchanged');
    record = firstRecord; csrf = await login('admin'); await load();
    await patch({ status: 'submitted' });
    assert.equal(jobs.at(-1).to, 'prepared@example.test');
    assert.match(jobs.at(-1).subject, /GSC\/TET Prepared/);
    const assertNextAction = async (department, action) => {
      const response = await context.request.get(`${origin}/api/pcns/${record.id}/action`);
      assert.equal(response.status(), 200);
      const next = (await response.json()).data;
      assert.equal(next.department, department); assert.equal(next.signingStep, action);
      assert.match(next.label, new RegExp(action[0].toUpperCase() + action.slice(1)));
      if (department === 'gscTet') assert.deepEqual(next.people.map(person => person.displayName), [`Order ${action}`]);
    };
    await assertNextAction('gscTet', 'prepared');
    for (const later of ['checked', 'approved']) {
      csrf = await login(`order-${later}`); await load();
      await expect(page.locator(`[data-internal-field="signoff.gscTet.${later}"]`)).toBeDisabled();
      const before = await repository.findById(record.id), jobCount = jobs.length;
      await patch({ internalReview: { signoff: { gscTet: { [later]: true } } } }, 400);
      assert.deepEqual(await repository.findById(record.id), before);
      assert.equal(jobs.length, jobCount, 'Rejected out-of-order step never queues mail');
    }
    report.checks.push('Assigned Checker and Approver cannot skip Prepared in UI or direct API; rejected writes never queue mail');
    for (const [index, action] of actions.entries()) {
      csrf = await login(`order-${action}`); await load();
      const current = page.locator(`[data-internal-field="signoff.gscTet.${action}"]`);
      await expect(current).toBeEnabled();
      for (const other of actions.filter(value => value !== action)) await expect(page.locator(`[data-internal-field="signoff.gscTet.${other}"]`)).toBeDisabled();
      const skipped = index < 2 ? 'approved' : 'prepared';
      const before = await repository.findById(record.id);
      await patch({ internalReview: { signoff: { gscTet: { [skipped]: before.internalReview.signoff?.gscTet?.[skipped] !== true } } } }, 403);
      assert.deepEqual(await repository.findById(record.id), before, 'Wrong signer cannot mutate a different action');
      await current.check();
      const saving = page.waitForResponse(response => response.url().endsWith(`/api/pcns/${record.id}`) && response.request().method() === 'PATCH');
      await page.locator('#submitButton').click();
      const response = await saving; assert.equal(response.status(), 200); record = (await response.json()).data;
      await expect(page.locator('#pcnSaveOverlay')).toBeHidden();
      assert.equal(record.internalReview.signoff.gscTet[`${action}Name`], `Order ${action}`);
      assert.match(record.internalReview.signoff.gscTet[`${action}Date`], /^\d{4}-\d{2}-\d{2}$/);
      const next = actions[index + 1];
      assert.equal(jobs.at(-1).to, next ? `${next}@example.test` : 'engineering-prepared@example.test');
      assert.match(jobs.at(-1).message, new RegExp(`GSC/TET ${action[0].toUpperCase()}${action.slice(1)}`));
      assert.match(jobs.at(-1).subject, new RegExp(next ? `GSC/TET ${next[0].toUpperCase()}${next.slice(1)}` : 'Prod.Eng/TET Prepared'));
      await assertNextAction(next ? 'gscTet' : 'prodEngTet', next || 'prepared');
    }
    report.checks.push('Three distinct GSC users sign only their assigned step; actual outbox plans hand off Prepared → Checked → Approved → next department Prepared with correct recipients');
    csrf = await login('admin');
    const beforeSkip = await repository.findById(record.id);
    await patch({ internalReview: { signoff: { prodEngTet: { approved: true } } } }, 400);
    assert.deepEqual(await repository.findById(record.id), beforeSkip);
    report.checks.push('Administrator cannot skip next department Prepared prerequisites');
    const history = (await repository.getRevisions(record.id)).toReversed();
    const signEvents = history.filter(entry => entry.changes.some(change => change.after === true && /^internalReview\.signoff\.gscTet\.(prepared|checked|approved)$/.test(change.path)));
    assert.equal(signEvents.length, 3);
    assert.deepEqual(signEvents.map(entry => entry.actor), actions.map(action => `user:order-${action}-id`));
    await load();
    for (const action of actions) {
      await expect(page.locator(`[data-internal-field="signoff.gscTet.${action}"]`).locator('..').locator('.signoff-handwritten-name')).toHaveText('Order');
      await expect(page.locator(`[data-internal-field="signoff.gscTet.${action}"]`).locator('..')).toHaveAttribute('data-signature-tooltip',
        `GSC/TET ${action[0].toUpperCase()}${action.slice(1)}\nSigned by: Order ${action}\nDate: ${record.internalReview.signoff.gscTet[`${action}Date`]}`);
    }
    await page.screenshot({ path: path.resolve('test-results/signing-order-signed-desktop.png'), fullPage: true });
    await page.emulateMedia({ media: 'print' }); await assertPhysicalOrder();
    await page.pdf({ path: path.resolve('test-results/signing-order-signed-print.pdf'), printBackground: true, preferCSSPageSize: true });
    await page.emulateMedia({ media: 'screen' }); await page.setViewportSize({ width: 390, height: 844 }); await assertPhysicalOrder();
    await page.screenshot({ path: path.resolve('test-results/signing-order-signed-mobile.png'), fullPage: true });
    const legacy = await repository.findById(historical.id);
    assert.deepEqual(legacy.internalReview.signoff, legacyReview.signoff);
    record = legacy; await load();
    await expect(page.locator('[data-internal-field="signoff.gscTet.approved"]')).toBeChecked();
    await expect(page.locator('[data-internal-field="signoff.gscTet.approved"]').locator('..').locator('.signoff-handwritten-name')).toContainText('Legacy');
    await expect(page.locator('[data-internal-field="signoff.gscTet.approved"]').locator('..')).toHaveAttribute('data-signature-tooltip',
      'GSC/TET Approved\nSigned by: Legacy Approver\nDate: 2026-01-01');
    report.checks.push('History records correct actor sequence; historical Approved flag, name and date stay attached to Approved');
    report.outbox = jobs.map(job => ({ to: job.to, subject: job.subject }));
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
    if (page) await page.screenshot({ path: path.resolve('test-results/signing-order-failure.png'), fullPage: true }).catch(() => {});
  } finally {
    if (context) { await context.tracing.stop({ path: path.resolve('test-results/signing-order-trace.zip') }); await context.close(); }
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.resolve('test-results/signing-order-acceptance.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
