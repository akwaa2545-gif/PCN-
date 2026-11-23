// Loopback API, synthetic accounts and memory-only records. No SQL, mail or directory calls.
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
const output = name => path.resolve('test-results', `records-loading-${name}`);
const report = { storage: 'isolated_memory_only', checks: [], errors: [], external: [], forbidden: [], status: 'running' };
const checked = value => { report.checks.push(value); console.log(JSON.stringify({ recordsLoadingCheck: value })); };
const waitGate = gate => expect.poll(() => gate.observed).toBe(true);
const deferred = () => { let resolve; const promise = new Promise(ready => { resolve = ready; }); return { promise, resolve }; };
const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

async function artifacts() {
  await fs.writeFile(output('report.json'), JSON.stringify(report, null, 2));
  const cases = report.checks.map(name => `<testcase classname="records-loading" name="${xml(name)}"/>`);
  if (report.status === 'failed') cases.push(`<testcase classname="records-loading" name="acceptance"><failure>${xml(report.failure)}</failure></testcase>`);
  await fs.writeFile(output('junit.xml'), `<testsuite name="records-loading" tests="${cases.length}" failures="${Number(report.status === 'failed')}">${cases.join('')}</testsuite>`);
  await fs.writeFile(output('report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Records loading acceptance</title><h1>${report.status}</h1><p>Isolated memory fixtures; no operational writes.</p><ol>${report.checks.map(name => `<li>${xml(name)}</li>`).join('')}</ol>${report.failure ? `<pre>${xml(report.failure)}</pre>` : ''}</html>`);
}

async function fixtures() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const service = new PcnService(repository);
  for (const supplierName of ['Alpha loading fixture', 'Beta loading fixture']) {
    const record = service.normalizeInput({ ...unsignedPayload, documentType: undefined, status: 'submitted', supplierName });
    await repository.create({ ...record, ownerUserId: 'supplier-id', createdAt: '2026-11-23T00:00:00Z', updatedAt: '2026-11-23T00:00:00Z' }, 'Loading fixture');
  }
  const authService = fakeAuthService({ additionalUsers: [
    { username: 'viewer', employeeCode: '0800001', identityProvider: 'employee-code', roles: [], displayName: 'Loading Viewer' }
  ] });
  return { repository, service, authService };
}

async function open(browser, origin, username, contexts, kind = 'normal') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'no-preference' });
  const entry = { context, username, kind, gates: [] }; contexts.push(entry);
  await context.tracing.start({ screenshots: true, snapshots: true });
  const state = { next: null, reads: 0 };
  const hold = (response = 'normal') => {
    assert.equal(state.next, null, 'Only one queued overview response is held at a time');
    const release = deferred(), seen = deferred();
    const gate = { response, release, seen, observed: false }; state.next = gate; entry.gates.push(gate); return gate;
  };
  const initial = hold(kind);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
    if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
    if (url.pathname === '/api/admin/notifications/health') return route.fulfill({ json: { success: true, data: { configuration: { status: 'not_configured' }, worker: { status: 'disabled' }, queue: {} } } });
    if (!['GET', 'HEAD'].includes(request.method()) || /\/notifications(?:\/|$)/.test(url.pathname)
      || ['/api/admin/directory-users', '/api/admin/employees'].includes(url.pathname)) {
      report.forbidden.push(`${request.method()} ${url.pathname}`); return route.abort();
    }
    if (url.pathname === '/api/pcns/overview') {
      state.reads += 1;
      const gate = state.next; state.next = null;
      if (gate) {
        gate.observed = true; gate.seen.resolve(); await gate.release.promise;
        if (gate.response === 'empty') return route.fulfill({ json: { success: true, data: { items: [] } } });
        if (gate.response === 'error') return route.fulfill({ status: 503, json: { success: false, error: 'Loading fixture temporarily unavailable' } });
        if (gate.response === 'revoke') return route.fulfill({ status: 403, json: { success: false, error: 'Loading fixture access revoked' } });
      }
    }
    return route.continue();
  });
  const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username, password: TEST_PASSWORD } });
  assert.equal(login.status(), 200);
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`${origin}/${username === 'viewer' ? 'records' : 'admin'}`, { waitUntil: 'domcontentloaded' });
  await waitGate(initial);
  const host = page.locator(username === 'viewer' ? '#recordsWorkspace' : '#pcnAdminView');
  const refresh = page.locator(username === 'viewer' ? '#recordsRefreshButton' : '#adminRefreshButton');
  const search = page.locator(username === 'viewer' ? '#recordsSearch' : '#adminSearchInput');
  return { page, context, host, refresh, search, hold, initial, state, username,
    async finish() { await context.tracing.stop({ path: output(`trace-${contexts.indexOf(entry) + 1}.zip`) }); entry.traceStopped = true; await context.close(); },
    rows: () => host.locator('tr[data-pcn-id]'),
    skeleton: () => host.locator('tr.rd-skeleton-row'),
    status: () => host.locator('.rd-loading-status'),
    overlay: () => host.locator('#rdRecordsLoadingOverlay'),
    panel: () => host.locator('#rdRecordsPanel') };
}

