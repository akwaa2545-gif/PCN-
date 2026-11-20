// Real loopback auth/API with isolated memory records. Never connects to SQL, mail or directory flows.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: browserExpect } = require('@playwright/test');
const expect = browserExpect.configure({ timeout: 10000 });
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');
const report = { storage: 'isolated_memory_only', checks: [], errors: [], external: [], forbidden: [] };
const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

async function reportArtifacts() {
  const failed = report.browser === 'failed';
  await fs.writeFile(path.resolve('test-results/records-dashboard-acceptance.json'), JSON.stringify(report, null, 2));
  const cases = report.checks.map(name => `<testcase classname="records-dashboard" name="${xml(name)}"/>`);
  if (failed) cases.push(`<testcase classname="records-dashboard" name="acceptance failure"><failure>${xml(report.failure)}</failure></testcase>`);
  await fs.writeFile(path.resolve('test-results/records-dashboard-junit.xml'),
    `<testsuite name="records-dashboard" tests="${cases.length}" failures="${Number(failed)}">${cases.join('')}</testsuite>`);
  await fs.writeFile(path.resolve('test-results/records-dashboard-report.html'),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Records dashboard browser acceptance</title><h1>${failed ? 'FAILED' : 'PASSED'}</h1><p>Isolated memory records; no live SQL, mail, directory or deployment.</p><ol>${report.checks.map(name => `<li>${xml(name)}</li>`).join('')}</ol>${failed ? `<pre>${xml(report.failure)}</pre>` : ''}</html>`);
}

class DashboardPage {
  constructor(page, host = '#recordsWorkspace') { this.page = page; this.host = page.locator(host); }
  async ready() { await expect(this.host).toBeVisible(); await expect(this.host.locator('[data-summary="all"]')).toBeVisible(); }
  lifecycle(name) { return this.host.locator(`#rdLifecycleTab-${name}`); }
  card(name) { return this.host.getByRole('button', { name: new RegExp(name, 'i') }); }
  rows() { return this.host.locator('tr[data-pcn-id]'); }
  row(id) { return this.host.locator(`tr[data-pcn-id="${id}"]`); }
  async reset() { await this.host.getByRole('button', { name: 'Reset filters', exact: true }).click(); }
  preview(id) { return this.host.getByRole('button', { name: `Quick view ${id}`, exact: true }); }
  async fits() { assert.equal(await this.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Page stays within viewport'); }
}

async function unchangedFor(duration, read, value) {
  const until = Date.now() + duration;
  do { assert.equal(read(), value, 'Open editor/modal suppresses background overview requests');
    await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(1, until - Date.now()))));
  } while (Date.now() < until);
  assert.equal(read(), value);
}

async function fixtures() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  let clock = new Date('2026-10-01T09:00:00Z');
  const service = new PcnService(repository, () => clock);
  const statuses = ['draft', 'submitted', 'gsc_review', 'approved', 'supplier_action', 'rejected', 'closed'];
  const records = [];
  for (let index = 0; index < 17; index += 1) {
    clock = new Date(`2026-10-${String(1 + index).padStart(2, '0')}T09:00:00Z`);
    const owner = { id: index % 2 ? 'supplier-id' : 'other-id', roles: ['supplier'] };
    const supplierName = index === 16 ? '=FORMULA("fixture")' : index % 2 ? 'Alpha supplier' : 'Beta supplier';
    let record = await repository.create({ ...service.normalizeInput({ ...unsignedPayload, documentType: undefined, status: 'draft', supplierName,
      materialName: `Dashboard material ${String(index + 1).padStart(2, '0')} ไทย` }),
      ownerUserId: owner.id, createdAt: clock.toISOString(), updatedAt: clock.toISOString() }, 'Historical Dashboard Fixture Creator', owner);
    record = await repository.update(record.id, current => ({ ...current, status: statuses[index % statuses.length],
      internalReview: { ...current.internalReview, docs: { hazardousReport: true },
        signoff: { ...current.internalReview.signoff, gscTet: { approved: index % 3 === 0,
          approvedName: index % 3 === 0 ? 'Dashboard GSC Approver' : '', approvedDate: index % 3 === 0 ? '2026-10-01' : '' } } } }),
    'Dashboard Fixture Status Editor', record.version);
    records.push(record);
  }
  repository.getStatusTimings = async ids => new Map(await Promise.all(ids.map(async id => {
    const row = await repository.findById(id);
    const history = (await repository.getRevisions(id)).toSorted((a, b) => a.revision - b.revision);
    const transition = history.find(event => event.status === row.status);
    return [id, { parentVersion: row.version, status: row.status, since: transition?.createdAt }];
  })));
  const files = row => row.id === records[0].id ? [{ id: 'fixture-clean', fileName: 'Hazardous fixture.pdf',
    contentType: 'application/pdf', sizeBytes: 1234, requirementName: 'hazardousReport', scanStatus: 'clean',
    createdAt: row.createdAt }] : row.id === records[1].id ? [{ id: 'fixture-quarantine', fileName: 'Quarantine fixture.pdf',
    requirementName: 'hazardousReport', scanStatus: 'quarantined', createdAt: row.createdAt }] : [];
  const documents = { async list(id) { return files(await repository.findById(id)); },
    async listForRecords(ids) { return new Map(await Promise.all(ids.map(async id => {
      const row = await repository.findById(id); return [id, { parentVersion: row.version, attachments: files(row) }];
    }))); } };
  const authService = fakeAuthService({ additionalUsers: [
    { username: 'viewer', employeeCode: '0800001', identityProvider: 'employee-code', roles: [], displayName: 'Dashboard Viewer' },
    { username: 'viewer-two', employeeCode: '0800002', identityProvider: 'employee-code', roles: [], displayName: 'Dashboard Viewer Two' },
    { username: 'gsc-assigned', roles: ['gsc'], department: 'gscTet', signingStep: 'prepared', displayName: 'Dashboard Assigned Preparer' },
    { username: 'gsc-checker', roles: ['gsc'], department: 'gscTet', signingStep: 'checked', displayName: 'Dashboard Assigned Checker' }
  ] });
  return { repository, service, records, documents, authService };
}

