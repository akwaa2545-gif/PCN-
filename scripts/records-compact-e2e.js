// Genuine typed/legacy records served by the loopback API from memory only.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: browserExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');
const expect = browserExpect.configure({ timeout: 10000 });
const artifact = name => path.resolve('test-results', `records-compact-${name}`);
const report = { storage: 'isolated_memory_only', checks: [], metrics: [], errors: [], external: [], forbidden: [], status: 'running' };
const check = name => { report.checks.push(name); console.log(JSON.stringify({ compactRecordsCheck: name })); };
const supplier = 'International Supplier Quality and Process Engineering Manufacturing Corporation — Full supplier name retained for document review ไทย';
const material = 'Precision copper alloy strip with extended engineering specification, product model, tolerance, quality qualification and manufacturing details retained in full';
const engineer = type => `${type} Production Engineering Prepared — Long Assigned Reviewer Name for Cross Functional Supplier Process Qualification`;
const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const deferred = () => { let resolve; const promise = new Promise(ready => { resolve = ready; }); return { promise, resolve }; };

async function fixtures() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const now = new Date('2026-11-23T05:00:00Z'), service = new PcnService(repository, () => now);
  const records = [];
  for (const type of ['ta', 'sc', undefined]) {
    const input = service.normalizeInput({ ...unsignedPayload, documentType: type, status: 'technical_review', supplierName: supplier, materialName: material,
      internalReview: { docs: { hazardousReport: true }, tapbu: { noNeed: true },
        signoff: { gscTet: { prepared: true, checked: true, approved: true, preparedName: 'Fixture GSC', checkedName: 'Fixture GSC', approvedName: 'Fixture GSC' } } } });
    records.push(await repository.create({ ...input, ownerUserId: 'supplier-id', createdAt: '2026-11-17T05:00:00Z', updatedAt: now.toISOString(),
      ...(type === 'sc' ? { isTestDocument: true } : {}),
      reviewTiming: { prodEngTet: { startedAt: type === 'sc' ? '2026-11-17T05:00:00Z' : '2026-11-22T05:00:00Z' } } }, 'Historical compact row fixture'));
  }
  const authService = fakeAuthService({ additionalUsers: [
    { username: 'viewer', employeeCode: '0800001', identityProvider: 'employee-code', roles: [], displayName: 'Compact Viewer' },
    ...[['ta', 'prodEngTa'], ['sc', 'prodEngSc'], ['legacy', 'prodEngTet']].map(([type, department]) => ({
      username: `${type}-prepared`, displayName: engineer(type.toUpperCase()), roles: ['productionengineering'], department, signingStep: 'prepared'
    }))
  ] });
  const documents = { async list() { return []; }, async listForRecords(ids) {
    return new Map(await Promise.all(ids.map(async id => [id, { parentVersion: (await repository.findById(id))?.version, attachments: [] }])));
  } };
  return { repository, service, records, authService, documents, clock: () => now };
}