async function animationState(page) {
  return page.locator('.rd-loading-spinner,.rd-skeleton-line').evaluateAll(nodes => nodes.map(node => ({
    className: node.className,
    animations: ['', '::before', '::after'].map(pseudo => getComputedStyle(node, pseudo || null).animationName)
  })));
}

async function centeredSpinner(view, width, scrolled) {
  await view.panel().scrollIntoViewIfNeeded();
  await expect(view.host.locator('.rd-loading-spinner')).toBeVisible();
  const table = await view.panel().evaluate(element => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: element.clientWidth, height: element.clientHeight, scrollLeft: element.scrollLeft };
  });
  const spinner = await view.host.locator('.rd-loading-spinner').boundingBox();
  assert(spinner && spinner.width > 0 && spinner.height > 0);
  const expectedX = table.x + table.width / 2, expectedY = table.y + table.height / 2;
  const actualX = spinner.x + spinner.width / 2, actualY = spinner.y + spinner.height / 2;
  assert(Math.abs(actualX - expectedX) <= 4, 'Spinner stays horizontally centered in the visible table viewport');
  assert(Math.abs(actualY - expectedY) <= Math.max(12, table.height * .04), 'Spinner sits in the middle of the table height');
  assert(actualX >= 0 && actualX <= width && actualY >= 0 && actualY <= await view.page.evaluate(() => innerHeight), 'Centered spinner is visible in the browser viewport');
  report.geometry = [...(report.geometry || []), { username: view.username, width, scrolled, table, spinner }];
}