async function reviewDeadlineJourney(browser) {
  for (const username of ['admin', 'viewer']) {
    const repository = memoryRepository();
    repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
    const startedAt = '2026-10-23T09:45:00.000Z'; // Friday handoff includes the weekend.
    repository.getStatusTimings = async ids => new Map(await Promise.all(ids.map(async id => {
      const row = await repository.findById(id);
      const history = (await repository.getRevisions(id)).toSorted((a, b) => a.revision - b.revision);
      const transition = history.findLast((event, index) => event.status === row.status && !event.isBaseline
        && (index === 0 || history[index - 1].status !== event.status));
      return [id, { parentVersion: row.version, status: row.status, since: transition?.createdAt }];
    })));
    const dueAt = '2026-10-26T09:45:00.000Z';
    let clock = new Date(startedAt);
    const service = new PcnService(repository, () => clock);
    const complete = { prepared: true, checked: true, approved: true };
    const seeded = await repository.create({ ...service.normalizeInput({ ...unsignedPayload, documentType: undefined, status: 'gsc_review',
      materialName: 'Three calendar day department fixture', internalReview: { tapbu: { noNeed: true }, signoff: { gscTet: { prepared: true, checked: true } } } }),
    createdAt: startedAt, updatedAt: startedAt }, 'Deadline fixture');
    let record = await service.update(seeded.id, { version: seeded.version, internalReview: { signoff: { gscTet: complete } } });
    assert.equal(record.reviewTiming.prodEngTet.startedAt, startedAt, 'Actual service handoff starts the clock');
    clock = new Date(dueAt);
    const authService = fakeAuthService({ additionalUsers: [
      { username: 'viewer', employeeCode: '0800001', identityProvider: 'employee-code', roles: [], displayName: 'Deadline Viewer' }
    ] });
    const server = http.createServer();
    let context;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const origin = `http://127.0.0.1:${server.address().port}`;
      server.on('request', createRequestHandler({ repository, service, authService, clock: () => clock,
        rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      await context.tracing.start({ screenshots: true, snapshots: true });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
        if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
        if (url.pathname === '/api/admin/notifications/health') return route.fulfill({ json: { success: true, data: { configuration: { status: 'not_configured' }, worker: { status: 'disabled' }, queue: {} } } });
        if (/\/notifications(?:\/|$)/.test(url.pathname) || ['/api/admin/directory-users', '/api/admin/employees'].includes(url.pathname)
          || !['GET', 'HEAD'].includes(request.method())) { report.forbidden.push({ method: request.method(), path: url.pathname }); return route.abort(); }
        return route.continue();
      });
      const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: TEST_PASSWORD } });
      assert.equal(login.status(), 200);
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto(`${origin}/${username === 'admin' ? 'admin' : 'records'}`);
      if (username === 'admin') await page.locator('#adminRecordsButton').click();
      const dashboard = new DashboardPage(page, username === 'admin' ? '#pcnAdminView' : '#recordsWorkspace');
      await dashboard.ready(); await expect(dashboard.rows()).toHaveCount(1);
      const row = dashboard.row(record.id), pending = row.locator('[data-column="pending"]');
      const banner = dashboard.host.locator('.rd-overdue-alert[role="status"]');
      for (const { department, label, artifact } of [
        { department: 'prodEngTet', label: 'Prod.Eng/TET', artifact: 'prodeng' },
        { department: 'qaTet', label: 'QA/TET', artifact: 'qa' }
      ]) {
        const handoff = record.reviewTiming[department].startedAt;
        const dueAt = new Date(Date.parse(handoff) + 3 * 86400000).toISOString();
        clock = new Date(dueAt);
        const boundary = await page.waitForResponse(response => new URL(response.url()).pathname === '/api/pcns/overview' && response.status() === 200);
        const boundaryPending = (await boundary.json()).data.items.find(item => item.id === record.id).dashboard.pending;
        assert.equal(boundaryPending.activeReviewDeadline.dueAt, dueAt);
        assert.equal(boundaryPending.activeReviewDeadline.overdue, false, 'The live API remains on time at exactly 72 hours');
        assert.equal(boundaryPending[department === 'qaTet' ? 'qaDeadline' : 'prodEngDeadline'].department, department);
        const dueLabel = `${label} due ${await page.evaluate(value => new Date(value).toLocaleString(), dueAt)}`;
        const before = await repository.list();
        await expect(pending).toHaveText(`${boundaryPending.ageDays} days`);
        await expect(banner).toBeHidden(); await expect(row.locator('.rd-deadline-overdue')).toHaveCount(0);
        await expect(row).not.toHaveClass(/rd-row-overdue/);
        await expect(pending).not.toHaveClass(/rd-overdue/);
        clock = new Date(Date.parse(dueAt) + 1);
        await expect(banner).toBeVisible(); // Waits for real 5-second overview polling, without manual refresh.
        await expect(banner).toContainText(`1 PCN overdue for ${label}`);
        await expect(row.locator('.rd-deadline-overdue')).toHaveText(`${label} overdue`);
        await expect(row).toHaveClass(/rd-row-overdue/);
        await expect(pending).toHaveText('Overdue <1 day'); await expect(pending).toHaveClass(/rd-overdue/);
        clock = new Date(Date.parse(dueAt) + 3 * 86400000);
        await expect(pending).toHaveText('Overdue 3 days');
        assert.deepEqual(await repository.list(), before, 'Reading and crossing the deadline never writes a PCN');
        const red = await pending.evaluate(node => getComputedStyle(node).color);
        assert.equal(red, 'rgb(142, 38, 36)', 'Overdue row text uses the readable dark red alert color');
        assert.equal(await banner.evaluate(node => getComputedStyle(node).color), 'rgb(142, 38, 36)');
        await dashboard.fits();
        if (username === 'viewer') { await page.setViewportSize({ width: 390, height: 844 }); await dashboard.fits(); }
        const assertRedRow = async () => {
          const surfaces = await row.evaluate(node => ({
            expected: node.matches(':hover, :focus-visible, .is-selected') ? 'rgb(255, 227, 225)' : 'rgb(255, 240, 239)',
            cells: Array.from(node.children, cell => getComputedStyle(cell).backgroundColor)
          }));
          assert.ok(surfaces.cells.length > 1);
          assert.ok(surfaces.cells.every(color => color === surfaces.expected), 'Every overdue cell, including sticky code and actions, uses the red surface');
        };
        await assertRedRow();
        await row.locator('[data-column="id"]').hover();
        await assertRedRow();
        await page.screenshot({ path: path.resolve(`test-results/${artifact}-deadline-${username === 'admin' ? 'portal' : 'records-mobile'}.png`), fullPage: true });
        if (username === 'admin') {
          await row.getByRole('button', { name: `History ${record.id}`, exact: true }).click();
          const dialog = page.locator('#pcnTimelineDialog'); await expect(dialog).toBeVisible();
          await expect(dialog.locator(`[data-workflow-stage="signoff.${department}"]`)).toContainText(`${dueLabel} (overdue)`);
          await expect(page.locator('#pcnTimelineDetails .rd-overdue')).toHaveText(`${dueLabel} (overdue)`);
          assert.equal(await page.locator('#pcnTimelineDetails .rd-overdue').evaluate(node => getComputedStyle(node).color), 'rgb(169, 47, 43)', 'Portal timeline due date is red');
          await page.locator('#pcnTimelineCloseButton').click();
        } else {
          await dashboard.preview(record.id).click();
          const dialog = page.locator('#rdPreviewDialog'); await expect(dialog).toBeVisible();
          await dialog.getByRole('tab', { name: 'Timeline', exact: true }).click();
          await expect(dialog.locator(`[data-workflow-stage="signoff.${department}"] .rd-overdue`)).toHaveText(`${dueLabel} (overdue)`);
          await expect(dialog.locator('#rdWorkflowDetails .rd-overdue')).toHaveText(`${dueLabel} (overdue)`);
          assert.equal(await dialog.locator('#rdWorkflowDetails .rd-overdue').evaluate(node => getComputedStyle(node).color), 'rgb(169, 47, 43)', 'Records timeline due date is red');
          assert.equal(await dialog.evaluate(node => { const bounds = node.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth && node.scrollWidth <= node.clientWidth; }), true, 'Mobile deadline timeline stays in the viewport');
          await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
        }
        const finished = await service.update(record.id, { version: record.version, internalReview: { signoff: { [department]: complete } } });
        const after = await repository.list();
        assert.equal(finished.reviewTiming?.[department], undefined);
        await expect(banner).toBeHidden(); await expect(row.locator('.rd-deadline-overdue')).toHaveCount(0);
        await expect(row).not.toHaveClass(/rd-row-overdue/);
        await expect(pending).not.toHaveClass(/rd-overdue/); await expect(pending).not.toContainText('Overdue');
        if (department === 'prodEngTet') {
          assert.equal(finished.reviewTiming.qaTet.startedAt, clock.toISOString(), 'Final Prod.Eng signature starts a fresh QA review clock');
          await expect(pending).toHaveText(/^(?:\d+ days?|<1 day)$/);
        } else {
          assert.equal(finished.reviewTiming.qaTet, undefined, 'QA completion clears its review clock');
          assert.equal(finished.reviewTiming.qaFinal.startedAt, clock.toISOString(), 'Final Judgment records a start even while its limit is disabled');
          const completionOverview = await context.request.get(`${origin}/api/pcns/overview`);
          assert.equal(completionOverview.status(), 200);
          const finalStage = (await completionOverview.json()).data.items.find(item => item.id === record.id).dashboard;
          assert.equal(finalStage.action.stage, 'qateFinal.signoff', 'QA completion advances to the final-judgment signing stage');
          assert.equal(finalStage.pending.activeReviewDeadline, null, 'Final judgment has no department review deadline');
        }
        assert.deepEqual(await repository.list(), after, 'Refresh after controlled fixture completion has no browser writes');
        report.checks.push(`${username === 'admin' ? 'Portal admin' : 'Roleless Records viewer'} ${label}: real handoff, current-status age, exactly 72h on time, +1ms then 3 days overdue from server time, red row/timeline, completion clears on polling`);
        record = finished;
      }
      if (username === 'admin') {
        await row.getByRole('button', { name: `History ${record.id}`, exact: true }).click();
        await expect(page.locator('#pcnTimelineDetails')).toContainText(/Final [Jj]udgment/);
        await expect(page.locator('#pcnTimelineDialog .rd-overdue')).toHaveCount(0);
        await page.locator('#pcnTimelineCloseButton').click();
      } else {
        await dashboard.preview(record.id).click();
        const dialog = page.locator('#rdPreviewDialog');
        await dialog.getByRole('tab', { name: 'Timeline', exact: true }).click();
        await expect(dialog.locator('#rdWorkflowDetails')).toContainText(/Final [Jj]udgment/);
        await expect(dialog.locator('.rd-overdue')).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
      }
    } catch (error) {
      const failedPage = context?.pages()[0];
      if (failedPage && !failedPage.isClosed()) await failedPage.screenshot({ path: path.resolve(`test-results/prodeng-deadline-${username}-failure.png`), fullPage: true }).catch(() => {});
      throw error;
    } finally {
      if (context) { await context.tracing.stop({ path: path.resolve(`test-results/prodeng-deadline-${username}-trace.zip`) }); await context.close(); }
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  }
}

