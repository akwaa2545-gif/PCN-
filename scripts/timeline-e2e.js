// Portal timeline against genuine loopback auth, PcnService and in-memory revision history.
// All PCNs are synthetic. Browser interactions cannot mutate records or contact live integrations.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: playwrightExpect } = require('@playwright/test');
const expect = playwrightExpect.configure({ timeout: 10000 });
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');
const report = { storage: 'isolated_memory_only', checks: [], errors: [], external: [], forbidden: [] };

async function unchangedFor(milliseconds, read, expected) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    assert.equal(read(), expected, 'Open timeline prevents Portal polling/replacement');
    await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
  assert.equal(read(), expected);
}
async function fit(page, dialog) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Page fits viewport');
  assert.equal(await dialog.evaluate(node => {
    const box = node.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
      && node.scrollWidth <= node.clientWidth;
  }), true, 'Timeline dialog fits viewport');
}

async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const user = { id: 'admin-id', displayName: 'Timeline Fixture Administrator', roles: ['admin'] };
  let clock = new Date('2026-10-12T10:00:00.000Z');
  const service = new PcnService(repository, () => clock);
  let record = await service.create({ ...unsignedPayload, status: 'draft', supplierName: 'Timeline Supplier 0' }, 'Timeline Fixture Creator', user);
  for (let index = 1; index <= 9; index++) {
    clock = new Date(`2026-10-12T10:${String(index).padStart(2, '0')}:00.000Z`);
    record = await service.update(record.id, { version: record.version, supplierName: `Timeline Supplier ${index}` }, `Timeline Fixture Editor ${index}`, user);
  }
  const history = await repository.getRevisions(record.id);
  assert.equal(history.length, 10);
  report.fixtureEvents = history.length;
  clock = new Date('2026-10-12T10:10:00.000Z');
  let signed = await service.create({ ...unsignedPayload, status: 'draft', supplierName: 'Timeline Signing Supplier' }, 'Signing Fixture Creator', user);
  for (const [index, action] of ['approved', 'checked'].entries()) {
    clock = new Date(`2026-10-12T10:${11 + index}:00.000Z`);
    const signer = { id: `fixture-${action}`, displayName: `Fixture GSC ${action}`, roles: ['gsc'], department: 'gscTet', signingStep: action };
    signed = await service.update(signed.id, { version: signed.version, internalReview: { signoff: { gscTet: { [action]: true } } } }, signer.displayName, signer);
  }
  const signingHistory = await repository.getRevisions(signed.id);
  assert.equal(signingHistory.length, 3);
  report.signingFixtureEvents = signingHistory.length;
  const server = http.createServer();
  let browser, context, releaseHeld = () => {}, detailEntered = () => {}, mode = 'real', reads = 0;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, service, authService: fakeAuthService(), rootDir: path.resolve(__dirname, '..'),
      publicOrigin: origin, secureCookies: false, documents: { async list() { return []; } } }));
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await context.tracing.start({ screenshots: true, snapshots: true });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== origin) { report.external.push({ method, path: url.pathname }); return route.abort(); }
      if (method === 'GET' && url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
      if (method === 'GET' && url.pathname === '/api/admin/notifications/health') return route.fulfill({ json: { success: true, data: { configuration: { status: 'not_configured' }, worker: { status: 'disabled' }, queue: {} } } });
      if (/\/notifications(?:\/|$)/.test(url.pathname) || ['/api/admin/directory-users', '/api/admin/employees'].includes(url.pathname)
        || !['GET', 'HEAD'].includes(method)) { report.forbidden.push({ method, path: url.pathname }); return route.abort(); }
      if (url.pathname === '/api/pcns') reads++;
      if (url.pathname === `/api/pcns/${record.id}` && mode === 'detail-held') {
        await new Promise(resolve => { releaseHeld = resolve; detailEntered(); });
      }
      if (url.pathname === `/api/pcns/${record.id}/revisions`) {
        if (mode === 'held') await new Promise(resolve => { releaseHeld = resolve; });
        if (mode === 'empty') return route.fulfill({ json: { success: true, data: { items: [], capabilities: {} } } });
        if (mode === 'error') return route.fulfill({ status: 503, json: { success: false, error: 'Timeline fixture unavailable' } });
      }
      return route.continue();
    });
    const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username: 'admin', password: TEST_PASSWORD } });
    assert.equal(login.status(), 200);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`${origin}/admin`);
    let activeId = record.id;
    const eye = () => page.getByRole('button', { name: `View ${activeId}`, exact: true });
    const dialog = page.locator('#pcnTimelineDialog'), events = dialog.locator('.pcn-timeline-event');
    const details = dialog.locator('#pcnTimelineDetails');
    const open = async (keyboard = false) => {
      if (keyboard) { await eye().focus(); await page.keyboard.press('Enter'); }
      else await eye().click();
      await expect(dialog).toBeVisible();
    };
    const close = async button => { await dialog.locator(button).click(); await expect(dialog).toBeHidden(); await expect(eye()).toBeFocused(); };

    await open(true); await expect(events).toHaveCount(history.length);
    await expect(page.locator('#pcnTimelineTitle')).toContainText(record.id);
    assert.deepEqual(await events.evaluateAll(nodes => nodes.map(node => Number(node.dataset.revision))), history.map(event => event.revision).toSorted((a, b) => a - b));
    await expect(events.last()).toHaveAttribute('aria-pressed', 'true');
    await expect(details).toContainText('Timeline Fixture Editor 9');
    await expect(details).toContainText('Timeline Supplier 8');
    await expect(details).toContainText('Timeline Supplier 9');
    await expect(details).not.toContainText(record.documentControl.contentHash);
    assert(await dialog.locator('time').evaluateAll(nodes => nodes.some(node => node.dateTime === '2026-10-12T10:09:00.000Z')), 'Real event timestamp is exposed semantically');
    await events.nth(1).click();
    await expect(events.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(details).toContainText('Timeline Fixture Editor 1');
    await expect(details).toContainText('Timeline Supplier 0');
    await expect(details).toContainText('Timeline Supplier 1');
    await expect(dialog.getByRole('button', { name: /remove|delete|save|approve|update status/i })).toHaveCount(0);
    await fit(page, dialog);
    await page.screenshot({ path: path.resolve('test-results/timeline-desktop.png') });
    report.checks.push('Keyboard eye activation opens genuine chronological history; selected event shows actor/time/real before-after values without mutation controls');

    await dialog.locator('#pcnTimelineCloseButton').focus();
    const listReads = reads;
    await unchangedFor(5500, () => reads, listReads);
    await expect(dialog).toBeVisible(); await expect(events.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(eye()).toBeFocused();
    await open(); await expect(events).toHaveCount(history.length); await close('#pcnTimelineDoneButton');
    report.checks.push('Open modal pauses auto-refresh; Escape and Done close and restore View focus');

    mode = 'detail-held';
    const entered = new Promise(resolve => { detailEntered = resolve; });
    await open(); await entered; await expect(events).toHaveCount(history.length);
    await dialog.locator('#pcnTimelineCloseButton').click(); await expect(dialog).toBeHidden();
    const lateDetail = page.waitForResponse(response => new URL(response.url()).pathname === `/api/pcns/${record.id}`);
    releaseHeld(); mode = 'real'; assert.equal((await lateDetail).status(), 200);
    await expect(page.locator('#adminLoadingBar')).toBeHidden();
    await expect(dialog).toBeHidden(); await expect(eye()).toBeFocused();
    report.checks.push('Detail response arriving after timeline closes preserves restored View focus');

    mode = 'held';
    const waiting = page.waitForRequest(request => new URL(request.url()).pathname === `/api/pcns/${record.id}/revisions`);
    await open(); await waiting;
    await expect(dialog.locator('#pcnTimelineMessage')).toContainText(/loading/i);
    releaseHeld(); mode = 'real'; await expect(events).toHaveCount(history.length);
    await close('#pcnTimelineCloseButton');
    mode = 'error'; await open();
    await expect(dialog.locator('#pcnTimelineMessage')).toContainText('Timeline fixture unavailable');
    await expect(dialog.locator('#pcnTimelineRefreshButton')).toBeEnabled();
    mode = 'real'; await dialog.locator('#pcnTimelineRefreshButton').click(); await expect(events).toHaveCount(history.length);
    await close('#pcnTimelineCloseButton');
    mode = 'empty'; await open(); await expect(events).toHaveCount(0);
    await expect(dialog.locator('#pcnTimelineMessage')).toContainText(/no .*history|no .*events|no .*changes|no .*revision/i);
    await close('#pcnTimelineCloseButton'); mode = 'real';
    report.checks.push('Held load shows status, failed history can retry, and empty history is explicit');

    await page.setViewportSize({ width: 390, height: 844 });
    await open(); await expect(events).toHaveCount(history.length); await fit(page, dialog);
    const track = dialog.locator('#pcnTimelineTrack');
    const geometry = await track.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, overflow: getComputedStyle(node).overflowX }));
    assert(geometry.scrollWidth > geometry.width && ['auto', 'scroll'].includes(geometry.overflow), 'Mobile timeline scrolls internally');
    await events.first().click(); await expect(events.first()).toHaveAttribute('aria-pressed', 'true');
    await track.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    assert(await track.evaluate(node => node.scrollLeft > 0), 'Timeline scroll position changes');
    await events.last().click(); await expect(events.last()).toHaveAttribute('aria-pressed', 'true');
    await expect(details).toContainText('Timeline Supplier 9'); await fit(page, dialog);
    await page.screenshot({ path: path.resolve('test-results/timeline-mobile.png') });
    await close('#pcnTimelineCloseButton');
    report.checks.push('390px modal fits viewport; horizontal timeline scrolls and both ends remain selectable');
    activeId = signed.id;
    await open(); await expect(events).toHaveCount(signingHistory.length);
    await expect(events.nth(1)).toContainText(/GSC\/TET\s*(?:—|–|-)?\s*Approved/);
    await expect(events.nth(1)).toContainText('Fixture GSC approved');
    await expect(events.last()).toContainText(/GSC\/TET\s*(?:—|–|-)?\s*Checked/);
    await expect(events.last()).toContainText('Fixture GSC checked');
    await events.last().click(); await expect(details).toContainText('Fixture GSC checked');
    await expect(details).toContainText(/Checked/);
    await expect(details).not.toContainText(signed.documentControl.contentHash);
    await expect(details).not.toContainText('fixture-checked');
    await fit(page, dialog);
    await page.screenshot({ path: path.resolve('test-results/timeline-signing-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 }); await fit(page, dialog);
    await page.screenshot({ path: path.resolve('test-results/timeline-signing-desktop.png') });
    await close('#pcnTimelineCloseButton');
    report.checks.push('Genuine assigned GSC Approved then Checked revisions show signer and department/action in simple nodes');
    assert.deepEqual(await repository.findById(record.id), record, 'Browser viewing never mutates PCN');
    assert.deepEqual(await repository.getRevisions(record.id), history, 'Browser viewing never mutates revision history');
    assert.deepEqual(await repository.findById(signed.id), signed, 'Timeline viewing never mutates signed PCN');
    assert.deepEqual(await repository.getRevisions(signed.id), signingHistory, 'Timeline viewing never mutates genuine signing history');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.message; process.exitCode = 1;
  } finally {
    releaseHeld();
    if (context) { await context.tracing.stop({ path: path.resolve('test-results/timeline-trace.zip') }); await context.close(); }
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.resolve('test-results/timeline-acceptance.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main();