async function initialAndRefresh(browser, origin, username, contexts) {
  const view = await open(browser, origin, username, contexts);
  const { page, host, initial } = view;
  await expect(host).toBeVisible(); await expect(view.skeleton()).toHaveCount(5);
  await expect(view.skeleton().first()).toHaveAttribute('aria-hidden', 'true');
  await expect(view.overlay()).toBeVisible(); await expect(view.status()).toBeVisible(); await expect(view.status()).toHaveAttribute('role', 'status');
  await expect(view.panel()).toHaveAttribute('aria-busy', 'true');
  assert.equal(await view.skeleton().first().locator('td').count(), await view.panel().locator('thead th').count());
  await expect(host.locator('.records-empty')).toHaveCount(0);
  await expect(page.locator(username === 'viewer' ? '#recordsCount' : '#adminCount')).toHaveText('—');
  const normal = await animationState(page);
  assert(normal.some(item => item.className.includes('spinner') && item.animations.some(name => name !== 'none')), 'Spinner rotates in normal motion');
  assert(normal.some(item => item.className.includes('skeleton') && item.animations.some(name => name !== 'none')), 'Skeleton shimmers in normal motion');
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 844 : 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Loading UI fits the viewport');
    await centeredSpinner(view, width, false);
    await view.panel().evaluate(element => { element.scrollLeft = element.scrollWidth - element.clientWidth; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await centeredSpinner(view, width, true);
    await view.panel().evaluate(element => { element.scrollLeft = 0; });
    await page.screenshot({ path: output(`${username}-${width === 320 ? 'mobile' : 'desktop'}.png`), fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await animationState(page);
  assert(reduced.length > 0 && reduced.every(item => item.animations.every(name => name === 'none')), 'Reduced motion stops every spinner and shimmer animation');
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.setViewportSize({ width: 1440, height: 1000 });
  initial.release.resolve(); await expect(view.rows()).toHaveCount(2);
  await expect(view.skeleton()).toHaveCount(0); await expect(view.overlay()).toBeHidden(); await expect(view.status()).toBeHidden();
  await expect(view.panel()).toHaveAttribute('aria-busy', 'false');
  checked(`${username}: initial skeleton matches table columns, accessible status/busy state, desktop/mobile layout and reduced motion`);

  const filters = host.locator('#rdFiltersToggle'), advanced = host.locator('#rdAdvancedFilters');
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 844 : 1000 });
    await expect(filters).toBeVisible(); await expect(filters).toHaveAttribute('aria-expanded', 'false');
    await expect(filters).toHaveAttribute('aria-controls', 'rdAdvancedFilters'); await expect(advanced).toBeHidden();
    await expect(view.search).toBeVisible();
    if (username === 'admin') for (const selector of ['#adminStatusFilter', '#adminRiskFilter']) { await expect(host.locator(selector)).toBeHidden(); await expect(advanced.locator(selector)).toHaveCount(1); }
    await page.screenshot({ path: output(`${username}-filters-collapsed-${width}.png`), fullPage: true });
    await filters.focus(); await filters.press('Enter');
    await expect(filters).toHaveAttribute('aria-expanded', 'true'); await expect(advanced).toBeVisible();
    if (username === 'admin') for (const selector of ['#adminStatusFilter', '#adminRiskFilter']) await expect(advanced.locator(selector)).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Expanded filters fit the viewport');
    await host.locator('#rdFilter-supplier').selectOption('Alpha loading fixture');
    await page.screenshot({ path: output(`${username}-filters-expanded-${width}.png`), fullPage: true });
    await filters.focus(); await filters.press('Space');
    await expect(filters).toHaveAttribute('aria-expanded', 'false'); await expect(advanced).toBeHidden();
    await expect(host.locator('#rdFilter-supplier')).toHaveValue('Alpha loading fixture');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await view.search.fill('Alpha'); await expect(view.rows()).toHaveCount(1);
  // Start the manual hold just after a completed poll, so a timer cannot steal its gate.
  await (await page.waitForResponse(response => new URL(response.url()).pathname === '/api/pcns/overview')).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await view.rows().first().evaluate(row => { row.dataset.loadingIdentity = 'retained'; });
  const manual = view.hold(); await view.refresh.click(); await waitGate(manual);
  await expect(view.overlay()).toBeVisible(); await expect(view.status()).toBeVisible(); await expect(view.status()).toContainText(/refreshing/i);
  await expect(view.skeleton()).toHaveCount(0); await expect(view.rows()).toHaveCount(1);
  await expect(view.rows().first()).toHaveAttribute('data-loading-identity', 'retained');
  await expect(view.search).toHaveValue('Alpha');
  manual.release.resolve(); await expect(view.overlay()).toBeHidden(); await expect(view.status()).toBeHidden(); await expect(view.refresh).toBeEnabled();
  await expect(view.search).toHaveValue('Alpha'); await expect(view.rows()).toHaveCount(1);
  checked(`${username}: explicit refresh keeps real records and filter values visible with a compact spinner`);
  await expect(filters).toHaveAttribute('aria-expanded', 'false'); await expect(advanced).toBeHidden();
  await filters.focus(); await filters.press('Enter');
  await expect(advanced).toBeVisible(); await expect(host.locator('#rdFilter-supplier')).toHaveValue('Alpha loading fixture');
  await filters.press('Space'); await expect(advanced).toBeHidden();
  checked(`${username}: filters start collapsed, expand by keyboard, and preserve active choices while collapsed across refresh`);

  await view.rows().first().evaluate(row => { row.dataset.loadingIdentity = 'quiet'; });
  const quiet = view.hold(); await waitGate(quiet);
  await expect(view.overlay()).toBeHidden(); await expect(view.status()).toBeHidden(); await expect(view.skeleton()).toHaveCount(0);
  await expect(view.rows().first()).toHaveAttribute('data-loading-identity', 'quiet');
  const quietResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pcns/overview');
  quiet.release.resolve(); await (await quietResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await expect(view.rows().first()).toHaveAttribute('data-loading-identity', 'quiet');
  checked(`${username}: normal background polling leaves loading UI hidden and preserves unchanged row identity`);

  await filters.focus(); await filters.press('Enter'); await expect(advanced).toBeVisible();
  const revoked = view.hold('revoke'); await view.refresh.click(); await waitGate(revoked); revoked.release.resolve();
  await expect(view.rows()).toHaveCount(0); await expect(view.skeleton()).toHaveCount(0); await expect(view.overlay()).toBeHidden(); await expect(view.status()).toBeHidden();
  await expect(filters).toHaveAttribute('aria-expanded', 'false'); await expect(advanced).toBeHidden();
  if (username === 'viewer') await expect(host).toBeHidden();
  await expect(page.locator(username === 'viewer' ? '#recordsGateError' : '#adminNotice')).toContainText(/access|revoked/i);
  checked(`${username}: revoked access clears both data and loading presentation`);
  await view.finish();
}

async function errorAndEmpty(browser, origin, username, contexts) {
  const failed = await open(browser, origin, username, contexts, 'error');
  await expect(failed.skeleton()).toHaveCount(5); failed.initial.release.resolve();
  await expect(failed.skeleton()).toHaveCount(0); await expect(failed.overlay()).toBeHidden(); await expect(failed.status()).toBeHidden();
  await expect(failed.panel()).toHaveAttribute('aria-busy', 'false');
  await expect(failed.host.locator('.rd-load-error')).toBeVisible(); await expect(failed.refresh).toBeEnabled();
  await expect(failed.host.locator('.records-empty:not(.rd-load-error)')).toHaveCount(0);
  const retry = failed.hold(); await failed.refresh.click(); await waitGate(retry);
  await expect(failed.skeleton()).toHaveCount(5); retry.release.resolve();
  await expect(failed.rows()).toHaveCount(2); await expect(failed.host.locator('.rd-load-error')).toHaveCount(0);
  checked(`${username}: failed first load removes skeleton, exposes retry, and retry returns real records`);
  await failed.finish();

  const empty = await open(browser, origin, username, contexts, 'empty');
  empty.initial.release.resolve(); await expect(empty.skeleton()).toHaveCount(0);
  await expect(empty.overlay()).toBeHidden(); await expect(empty.status()).toBeHidden(); await expect(empty.panel()).toHaveAttribute('aria-busy', 'false');
  await expect(empty.host.locator('.records-empty')).toContainText(/no PCN records/i);
  await expect(empty.rows()).toHaveCount(0);
  checked(`${username}: actual empty response replaces skeleton with the empty-document state`);
  await empty.finish();
}

async function main() {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const fixture = await fixtures(), before = await fixture.repository.list();
  const server = http.createServer(), contexts = [];
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ ...fixture, rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    for (const username of ['viewer', 'admin']) {
      await initialAndRefresh(browser, origin, username, contexts);
      await errorAndEmpty(browser, origin, username, contexts);
    }
    assert.deepEqual(await fixture.repository.list(), before);
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.stack || error.message;
    for (const [index, entry] of contexts.entries()) {
      const page = entry.context.pages()[0];
      if (page && !page.isClosed()) await page.screenshot({ path: output(`failure-${index + 1}.png`), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    for (const [index, entry] of contexts.entries()) {
      entry.gates.forEach(gate => gate.release.resolve());
      if (!entry.traceStopped) await entry.context.tracing.stop({ path: output(`trace-${index + 1}.zip`) }).catch(() => {});
      await entry.context.close().catch(() => {});
    }
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await artifacts(); console.log(JSON.stringify(report));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