async function lifecycleJourney(open, repository, records) {
  for (const username of ['viewer', 'admin']) {
    const session = await open(username);
    const { page, origin } = session;
    const dashboard = new DashboardPage(page, username === 'admin' ? '#pcnAdminView' : '#recordsWorkspace');
    const search = page.locator(username === 'admin' ? '#adminSearchInput' : '#recordsSearch');
    const statusFilter = dashboard.host.getByRole('combobox', { name: 'Status', exact: true });
    const riskFilter = dashboard.host.getByRole('combobox', { name: 'Risk', exact: true });
    await dashboard.ready();
    await expect(dashboard.lifecycle('open')).toHaveAttribute('aria-selected', 'true');
    await expect(dashboard.lifecycle('open').locator('strong')).toHaveText('11');
    await expect(dashboard.lifecycle('closed').locator('strong')).toHaveText('6');
    await expect(dashboard.rows()).toHaveCount(11);
    for (const record of records.filter(record => ['approved', 'rejected', 'closed'].includes(record.status))) {
      await expect(dashboard.row(record.id)).toHaveCount(0);
    }
    await dashboard.lifecycle('open').focus(); await page.keyboard.press('ArrowRight');
    await expect(dashboard.lifecycle('closed')).toBeFocused();
    await expect(dashboard.lifecycle('closed')).toHaveAttribute('aria-selected', 'true');
    await expect(dashboard.host.locator('#rdRecordsPanel')).toHaveAttribute('aria-labelledby', 'rdLifecycleTab-closed');
    await expect(dashboard.rows()).toHaveCount(6);
    for (const status of ['approved', 'rejected', 'closed']) {
      await expect(dashboard.host.locator(`[data-summary="${status}"] strong`)).toHaveText('2');
      await dashboard.host.locator(`[data-summary="${status}"]`).click();
      await expect(dashboard.rows()).toHaveCount(2);
      for (const record of records.filter(record => record.status === status)) {
        await expect(dashboard.row(record.id).locator('[data-column="status"]')).toHaveText(new RegExp(status, 'i'));
      }
    }
    await dashboard.reset();
    await page.emulateMedia({ media: 'print' });
    await expect(dashboard.rows()).toHaveCount(6);
    for (const record of records.filter(record => ['approved', 'rejected', 'closed'].includes(record.status))) {
      await expect(dashboard.row(record.id)).toBeVisible();
    }
    await expect(dashboard.row(records[0].id)).toHaveCount(0);
    await page.emulateMedia({ media: 'screen' });
    const downloadWait = page.waitForEvent('download');
    await dashboard.host.getByRole('button', { name: 'Export filtered CSV', exact: true }).click();
    const csv = await fs.readFile(await (await downloadWait).path(), 'utf8');
    assert.equal((csv.match(/PCN-2026-\d{4}/g) || []).length, 6, 'Closed export contains all completed documents');
    assert(!csv.includes(records[0].id), 'Closed export excludes open documents');
    await search.fill('Dashboard material 04');
    await expect(dashboard.rows()).toHaveCount(1);
    await expect(dashboard.row(records[3].id)).toBeVisible();
    await dashboard.reset();
    await page.locator('#rdViewEditor summary').click(); await page.locator('#rdViewName').fill('Completed documents fixture');
    await dashboard.host.getByRole('button', { name: 'Save current view', exact: true }).click();
    await dashboard.lifecycle('closed').focus(); await page.keyboard.press('Home');
    await expect(dashboard.lifecycle('open')).toBeFocused();
    await statusFilter.selectOption('gsc_review');
    await page.locator('#rdFilter-department').selectOption('GSC/TET');
    await search.fill('Dashboard material');
    await riskFilter.selectOption('RL2');
    await page.locator('#rdFilter-supplier').selectOption('Beta supplier');
    await page.locator('#rdFilter-from').fill('2026-10-01'); await page.locator('#rdFilter-to').fill('2026-10-17');
    await dashboard.lifecycle('open').focus(); await page.keyboard.press('End');
    await expect(dashboard.lifecycle('closed')).toBeFocused();
    await expect(statusFilter).toHaveValue(''); await expect(page.locator('#rdFilter-department')).toHaveValue('');
    await expect(search).toHaveValue('Dashboard material');
    await expect(riskFilter).toHaveValue('RL2'); await expect(page.locator('#rdFilter-supplier')).toHaveValue('Beta supplier');
    await expect(page.locator('#rdFilter-from')).toHaveValue('2026-10-01'); await expect(page.locator('#rdFilter-to')).toHaveValue('2026-10-17');
    await dashboard.reset();
    await dashboard.lifecycle('closed').focus(); await page.keyboard.press('ArrowLeft');
    await expect(dashboard.lifecycle('open')).toBeFocused();
    await page.locator('#rdFilter-saved').selectOption('Completed documents fixture');
    await expect(dashboard.lifecycle('closed')).toHaveAttribute('aria-selected', 'true'); await expect(dashboard.rows()).toHaveCount(6);
    await dashboard.host.getByRole('button', { name: 'Delete selected view', exact: true }).click();
    const pathname = username === 'admin' ? 'admin' : 'records';
    await page.goto(`${origin}/${pathname}?documents=closed`); await dashboard.ready();
    await expect(dashboard.lifecycle('closed')).toHaveAttribute('aria-selected', 'true'); await expect(dashboard.rows()).toHaveCount(6);
    await page.goto(`${origin}/${pathname}`); await dashboard.ready();
    await expect(dashboard.lifecycle('open')).toHaveAttribute('aria-selected', 'true');
    const original = await repository.findById(records[15].id);
    const completed = await repository.update(original.id, row => ({ ...row, status: 'closed', updatedAt: new Date().toISOString() }), 'Controlled closure polling fixture', original.version);
    await expect(dashboard.row(original.id)).toHaveCount(0);
    await expect(dashboard.lifecycle('open').locator('strong')).toHaveText('10'); await expect(dashboard.lifecycle('closed').locator('strong')).toHaveText('7');
    await dashboard.lifecycle('closed').click(); await expect(dashboard.row(original.id)).toBeVisible();
    await expect(dashboard.row(original.id).locator('[data-column="status"]')).toHaveText('Closed');
    await page.screenshot({ path: path.resolve(`test-results/records-closed-${username}.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await dashboard.fits();
    await expect(dashboard.lifecycle('closed')).toBeVisible();
    await page.screenshot({ path: path.resolve(`test-results/records-closed-${username}-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await repository.update(original.id, row => ({ ...row, status: original.status, updatedAt: original.updatedAt }), 'Restore isolated lifecycle fixture', completed.version);
    await expect(dashboard.lifecycle('closed').locator('strong')).toHaveText('6');
    report.checks.push(`${username === 'admin' ? 'Portal' : 'Roleless Records'} Open/Closed tabs: terminal grouping, original statuses, scoped search/export/print, keyboard navigation, filter preservation, saved views, deep link, closure polling and mobile layout`);
  }
}

async function main() {
  const fixture = await fixtures();
  const { repository, records } = fixture;
  let before = await repository.list();
  const server = http.createServer(), contexts = [];
  let browser, releaseHeld = () => {};
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ ...fixture, rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await reviewDeadlineJourney(browser);
    before = await repository.list();
    const open = async username => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      contexts.push(context); await context.tracing.start({ screenshots: true, snapshots: true });
      const reads = new Map();
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() === 'GET') reads.set(url.pathname, (reads.get(url.pathname) || 0) + 1);
        if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
        if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
        if (url.pathname === '/api/admin/notifications/health') return route.fulfill({ json: { success: true, data: { configuration: { status: 'not_configured' }, worker: { status: 'disabled' }, queue: {} } } });
        if (/\/notifications(?:\/|$)/.test(url.pathname) || ['/api/admin/directory-users', '/api/admin/employees'].includes(url.pathname)
          || !['GET', 'HEAD'].includes(request.method())) { report.forbidden.push({ method: request.method(), path: url.pathname }); return route.abort(); }
        return route.continue();
      });
      const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: TEST_PASSWORD } });
      assert.equal(login.status(), 200);
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto(`${origin}/${username.startsWith('viewer') ? 'records' : 'admin'}`);
      return { page, context, origin, reads };
    };
    await lifecycleJourney(open, repository, records);
    before = await repository.list();
    const viewer = await open('viewer');
    const { page } = viewer;
    const dashboard = new DashboardPage(page);
    await dashboard.ready();
    await expect(dashboard.rows()).toHaveCount(11);
    for (const [key, total] of [['all', 11], ['review', 6], ['draft', 3], ['attention', 10]]) {
      await expect(dashboard.host.locator(`[data-summary="${key}"] strong`)).toHaveText(String(total));
    }
    await dashboard.card('In review').click(); await expect(dashboard.rows()).toHaveCount(6);
    await dashboard.card('Drafts').click(); await expect(dashboard.rows()).toHaveCount(3);
    await dashboard.card('Needs attention').click(); await expect(dashboard.rows()).toHaveCount(10);
    await dashboard.reset();
    report.checks.push('Verified employee with no assigned role opens professional read-only dashboard');

    const openDocument = dashboard.row(records[0].id).locator('[data-column="id"] .rd-open-button');
    await expect(dashboard.row(records[0].id).locator('.rd-row-actions .rd-open-button')).toHaveCount(0);
    await expect(openDocument).toHaveText('Open PCN');await expect(openDocument).toHaveAttribute('href', `/${records[0].id}`);
    assert.equal(await openDocument.getAttribute('target'), null, 'PCN opens in the current tab');
    await openDocument.focus();await page.keyboard.press('Enter');await expect(page).toHaveURL(`${viewer.origin}/${records[0].id}`);
    await expect(page.locator('#appNoticeTitle')).toHaveText('PCN loaded');
    await expect(page.locator('main input:not(:disabled), main select:not(:disabled), main textarea:not(:disabled)')).toHaveCount(0);
    await page.goBack();await dashboard.ready();
    report.checks.push('Primary Open PCN keyboard link opens the real document in the current tab and preserves roleless read-only access');
    report.checks.push('All four summary counts match actual mixed records; clicking cards filters the table');

    await page.locator('#rdFilter-status').selectOption('gsc_review');
    await page.locator('#rdFilter-risk').selectOption('RL2');
    await page.locator('#rdFilter-supplier').selectOption('Beta supplier');
    await page.locator('#rdFilter-department').selectOption('GSC/TET');
    await page.locator('#rdFilter-from').fill('2026-10-03');
    await page.locator('#rdFilter-to').fill('2026-10-10');
    await expect(dashboard.rows()).toHaveCount(1); await expect(dashboard.row(records[2].id)).toBeVisible();
    await page.locator('#rdViewEditor summary').click(); await page.locator('#rdViewName').fill('GSC fixture review');
    await dashboard.host.getByRole('button', { name: 'Save current view', exact: true }).click();
    await dashboard.reset(); await expect(dashboard.rows()).toHaveCount(11);
    await page.reload(); await dashboard.ready();
    await page.locator('#rdFilter-saved').selectOption('GSC fixture review');
    await expect(dashboard.rows()).toHaveCount(1);
    await expect(page.locator('#rdFilter-from')).toHaveValue('2026-10-03');
    const loginOther = await viewer.context.request.post(`${viewer.origin}/api/auth/login`, { headers: { origin: viewer.origin }, data: { username: 'viewer-two', password: TEST_PASSWORD } });
    assert.equal(loginOther.status(), 200);
    const otherPage = await viewer.context.newPage();
    await otherPage.goto(`${viewer.origin}/records`); await new DashboardPage(otherPage).ready();
    await expect(otherPage.locator('#rdFilter-saved option')).toHaveCount(1);
    const restoreLogin = await viewer.context.request.post(`${viewer.origin}/api/auth/login`, { headers: { origin: viewer.origin }, data: { username: 'viewer', password: TEST_PASSWORD } });
    assert.equal(restoreLogin.status(), 200); await otherPage.close();
    await dashboard.host.getByRole('button', { name: 'Delete selected view', exact: true }).click();
    await expect(page.locator('#rdFilter-saved option')).toHaveCount(1); await dashboard.reset();
    report.checks.push('Status/risk/supplier/department/UTC-date filters combine; named view reloads/deletes and remains user scoped');

    await page.locator('#rdPageSize').selectOption('10');
    await expect(dashboard.rows()).toHaveCount(10);
    await dashboard.host.getByRole('button', { name: 'PCN code', exact: true }).click();
    assert.equal(await dashboard.rows().first().getAttribute('data-pcn-id'), records[0].id);
    await dashboard.host.locator('.rd-pagination').getByRole('button', { name: 'Next', exact: true }).click();
    await expect(dashboard.rows()).toHaveCount(1);
    await dashboard.host.locator('.rd-pagination').getByRole('button', { name: 'Previous', exact: true }).click();
    await page.locator('#rdColumnChooser summary').click();
    await page.locator('#rdColumnChooser').getByRole('checkbox', { name: 'Risk', exact: true }).uncheck();
    await expect(dashboard.host.locator('td[data-column="riskLevel"]')).toHaveCount(0);
    await page.locator('#rdColumnChooser summary').click();
    await page.reload(); await dashboard.ready();
    await expect(page.locator('#rdPageSize')).toHaveValue('10');
    await expect(dashboard.rows()).toHaveCount(10);
    await expect(dashboard.host.locator('td[data-column="riskLevel"]')).toHaveCount(0);
    assert.equal(await dashboard.rows().first().getAttribute('data-pcn-id'), records[0].id);
    const downloadWait = page.waitForEvent('download');
    await dashboard.host.getByRole('button', { name: 'Export filtered CSV', exact: true }).click();
    const csv = await fs.readFile(await (await downloadWait).path());
    assert.equal(csv.subarray(0, 3).toString('hex'), 'efbbbf', 'CSV has UTF-8 BOM');
    const decoded = csv.toString('utf8');
    assert.equal((decoded.match(/PCN-2026-\d{4}/g) || []).length, 11, 'Export includes every filtered open page');
    assert(decoded.includes('ไทย')); assert(decoded.includes("'=FORMULA"), 'Spreadsheet formulas are neutralized');
    assert(!decoded.split('\r\n')[0].includes('"Risk"'), 'CSV respects visible columns');
    await page.locator('#rdFilter-supplier').selectOption('Alpha supplier');
    const filteredDownload = page.waitForEvent('download');
    await dashboard.host.getByRole('button', { name: 'Export filtered CSV', exact: true }).click();
    const filteredCsv = await fs.readFile(await (await filteredDownload).path(), 'utf8');
    assert.equal((filteredCsv.match(/PCN-2026-\d{4}/g) || []).length, 5);
    await dashboard.reset();
    report.checks.push('Sort/pagination/visible columns persist; downloaded CSV exports all filtered pages, UTF-8 Thai and safe formulas');

    await expect(dashboard.row(records[0].id).locator('[data-column="documents"]')).toHaveText('Documents ready');
    await expect(dashboard.row(records[1].id).locator('[data-column="documents"]')).toContainText('Missing 1');
    await expect(dashboard.row(records[2].id).locator('[data-column="progress"]')).toContainText('signing steps');
    await expect(dashboard.row(records[2].id).locator('[data-column="next"]')).toContainText('GSC/TET');
    await expect(dashboard.row(records[2].id).locator('[data-column="next"]')).not.toContainText('Dashboard Assigned Preparer');
    await expect(dashboard.row(records[2].id).locator('[data-column="pending"]')).toHaveText(/^(?:\d+ days?|<1 day)$/);
    await expect(dashboard.host.locator('.rd-overdue')).toHaveCount(0);
    await expect(dashboard.host.getByRole('button', { name: /^(Remove|Delete PCN|Save changes|Approve)\b/i })).toHaveCount(0);
    report.checks.push('Actual clean/quarantined files drive document readiness; workflow/signing progress and pending age appear with no invented overdue or reviewer identity disclosure');

    const dialog = page.locator('#rdPreviewDialog');
    const closePreview = async id => { await dialog.getByRole('button', { name: 'Close preview', exact: true }).click(); await expect(dialog).toBeHidden(); await expect(dashboard.preview(id)).toBeFocused(); };
    const historyReadsBeforePreview = viewer.reads.get(`/api/pcns/${records[0].id}/revisions`) || 0;
    const summaryReadsBeforePreview = viewer.reads.get(`/api/pcns/${records[0].id}/workflow-summary`) || 0;
    const documentReadsBeforePreview = viewer.reads.get(`/api/pcns/${records[0].id}/documents`) || 0;
    await dashboard.preview(records[0].id).focus(); await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible(); await expect(page.locator('#rdPreviewContent')).toContainText('Dashboard material 01');
    assert.equal(viewer.reads.get(`/api/pcns/${records[0].id}/revisions`) || 0, historyReadsBeforePreview, 'Timeline is lazy');
    assert.equal(viewer.reads.get(`/api/pcns/${records[0].id}/workflow-summary`) || 0, summaryReadsBeforePreview, 'Department timeline is lazy');
    assert.equal(viewer.reads.get(`/api/pcns/${records[0].id}/documents`) || 0, documentReadsBeforePreview, 'Documents are lazy');
    await dialog.getByRole('tab', { name: 'Timeline', exact: true }).click();
    await expect(dialog.locator('[data-workflow-stage]')).toHaveCount(6);
    await expect(dialog.locator('[data-workflow-stage="signoff.gscTet"]')).toContainText('1/3');
    await dialog.locator('[data-workflow-stage="signoff.gscTet"]').click();
    await expect(dialog.locator('#rdWorkflowDetails')).toContainText('Dashboard GSC Approver');
    assert.equal(viewer.reads.get(`/api/pcns/${records[0].id}/revisions`) || 0, historyReadsBeforePreview, 'Department timeline does not request Change history');
    await dialog.getByRole('tab', { name: 'Change history', exact: true }).click();
    await expect(dialog.locator('.rd-timeline li')).toHaveCount(2);
    await expect(dialog.locator('.rd-timeline')).toContainText('GSC/TET');
    await expect(dialog.locator('.rd-timeline')).toContainText('Dashboard GSC Approver');
    await dialog.getByRole('tab', { name: 'Documents', exact: true }).click();
    await expect(dialog.locator('.rd-documents')).toContainText('Hazardous fixture.pdf');
    await expect(dialog.getByRole('button', { name: /^(Save|Upload|Approve|Remove|Delete)\b/i })).toHaveCount(0);
    const frozen = viewer.reads.get('/api/pcns/overview');
    await unchangedFor(5500, () => viewer.reads.get('/api/pcns/overview'), frozen);
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(dashboard.preview(records[0].id)).toBeFocused();
    await dashboard.preview(records[1].id).click(); await dialog.getByRole('tab', { name: 'Documents', exact: true }).click();
    await expect(dialog.locator('.rd-documents')).toContainText('Quarantined');
    await expect(dialog.locator('.rd-documents a')).toHaveCount(0); await closePreview(records[1].id);
    await dashboard.preview(records[2].id).click(); await dialog.getByRole('tab', { name: 'Documents', exact: true }).click();
    await expect(page.locator('#rdPreviewContent')).toContainText('No documents'); await closePreview(records[2].id);
    report.checks.push('Keyboard Quick view opens lazy read-only Overview, department Timeline, secondary Change history and Documents; saved signatures and clean/quarantine/empty files render without writes');

    let historyMode = 'error';
    const historyRoute = route => {
      if (historyMode === 'error') return route.fulfill({ status: 503, json: { success: false, error: 'Fixture history unavailable' } });
      if (historyMode === 'empty') return route.fulfill({ json: { success: true, data: { items: [], capabilities: {} } } });
      return route.continue();
    };
    await page.route(`**/api/pcns/${records[2].id}/workflow-summary`, historyRoute);
    await page.route(`**/api/pcns/${records[2].id}/revisions`, historyRoute);
    await dashboard.preview(records[2].id).click(); await dialog.getByRole('tab', { name: 'Timeline', exact: true }).click();
    await expect(page.locator('#rdPreviewContent')).toContainText('Fixture history unavailable');
    historyMode = 'real'; await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(dialog.locator('[data-workflow-stage]')).toHaveCount(6); await closePreview(records[2].id);
    historyMode = 'empty'; await dashboard.preview(records[2].id).click(); await dialog.getByRole('tab', { name: 'Change history', exact: true }).click();
    await expect(page.locator('#rdPreviewContent')).toContainText('No recorded changes'); await closePreview(records[2].id);
    await page.unroute(`**/api/pcns/${records[2].id}/revisions`);
    await page.unroute(`**/api/pcns/${records[2].id}/workflow-summary`);
    await page.route(`**/api/pcns/${records[0].id}/workflow-summary`, async route => {
      await new Promise(resolve => { releaseHeld = resolve; }); return route.continue();
    });
    await dashboard.preview(records[0].id).click(); await expect(page.locator('#rdPreviewContent')).toContainText('Dashboard material 01');
    const summaryEntered = page.waitForRequest(request => new URL(request.url()).pathname === `/api/pcns/${records[0].id}/workflow-summary`);
    await dialog.getByRole('tab', { name: 'Timeline', exact: true }).click(); await summaryEntered;
    const lateSummary = page.waitForResponse(response => new URL(response.url()).pathname === `/api/pcns/${records[0].id}/workflow-summary`);
    await dialog.getByRole('tab', { name: 'Documents', exact: true }).click();
    await expect(dialog.locator('.rd-documents')).toContainText('Hazardous fixture.pdf');
    releaseHeld(); assert.equal((await lateSummary).status(), 200);
    await expect(dialog.getByRole('tab', { name: 'Documents', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.locator('[data-workflow-stage]')).toHaveCount(0); await expect(dialog.locator('.rd-documents')).toContainText('Hazardous fixture.pdf');
    await closePreview(records[0].id); await page.unroute(`**/api/pcns/${records[0].id}/workflow-summary`);
    let held = true;
    await page.route(`**/api/pcns/${records[0].id}`, async route => {
      if (held) await new Promise(resolve => { releaseHeld = resolve; });
      return route.continue();
    });
    const requestEntered = page.waitForRequest(request => new URL(request.url()).pathname === `/api/pcns/${records[0].id}`);
    await dashboard.preview(records[0].id).click(); await requestEntered;
    await expect(page.locator('#rdPreviewContent')).toContainText(/Loading preview/);
    await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
    await dashboard.preview(records[1].id).click(); await expect(page.locator('#rdPreviewContent')).toContainText('Dashboard material 02');
    const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/pcns/${records[0].id}`);
    held = false; releaseHeld(); await oldResponse;
    await expect(page.locator('#rdPreviewTitle')).toContainText(records[1].id);
    await expect(page.locator('#rdPreviewContent')).toContainText('Dashboard material 02');
    await expect(page.locator('#rdPreviewContent')).not.toContainText('Dashboard material 01');
    await closePreview(records[1].id); await page.unroute(`**/api/pcns/${records[0].id}`);
    report.checks.push('Preview loading/error/retry/empty states are explicit; late closed-record response cannot replace a newer preview');

    await page.locator('#recordsSearch').fill('Dashboard material');
    await dashboard.host.locator('.rd-pagination').getByRole('button', { name: 'Next', exact: true }).click();
    await page.locator('#recordsSearch').focus();
    const current = await repository.findById(records[16].id);
    await repository.update(current.id, row => ({ ...row, supplierName: 'Polling dashboard update', updatedAt: new Date().toISOString() }), 'Dashboard polling fixture', current.version);
    before = await repository.list();
    await expect(dashboard.row(current.id)).toContainText('Polling dashboard update');
    await expect(dashboard.host.locator('.rd-pagination')).toContainText('Page 2 of 2');
    await expect(page.locator('#recordsSearch')).toHaveValue('Dashboard material');
    await expect(page.locator('#recordsSearch')).toBeFocused();
    const focusOpen = dashboard.row(current.id).locator('.rd-open-button');await focusOpen.focus();
    const currentAgain = await repository.findById(current.id);
    await repository.update(current.id, row => ({ ...row, supplierName: 'Opening focus preserved', updatedAt: new Date().toISOString() }), 'Dashboard polling fixture', currentAgain.version);
    before = await repository.list();await expect(dashboard.row(current.id)).toContainText('Opening focus preserved');
    await expect(focusOpen).toBeFocused();
    await page.locator('#rdViewEditor summary').click(); await page.locator('#rdViewName').fill('Unsaved view fixture');
    await unchangedFor(5500, () => viewer.reads.get('/api/pcns/overview'), viewer.reads.get('/api/pcns/overview'));
    await expect(page.locator('#rdViewName')).toHaveValue('Unsaved view fixture');
    await page.locator('#rdViewEditor summary').click();
    report.checks.push('Five-second polling updates genuine memory changes while preserving page/search/focus; preferences editor pauses polling and preserves draft');

    const admin = await open('admin'); const portal = new DashboardPage(admin.page, '#pcnAdminView'); await portal.ready();
    await admin.page.locator('#adminUsersButton').click();
    await expect(admin.page.locator('#adminUsersRows .notification-person-identity').first()).toBeVisible();
    const userTypography = await admin.page.locator('#adminUsersRows tr').first().evaluate(row =>
      [...row.querySelectorAll('.notification-person-identity, .user-presence-badge, td:last-child button')].map(element => ({ family: getComputedStyle(element).fontFamily, size: getComputedStyle(element).fontSize })));
    assert(userTypography.length >= 3, 'Actual Users row contains identity, presence and action controls');
    for (const element of userTypography) { assert.match(element.family, /PCN Table Semibold/); assert.equal(element.size, '14px'); }
    await admin.page.setViewportSize({ width: 390, height: 844 });
    await portal.fits();
    await admin.page.screenshot({ path: path.resolve('test-results/records-users-font-mobile.png'), fullPage: true });
    await admin.page.setViewportSize({ width: 1440, height: 1000 });
    await admin.page.locator('#adminRecordsButton').click(); await portal.ready();
    await expect(portal.host.locator('[data-summary="all"] strong')).toHaveText('11');
    await expect(portal.row(records[2].id).locator('[data-column="next"]')).toContainText('Dashboard Assigned Preparer');
    const actionRow=portal.row(records[2].id),history=actionRow.getByRole('button', { name: `History ${records[2].id}`, exact: true });
    const typography = await actionRow.evaluate(row => ({
      cells: [...row.cells].map(cell => ({ column: cell.dataset.column || 'actions', family: getComputedStyle(cell).fontFamily, size: getComputedStyle(cell).fontSize })),
      open: { family: getComputedStyle(row.querySelector('.rd-open-button')).fontFamily, size: getComputedStyle(row.querySelector('.rd-open-button')).fontSize },
      icon: { family: getComputedStyle(row.querySelector('.rd-preview-button')).fontFamily, size: getComputedStyle(row.querySelector('.rd-preview-button')).fontSize }
    }));
    const compactTypography = admin.page.viewportSize().width >= 1200;
    const tableSize = compactTypography ? '13px' : '14px', supplierSize = compactTypography ? '14px' : '16px';
    for (const cell of typography.cells) { assert.match(cell.family, /PCN Table Semibold/); assert.equal(cell.size, ['supplierName', 'materialName'].includes(cell.column) ? supplierSize : tableSize); }
    assert.match(typography.open.family, /PCN Table Semibold/); assert.equal(typography.open.size, tableSize);
    assert.match(typography.icon.family, /PCN Table Semibold/); assert.equal(typography.icon.size, tableSize);
    await expect(history).toHaveAttribute('title', 'History');
    await expect(history.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    await expect(actionRow.getByRole('button', { name: `Remove ${records[2].id}`, exact: true })).toBeHidden();
    const more=actionRow.locator('.rd-more-summary');await more.focus();
    const focusedRow = await repository.findById(records[2].id);
    await repository.update(focusedRow.id, row => ({ ...row, supplierName: 'More focus preserved', updatedAt: new Date().toISOString() }), 'Dashboard polling fixture', focusedRow.version);
    before = await repository.list();await expect(actionRow).toContainText('More focus preserved');await expect(more).toBeFocused();
    await admin.page.keyboard.press('Enter');
    await expect(actionRow.getByRole('button', { name: `Remove ${records[2].id}`, exact: true })).toBeVisible();
    await unchangedFor(5500, () => admin.reads.get('/api/pcns/overview'), admin.reads.get('/api/pcns/overview'));
    await admin.page.keyboard.press('Escape');await expect(more).toBeFocused();
    await expect(actionRow.getByRole('button', { name: `Remove ${records[2].id}`, exact: true })).toBeHidden();
    await more.click();await actionRow.getByRole('button', { name: `Remove ${records[2].id}`, exact: true }).click();
    await expect(admin.page.locator('#adminRemoveDialog')).toBeVisible();await admin.page.locator('#adminRemoveCancelButton').click();
    await expect(admin.page.locator('#adminRemoveDialog')).toBeHidden();
    await history.click();await expect(admin.page.locator('#pcnTimelineDialog')).toBeVisible();
    await expect(admin.page.locator('#pcnTimelineSummaryTab')).toHaveAttribute('aria-selected', 'true');
    await expect(admin.page.locator('#pcnTimelineTrack [data-workflow-stage]')).toHaveCount(6);
    assert.equal(admin.reads.get(`/api/pcns/${records[2].id}/revisions`) || 0, 0, 'Portal department summary leaves detailed history lazy');
    await admin.page.locator('#pcnTimelineCloseButton').click();await expect(history).toBeFocused();
    await actionRow.locator('.rd-open-button').click();await expect(admin.page).toHaveURL(`${admin.origin}/${records[2].id}`);
    await expect(admin.page.locator('#appNoticeTitle')).toHaveText('PCN loaded');await admin.page.goBack();await portal.ready();
    const portalWrap = portal.host.locator('.admin-table-wrap');
    assert.equal(await portalWrap.evaluate(wrap => {
      const actions = wrap.querySelector('tbody .rd-row-actions').getBoundingClientRect();
      const bounds = wrap.getBoundingClientRect();
      return actions.left >= bounds.left && actions.right <= bounds.right + 1;
    }), true, 'Desktop sticky actions remain visible without horizontal scrolling');
    await portalWrap.evaluate(wrap => { wrap.scrollLeft = wrap.scrollWidth; });
    assert.equal(await portalWrap.evaluate(wrap => {
      const code = wrap.querySelector('td[data-column="id"]').getBoundingClientRect();
      return code.left >= wrap.getBoundingClientRect().left - 1;
    }), true, 'PCN code stays pinned while reading right-hand columns');
    await portalWrap.evaluate(wrap => { wrap.scrollLeft = 0; });
    const supplier = await open('supplier'); const owned = new DashboardPage(supplier.page, '#pcnAdminView'); await owned.ready();
    await expect(owned.rows()).toHaveCount(5);
    for (const row of await owned.rows().evaluateAll(nodes => nodes.map(node => node.dataset.pcnId))) {
      assert.equal((await repository.findById(row)).ownerUserId, 'supplier-id');
    }
    await expect(owned.host.getByRole('button', { name: /^Remove(?:\s|$)/ })).toHaveCount(0);
    report.checks.push('Portal Open PCN, labelled History and More actions work; More pauses polling, Escape restores focus, removal still confirms and suppliers cannot remove');

    await dashboard.reset(); await page.setViewportSize({ width: 390, height: 844 }); await dashboard.fits();
    const mobileTypography = await dashboard.rows().first().evaluate(row => [...row.cells].map(cell => ({ column: cell.dataset.column || 'actions', size: getComputedStyle(cell).fontSize })));
    for (const cell of mobileTypography) assert.equal(cell.size, ['supplierName', 'materialName'].includes(cell.column) ? '16px' : '14px', 'Mobile table typography stays unchanged');
    await page.screenshot({ path: path.resolve('test-results/records-dashboard-mobile.png'), fullPage: true });
    await dashboard.preview(records[0].id).click(); await expect(page.locator('#rdPreviewContent')).toContainText('Dashboard material 01');
    await dialog.getByRole('tab', { name: 'Timeline', exact: true }).click(); await expect(dialog.locator('[data-workflow-stage]')).toHaveCount(6);
    await dashboard.fits();
    assert.equal(await dialog.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && node.scrollWidth <= node.clientWidth; }), true);
    await page.screenshot({ path: path.resolve('test-results/records-dashboard-mobile-preview.png') }); await closePreview(records[0].id);
    report.checks.push('390px dashboard and preview remain contained with internal scrolling');

    await page.route('**/api/pcns/overview', route => route.fulfill({ status: 403, json: { success: false, error: 'Fixture access revoked' } }));
    // Polling may revoke access before a manual Refresh click can reach the button.
    await expect(page.locator('#recordsWorkspace')).toBeHidden(); await expect(page.locator('#recordsGateError')).toBeVisible();
    await expect(page.locator('#recordsRows tr')).toHaveCount(0);
    report.checks.push('Revoked overview authorization clears records and hides the workspace through polling');
    const revokedPreview = await open('viewer-two');
    const revokeDashboard = new DashboardPage(revokedPreview.page); await revokeDashboard.ready();
    await revokedPreview.page.route(`**/api/pcns/${records[0].id}/workflow-summary`, route => route.fulfill({ status: 403, json: { success: false, error: 'Fixture preview access revoked' } }));
    await revokeDashboard.preview(records[0].id).click();
    await expect(revokedPreview.page.locator('#rdPreviewContent')).toContainText('Dashboard material 01');
    await revokedPreview.page.locator('#rdPreviewDialog').getByRole('tab', { name: 'Timeline', exact: true }).click();
    await expect(revokedPreview.page.locator('#rdPreviewDialog')).toBeHidden();
    await expect(revokedPreview.page.locator('#recordsWorkspace')).toBeHidden();
    await expect(revokedPreview.page.locator('#recordsRows tr')).toHaveCount(0);
    await expect(revokedPreview.page.locator('#rdPreviewContent')).toBeEmpty();
    report.checks.push('Revoked preview authorization closes and clears modal, table and workspace immediately');
    await admin.page.screenshot({ path: path.resolve('test-results/records-dashboard-desktop.png'), fullPage: true });
    assert.deepEqual(await repository.list(), before, 'Browser has no business writes');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
    report.fixtureRecords = records.length; report.browser = 'passed';
  } catch (error) {
    report.browser = 'failed'; report.failure = error.message;
    for (const [index, context] of contexts.entries()) {
      const page = context.pages()[0];
      if (page && !page.isClosed()) await page.screenshot({ path: path.resolve(`test-results/records-dashboard-failure-${index + 1}.png`), fullPage: true }).catch(() => {});
    }
    throw error;
  }
  finally {
    releaseHeld();
    await reportArtifacts();
    for (let index = 0; index < contexts.length; index += 1) {
      await contexts[index].tracing.stop({ path: path.resolve(`test-results/records-dashboard-trace-${index + 1}.zip`) });
      await contexts[index].close();
    }
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    console.log(JSON.stringify(report));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