async function open(browser, origin, username, contexts) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const initial = deferred(); const entry = { context, initial }; contexts.push(entry);
  await context.tracing.start({ screenshots: true, snapshots: true });
  let holdFirst = true;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
    if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
    if (url.pathname === '/api/admin/notifications/health') return route.fulfill({ json: { success: true, data: { configuration: { status: 'not_configured' }, worker: {}, queue: {} } } });
    if (!['GET', 'HEAD'].includes(request.method()) || /\/notifications(?:\/|$)/.test(url.pathname)
      || ['/api/admin/directory-users', '/api/admin/employees'].includes(url.pathname)) { report.forbidden.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/api/pcns/overview' && holdFirst) { holdFirst = false; await initial.promise; }
    return route.continue();
  });
  assert.equal((await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: TEST_PASSWORD } })).status(), 200);
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`${origin}/${username === 'viewer' ? 'records' : 'admin'}`, { waitUntil: 'domcontentloaded' });
  const host = page.locator(username === 'viewer' ? '#recordsWorkspace' : '#pcnAdminView');
  await expect(host.locator('tr.rd-skeleton-row')).toHaveCount(5);
  await expect(host.locator('#rdRecordsLoadingOverlay')).toBeVisible();
  initial.resolve(); await expect(host.locator('tr[data-pcn-id]')).toHaveCount(3);
  await expect(host.locator('#rdRecordsLoadingOverlay')).toBeHidden();
  await expect(host.locator('#rdFiltersToggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(host.locator('#rdAdvancedFilters')).toBeHidden();
  return { page, host, context, username, panel: host.locator('#rdRecordsPanel'), row: id => host.locator(`tr[data-pcn-id="${id}"]`) };
}

async function fullText(cell, expected) {
  await expect(cell).toContainText(expected);
  await expect(cell.locator('[title]').first()).toHaveAttribute('title', expected);
}

async function layout(view, records) {
  const { page, host, panel } = view;
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1280, height: 900 }, { width: 320, height: 844 }]) {
    await page.setViewportSize(viewport); await panel.evaluate(node => { node.scrollLeft = 0; });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page contains horizontal table scrolling');
    for (const record of records) {
      const row = view.row(record.id), identity = row.locator('[data-column="id"]');
      const type = record.documentType;
      if (type) {
        const badge = identity.locator('.rd-type-badge');
        await expect(badge).toHaveText(type.toUpperCase()); await expect(badge).toHaveAttribute('aria-label', `PCN type ${type.toUpperCase()}`);
        const placement = await identity.evaluate(cell => {
          const code = cell.querySelector('.rd-code-link').getBoundingClientRect(), badge = cell.querySelector('.rd-type-badge').getBoundingClientRect();
          return { sameLine: Math.abs((code.top + code.bottom) / 2 - (badge.top + badge.bottom) / 2) <= 6, adjacent: badge.left >= code.right - 1 && badge.left - code.right <= 20, gap: badge.left - code.right };
        });
        report.identity = [...(report.identity || []), { username: view.username, width: viewport.width, id: record.id, ...placement }];
        assert(placement.sameLine && placement.adjacent, 'TA/SC badge sits beside its code');
      } else await expect(identity.locator('.rd-type-badge')).toHaveCount(0);
      await fullText(row.locator('[data-column="supplierName"]'), supplier);
      await fullText(row.locator('[data-column="materialName"]'), material);
      const metrics = await row.evaluate(element => {
        const box = element.getBoundingClientRect(), supplier = element.querySelector('[data-column="supplierName"]'), material = element.querySelector('[data-column="materialName"]');
        return { id: element.dataset.pcnId, height: box.height, supplierFont: parseFloat(getComputedStyle(supplier).fontSize), materialFont: parseFloat(getComputedStyle(material).fontSize),
          supplierTextHeight: supplier.querySelector('.rd-cell-text').getBoundingClientRect().height, materialTextHeight: material.querySelector('.rd-cell-text').getBoundingClientRect().height,
          cellColors: [...element.cells].map(cell => ({ background: getComputedStyle(cell).backgroundColor, color: getComputedStyle(cell).color })) };
      });
      assert(metrics.height <= (viewport.width === 320 ? 120 : 96), `Compact row stays bounded: ${metrics.height}px at ${viewport.width}px`);
      assert(metrics.height >= 60 && metrics.supplierFont >= (viewport.width === 320 ? 12 : 14) && metrics.materialFont >= (viewport.width === 320 ? 12 : 14), 'Compact rows retain legible supplier/material text and usable controls');
      const badgeFonts = await row.locator('.rd-badge,.rd-type-badge,.rd-test-badge').evaluateAll(badges => badges.map(badge => parseFloat(getComputedStyle(badge).fontSize)));
      assert(badgeFonts.every(font => font >= 12), 'Status, document and type badges remain legible');
      assert(metrics.supplierTextHeight <= 45 && metrics.materialTextHeight <= 45, 'Long content remains bounded to two lines');
      report.metrics.push({ username: view.username, width: viewport.width, ...metrics });
      if (record.isTestDocument) {
        await expect(identity.locator('.rd-test-badge')).toHaveText('TESTING DOC'); await expect(row).toHaveClass(/rd-row-overdue/);
        await expect(identity.locator('.rd-deadline-overdue')).toHaveAttribute('title', /Prod\.Eng\/SC overdue/);
        assert(metrics.cellColors.every(cell => { const rgb = cell.background.match(/\d+/g)?.map(Number); return rgb && rgb[0] > rgb[1] && rgb[0] > rgb[2]; }), 'Every overdue cell retains red row tint');
        assert(metrics.cellColors.every(cell => { const rgb = cell.color.match(/\d+/g)?.map(Number); return rgb && rgb[0] > rgb[1] && rgb[0] > rgb[2]; }), 'Every overdue cell retains red text');
      }
      assert((await identity.locator('.rd-code-link').boundingBox()).height >= 24, 'PCN code link keeps at least a 24px target height');
      const open = identity.locator('.rd-open-button'); await expect(open).toHaveAttribute('href', `/${record.id}`); await expect(open).toBeVisible();
      assert((await open.boundingBox()).height >= 24, 'Open PCN keeps a usable target height');
      const actionTargets = await row.locator('.rd-secondary-actions > button,.rd-secondary-actions > details > summary').evaluateAll(targets => targets.map(target => { const box = target.getBoundingClientRect(); return { width: box.width, height: box.height }; }));
      assert(actionTargets.every(target => target.width >= 24 && target.height >= 24), 'Icon actions retain at least 24px targets');
      if (view.username === 'admin') {
        const next = row.locator('[data-column="next"]');
        await expect(next.locator('small')).toHaveAttribute('title', engineer(type ? type.toUpperCase() : 'LEGACY'));
      }
    }
    await page.screenshot({ path: artifact(`${view.username}-${viewport.width}-left.png`), fullPage: true });
    const overdue = view.row(records.find(record => record.isTestDocument).id);
    await overdue.scrollIntoViewIfNeeded();
    await panel.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    const updated = overdue.locator('[data-column="updatedAt"]'), actions = overdue.locator('.rd-row-actions');
    await expect(updated).not.toBeEmpty();
    const readable = await updated.evaluate(cell => {
      const bounds = cell.getBoundingClientRect(), actions = cell.parentElement.querySelector('.rd-row-actions').getBoundingClientRect(), panel = cell.closest('.admin-table-wrap').getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(cell); const text = range.getBoundingClientRect();
      const hit = document.elementFromPoint(text.left + text.width / 2, text.top + text.height / 2);
      return { fits: text.left >= panel.left - 1 && text.right <= actions.left + 1, hit: hit?.closest('td') === cell, font: parseFloat(getComputedStyle(cell).fontSize),
        cellLeft: bounds.left, textLeft: text.left, textRight: text.right, panelLeft: panel.left, actionsLeft: actions.left,
        actionPosition: getComputedStyle(cell.parentElement.querySelector('.rd-row-actions')).position };
    });
    assert(readable.fits && readable.hit && readable.font >= 12, 'Updated remains readable beside sticky Actions after horizontal scroll');
    assert(viewport.width < 721 || readable.actionPosition === 'sticky', 'Desktop Actions retains its sticky position');
    report.updated = [...(report.updated || []), { username: view.username, width: viewport.width, ...readable }];
    await expect(actions).toBeVisible();
    await page.screenshot({ path: artifact(`${view.username}-${viewport.width}-right.png`), fullPage: true });
  }
  check(`${view.username}: TA/SC identity, genuine legacy, bounded long text, legible compact rows, test/overdue styling and visible Updated/sticky Actions at 1440/1280/320`);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function actions(view, records) {
  const { page, panel } = view, record = records[0];
  await panel.evaluate(node => { node.scrollLeft = node.scrollWidth; });
  await view.row(record.id).getByRole('button', { name: `Quick view ${record.id}`, exact: true }).click();
  await expect(page.locator('#rdPreviewDialog')).toBeVisible(); await expect(page.locator('#rdPreviewContent')).toContainText(supplier);
  await page.locator('#rdPreviewDialog [aria-label="Close preview"]').click(); await expect(page.locator('#rdPreviewDialog')).toBeHidden();
  if (view.username === 'admin') {
    await view.row(record.id).getByRole('button', { name: `History ${record.id}`, exact: true }).click();
    await expect(page.locator('#pcnTimelineDialog')).toBeVisible(); await expect(page.locator('#pcnTimelineTrack')).toContainText('Prod.Eng/TA');
    await page.locator('#pcnTimelineCloseButton').click();
    const more = view.row(record.id).locator('summary.rd-more-summary');
    await expect(more).toHaveAttribute('aria-label', `More actions for ${record.id}`);
    await more.click(); await expect(view.row(record.id).getByRole('button', { name: `Remove ${record.id}`, exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(view.row(record.id).locator('.rd-row-more')).toHaveJSProperty('open', false);
  }
  await panel.evaluate(node => { node.scrollLeft = 0; });
  await view.row(record.id).locator('.rd-open-button').click(); await expect(page).toHaveURL(new RegExp(`/${record.id}$`));
  await expect(page.locator('#appNoticeTitle')).toHaveText('PCN loaded');
  await page.goBack(); await expect(view.host.locator('tr[data-pcn-id]')).toHaveCount(3);
  await expect(view.host.locator('#rdFiltersToggle')).toHaveAttribute('aria-expanded', 'false');
  check(`${view.username}: original Open PCN route, Quick view and available workflow/More actions remain usable; loading and collapsed filters persist`);
}

async function main() {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const fixture = await fixtures(), before = await fixture.repository.list(), server = http.createServer(), contexts = [];
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ ...fixture, rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    for (const username of ['viewer', 'admin']) { const view = await open(browser, origin, username, contexts); await layout(view, fixture.records); await actions(view, fixture.records); }
    assert.deepEqual(await fixture.repository.list(), before); assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.stack;
    for (const [index, entry] of contexts.entries()) { const page = entry.context.pages()[0]; if (page && !page.isClosed()) await page.screenshot({ path: artifact(`failure-${index + 1}.png`), fullPage: true }).catch(() => {}); }
    throw error;
  }
  finally {
    for (const [index, entry] of contexts.entries()) { entry.initial.resolve(); await entry.context.tracing.stop({ path: artifact(`trace-${index + 1}.zip`) }).catch(() => {}); await entry.context.close(); }
    if (browser) await browser.close(); if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await fs.writeFile(artifact('report.json'), JSON.stringify(report, null, 2));
    const cases = report.checks.map(name => `<testcase classname="records-compact" name="${xml(name)}"/>`); if (report.failure) cases.push(`<testcase name="failure"><failure>${xml(report.failure)}</failure></testcase>`);
    await fs.writeFile(artifact('junit.xml'), `<testsuite name="records-compact" tests="${cases.length}" failures="${Number(report.status === 'failed')}">${cases.join('')}</testsuite>`);
    await fs.writeFile(artifact('report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Compact records</title><h1>${report.status}</h1><ol>${report.checks.map(name => `<li>${xml(name)}</li>`).join('')}</ol>${report.failure ? `<pre>${xml(report.failure)}</pre>` : ''}</html>`);
    console.log(JSON.stringify(report));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
