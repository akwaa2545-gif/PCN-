// Loopback-only fixtures: this suite never loads SQL or a notification worker.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect: baseExpect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const { mailGroups } = require('../src/mailRouting');
const masterData = require('../src/masterData');
const expect = baseExpect.configure({ timeout: 10000 });
const compatibilityOnly = process.argv.includes('--compatibility-only');
const nativeSelectOnly = process.argv.includes('--native-select-only');
const usersLayoutOnly = process.argv.includes('--users-layout-only');
const recordsDensityOnly = process.argv.includes('--records-density-only');
const artifactSuffix = compatibilityOnly ? '-compatibility' : nativeSelectOnly ? '-native-select' : usersLayoutOnly ? '-users-layout' : recordsDensityOnly ? '-records-density' : '';
const report = { storage: 'isolated_memory_only', checks: [], errors: [], external: [], forbidden: [] };

// Sample the browser's rendered frames, rather than trusting CSS declarations.
async function frames(surface, action) {
  return surface.evaluate(async (node, command) => {
    const samples = [];
    const act = () => command.kind === 'escape'
      ? document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      : (() => { const control = document.querySelector(command.selector); control.focus(); control.click(); })();
    const capture = () => {
      const style = getComputedStyle(node);
      samples.push({ opacity: Number(style.opacity), displayed: style.display !== 'none', time: performance.now(), text: node.textContent, logicalClosed: node.tagName === 'DIALOG' ? !node.open : node.hidden, noninteractive: node.tagName === 'DIALOG' ? !node.open : node.inert });
    };
    act(); capture();
    const until = performance.now() + 330;
    while (performance.now() < until) { await new Promise(requestAnimationFrame); capture(); }
    return samples;
  }, action);
}
async function fade(surface, action, opening, label, preservedText) {
  const samples = await frames(surface, action);
  report.motion ||= []; report.motion.push({ label, opening, frames: samples.map(({time, opacity, displayed}) => ({time, opacity, displayed})) });
  assert(samples.some(frame => frame.displayed && frame.opacity > 0.02 && frame.opacity < 0.98), `${label} has a rendered intermediate opacity on ${opening ? 'entry' : 'exit'}`);
  if (preservedText) assert(samples.some(frame => frame.displayed && frame.opacity > 0.02 && frame.opacity < 0.98 && frame.text.includes(preservedText)), `${label} retains its visible content during exit`);
  if (!opening) assert(samples[0].logicalClosed && samples[0].noninteractive, `${label} closes logically and becomes noninteractive before its exit finishes`);
  const final = samples.at(-1);
  if (opening) { assert(final.displayed && final.opacity > 0.98, `${label} finishes visible`); await expect(surface).toBeVisible(); }
  else { assert(!final.displayed, `${label} finishes removed from layout`); await expect(surface).toBeHidden(); }
}
// Sample concurrently with trusted input: synthetic .click() cannot open an OS picker.
async function pickerFrames(select, action) {
  const reading = select.evaluate(async node => {
    const samples = [], initialOpen = node.matches(':open');
    let deadline = performance.now() + 1600, observedChange = false;
    while (performance.now() < deadline) {
      if (!observedChange && node.matches(':open') !== initialOpen) { observedChange = true; deadline = performance.now() + 360; }
      const style = getComputedStyle(node, '::picker(select)');
      samples.push({ opacity: Number(style.opacity), open: node.matches(':open'), display: style.display, time: performance.now() });
      await new Promise(requestAnimationFrame);
    }
    return samples;
  });
  await action(); return reading;
}
async function pickerFade(select, action, opening, label) {
  const samples = await pickerFrames(select, action);
  report.pickers ||= []; report.pickers.push({ label, opening, frames: samples });
  assert(samples.some(frame => frame.opacity > 0.02 && frame.opacity < 0.98), label + ' renders intermediate picker opacity on ' + (opening ? 'entry' : 'exit'));
  assert.equal(samples.at(-1).open, opening, label + ' finishes in its expected open state');
  if (opening) assert(samples.at(-1).opacity > 0.98, label + ' finishes opaque');
}
async function fit(page, surface, label) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: no document horizontal overflow`);
  if (surface) assert(await surface.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1 && node.scrollWidth <= node.clientWidth + 1; }), `${label}: popup fits viewport without horizontal overflow`);
}
function laptopUsers() {
  return Array.from({ length: 10 }, (_, index) => {
    const id = 'laptop-user-' + index, email = 'fixture.' + index + '.supplier.quality.and.process.engineering@example.test';
    const developer = index === 3, pending = index >= 8;
    const department = developer ? 'developer' : index <= 1 ? 'it' : index === 5 ? 'qaTet' : index === 6 ? 'prodEngTet' : index === 7 ? 'qaTapbu' : 'gscTet';
    const departmentRole = { qaTet: 'qa', prodEngTet: 'productionengineering', qaTapbu: 'tapbu' }[department] || 'gsc';
    return { id, username: id, employeeCode: index === 0 ? null : String(7100000 + index),
      displayName: 'Fixture ' + index + ' Long Employee Name for Cross Functional Supplier Quality Engineering',
      email, mailProfile: { id: 'mail-' + id, displayName: 'Directory ' + index, email, jobTitle: 'Senior supplier process quality engineering specialist', department: 'International Manufacturing Quality and Engineering' },
      roles: pending ? [] : developer ? ['developer'] : index <= 1 ? ['admin'] : index === 4 ? ['reviewer'] : [departmentRole],
      department, signingStep: pending || developer || index <= 1 || index === 4 ? null : ['prepared', 'checked', 'approved'][index % 3],
      identityProvider: [0, 4].includes(index) ? 'password' : [1, 9].includes(index) ? 'pcn-local' : 'employee-code',
      isActive: index !== 9, version: '0000000000000001', presence: { status: index === 4 ? 'unavailable' : index % 2 ? 'offline' : 'online' } };
  });
}
async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const service = new PcnService(repository);
  const admin = { id: 'admin-id', displayName: 'Motion Fixture Administrator', roles: ['admin'] };
  await service.create({ ...unsignedPayload, status: 'draft', supplierName: 'Responsive motion supplier', materialName: 'Fixture material' }, admin.displayName, admin);
  if (recordsDensityOnly) for (let index = 1; index <= 4; index++) await service.create({ ...unsignedPayload, status: 'draft', supplierName: 'Fixture Supplier ' + index, materialName: 'Copper alloy material ' + index }, admin.displayName, admin);
  const before = await repository.list();
  const settings = { schemaVersion: 2, version: 'motion-v1', directoryConfigured: true, flowConfigured: false, legacyGroups: [], groups: mailGroups.map(group => ({ ...group, emails: '', recipients: [], automaticRecipients: [] })) };
  const server = http.createServer(); let browser, context;
  try {
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, service, authService: fakeAuthService(), rootDir: path.resolve(__dirname, '..'), publicOrigin: origin, secureCookies: false }));
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true });
    if (compatibilityOnly) await context.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...args) => args.some(value => String(value).includes('transition-behavior') || String(value).includes('allow-discrete')) ? false : supports(...args);
    });
    const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username: 'admin', password: TEST_PASSWORD } });
    assert.equal(login.status(), 200);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
      if (compatibilityOnly && url.pathname.endsWith('.css')) {
        // Model a browser which does not parse allow-discrete rules. Merely stubbing
        // CSS.supports would leave modern Chromium's CSS engine applying the guard.
        const file = path.join(__dirname, '..', path.basename(url.pathname));
        const source = await fs.readFile(file, 'utf8');
        return route.fulfill({ contentType: 'text/css', body: source.replaceAll('@supports (transition-behavior: allow-discrete)', '@supports (transition-behavior: fixture-unsupported)') });
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const send = data => route.fulfill({ json: { success: true, data } });
      if (!['GET', 'HEAD'].includes(request.method())) { report.forbidden.push({ method: request.method(), path: url.pathname }); return route.abort(); }
      if (url.pathname === '/api/profile') return send({ status: 'unavailable' });
      if (url.pathname === '/api/auth/config') return send({ mode: 'password', employeeProvisioningConfigured: true });
      if (url.pathname === '/api/admin/users') return send(usersLayoutOnly ? laptopUsers() : []);
      if (url.pathname === '/api/notification-settings') return send(settings);
      if (url.pathname === '/api/admin/notifications/health') return send({ configuration: { status: 'not_configured' }, worker: {}, queue: {} });
      if (url.pathname === '/api/admin/employees') return send(Array.from({ length: 30 }, (_, index) => ({ employeeCode: String(7000000 + index), displayName: `Motion employee ${index}`, englishName: `Motion employee ${index}`, jobTitle: 'Fixture engineer', sourceDepartment: 'Fixture' })));
      if (url.pathname === '/api/admin/directory-users') return send({ users: Array.from({ length: 25 }, (_, index) => ({ displayName: `Motion contact ${index}`, email: `motion${index}@example.test`, jobTitle: 'Fixture engineer', department: 'Fixture', photo: '' })) });
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`${origin}/admin`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.account-trigger')).toBeVisible();
    if (recordsDensityOnly) {
      await expect(page.locator('#adminPcnRows tr')).toHaveCount(5);
      // The density target must include the extra navigation visible to a Developer.
      // Showing an existing link changes only this isolated page's geometry.
      await page.locator('#adminDeveloperLink').evaluate(node => { node.hidden = false; });
      await page.evaluate(() => document.fonts.ready);
      const failures = [], verify = (condition, message) => { if (!condition) failures.push(message); };
      const wrapper = page.locator('#pcnAdminView .admin-table-wrap');
      report.recordsDensity = [];
      for (const viewport of [{ width: 1536, height: 864 }, { width: 1366, height: 768 }, { width: 1280, height: 720 }]) {
        await page.setViewportSize(viewport); await page.mouse.move(0, viewport.height - 1);
        await expect(page.locator('#createStartOptions')).toBeHidden();
        await wrapper.evaluate(node => { node.scrollLeft = 0; });
        const firstRow = page.locator('#adminPcnRows tr').first();
        await firstRow.locator('[data-column="status"]').click();
        await expect(firstRow).toHaveAttribute('aria-selected', 'true');
        const metrics = await page.evaluate(() => {
          const workspace = document.querySelector('#pcnAdminView .admin-workspace');
          const pane = workspace.querySelector(':scope > .admin-panel'), side = workspace.querySelector('.admin-detail-panel');
          const left = pane.getBoundingClientRect(), right = side.getBoundingClientRect();
          const wrap = pane.querySelector('.admin-table-wrap'), table = wrap.querySelector('table');
          const controls = [...pane.querySelectorAll('.admin-table-toolbar input, .admin-table-toolbar select, .rd-filters input, .rd-filters select')];
          const filterControls = [...pane.querySelectorAll('.rd-filters input, .rd-filters select')];
          const cells = [...table.querySelectorAll('tbody tr:first-child td')];
          const nav = [...document.querySelectorAll('.topbar-actions > button:not([hidden]), .topbar-actions > a:not([hidden]), .create-start-dropdown, .account-trigger')];
          return { viewport: innerWidth, body: document.documentElement.scrollWidth, htmlZoom: getComputedStyle(document.documentElement).zoom, bodyZoom: getComputedStyle(document.body).zoom, scale: visualViewport.scale,
            twoColumns: right.left >= left.right - 1 && Math.abs(right.top - left.top) <= 1, sidebar: right.width, sidebarOverflow: side.scrollWidth > side.clientWidth + 1,
            topbar: document.querySelector('.topbar').getBoundingClientRect().height, navFits: nav.every(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }),
            filterCount: filterControls.length, filterRows: new Set(filterControls.map(control => Math.round(control.getBoundingClientRect().bottom))).size,
            maxInputHeight: Math.max(...controls.map(control => control.getBoundingClientRect().height)),
            header: table.querySelector('thead').getBoundingClientRect().height,
            maxCellPadding: Math.max(...cells.map(cell => Math.max(parseFloat(getComputedStyle(cell).paddingTop), parseFloat(getComputedStyle(cell).paddingBottom)))),
            minFont: Math.min(...cells.map(cell => parseFloat(getComputedStyle(cell).fontSize))),
            supplierFont: parseFloat(getComputedStyle(cells.find(cell => cell.dataset.column === 'supplierName')).fontSize),
            materialFont: parseFloat(getComputedStyle(cells.find(cell => cell.dataset.column === 'materialName')).fontSize),
            containedScroll: wrap.scrollWidth > wrap.clientWidth && ['auto', 'scroll'].includes(getComputedStyle(wrap).overflowX),
            tableColumns: cells.length, allColumnsVisible: cells.every(cell => getComputedStyle(cell).display !== 'none') };
        });
        report.recordsDensity.push(metrics); const label = viewport.width + 'px Records';
        verify(metrics.htmlZoom === '1' && metrics.bodyZoom === '1' && metrics.scale === 1, label + ' uses the normal 100% viewport without CSS or browser zoom');
        verify(metrics.body <= viewport.width + 1, label + ' contains horizontal scrolling inside the record list');
        verify(metrics.twoColumns && metrics.sidebar >= 270 && metrics.sidebar <= 290, label + ' keeps a 270-290px selected-document sidebar beside the table');
        verify(!metrics.sidebarOverflow, label + ' selected-document sidebar contents fit');
        verify(metrics.topbar <= 76 && metrics.navFits, label + ' complete Developer navigation fits in a compact header');
        verify(metrics.filterCount === 5 && metrics.filterRows === 1, label + ' keeps all five additional filters on one row');
        verify(metrics.maxInputHeight <= 38, label + ' filter controls are at most 38px high');
        verify(metrics.header <= 44 && metrics.maxCellPadding <= 12, label + ' table headers and cell spacing retain compact density');
        verify(metrics.minFont >= 12 && metrics.supplierFont >= 14 && metrics.materialFont >= 14, label + ' preserves legible table and Supplier/Material type');
        verify(metrics.containedScroll && metrics.allColumnsVisible && metrics.tableColumns >= 10, label + ' preserves every column in a contained horizontal table');
        const open = firstRow.locator('.rd-open-button'); await open.focus();
        verify(await open.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('a') === node; }), label + ' Open PCN remains reachable in the code column');
        await expect(open).toHaveAttribute('href', new RegExp(await firstRow.getAttribute('data-pcn-id')));
        await wrapper.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        for (const control of await firstRow.locator('.rd-secondary-actions button, .rd-secondary-actions summary').all()) verify(await control.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button, summary') === node; }), label + ' secondary action icons remain reachable');
        const quick = firstRow.locator('.rd-preview-button'); await quick.click(); await expect(page.locator('#rdPreviewDialog')).toHaveJSProperty('open', true);
        await page.locator('#rdPreviewDialog [aria-label="Close preview"]').click(); await expect(page.locator('#rdPreviewDialog')).toBeHidden();
        await wrapper.evaluate(node => { node.scrollLeft = 0; });
        await page.screenshot({ path: path.resolve('test-results/motion-ui-records-density-' + viewport.width + '.png') });
      }
      await page.setViewportSize({ width: 1024, height: 768 }); await page.mouse.move(0, 767);
      verify(await page.locator('#pcnAdminView .admin-workspace').evaluate(node => { const main = node.querySelector(':scope > .admin-panel').getBoundingClientRect(), side = node.querySelector('.admin-detail-panel').getBoundingClientRect(); return side.top >= main.bottom - 1 && document.documentElement.scrollWidth <= innerWidth; }), '1024px Records keeps the stacked layout without whole-page overflow');
      assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []); assert.deepEqual(await repository.list(), before);
      if (failures.length) throw new Error(failures.join('; '));
      report.checks.push('Records has compact 100% density with full Developer navigation, five filters, a right sidebar and reachable actions at 1536/1366/1280; 1024 retains stacking');
      report.status = 'passed'; return;
    }
    if (usersLayoutOnly) {
      await page.locator('#adminUsersButton').click();
      await expect(page.locator('#adminUsersRows tr')).toHaveCount(8);
      await expect(page.locator('#pendingUsersRows tr')).toHaveCount(2);
      await page.evaluate(() => document.fonts.ready);
      const failures = [], verify = (condition, message) => { if (!condition) failures.push(message); };
      report.usersLayouts = [];
      const wrapper = page.locator('.users-table-wrap').filter({ has: page.locator('#adminUsersRows') });
      for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }]) {
        await page.setViewportSize(viewport);
        // Resizing can place a stationary cursor over Create's hover menu. A real
        // row interaction moves the cursor away from navigation before clicking.
        await page.mouse.move(0, viewport.height - 1);
        await expect(page.locator('#createStartOptions')).toBeHidden();
        await wrapper.evaluate(node => { node.scrollLeft = 0; });
        const metrics = await wrapper.evaluate(node => {
          const table = node.querySelector('table'), cells = [...table.querySelector('tbody tr').cells];
          const badge = cells[2].querySelector('.user-access-badge'), range = document.createRange(); range.selectNodeContents(badge);
          const rows = [...new Set([...document.querySelectorAll('.users-filters input, .users-filters select, #usersClearFiltersButton')].map(control => Math.round(control.getBoundingClientRect().bottom)))];
          const text = cells[1].querySelector('.notification-person-identity');
          const legacyBadge = [...table.querySelectorAll('tbody td:nth-child(3) .user-access-badge')].find(badge => badge.textContent === 'No signing assignment');
          const legacyCell = legacyBadge?.closest('td');
          const departmentBadge = [...table.querySelectorAll('tbody td:nth-child(4) .user-access-badge')].find(badge => badge.textContent === 'Prod.Eng/TET');
          const presenceBadge = [...table.querySelectorAll('.user-presence-badge')].find(badge => badge.textContent === 'Unavailable');
          const fitsCell = badge => Boolean(badge) && badge.scrollWidth <= badge.clientWidth + 1 && badge.getBoundingClientRect().right <= badge.closest('td').getBoundingClientRect().right + 1;
          const signInCell = cells[7], signInText = signInCell.firstChild;
          const signInWordsWhole = ['Password', 'maintenance'].every(word => {
            const start = signInCell.textContent.indexOf(word); if (start < 0 || signInText?.nodeType !== Node.TEXT_NODE) return false;
            const wordRange = document.createRange(); wordRange.setStart(signInText, start); wordRange.setEnd(signInText, start + word.length);
            const fragments = [...wordRange.getClientRects()]; return fragments.length === 1 && fragments[0].right <= signInCell.getBoundingClientRect().right + 1;
          });
          return { viewport: innerWidth, body: document.documentElement.scrollWidth, table: table.getBoundingClientRect().width, wrapper: node.clientWidth,
            actions: cells.at(-1).getBoundingClientRect().width, actionPosition: getComputedStyle(cells.at(-1)).position,
            filterRows: rows.length, badgeLines: range.getClientRects().length, badgeOverflow: badge.scrollWidth > badge.clientWidth + 1,
            signInWordsWhole, departmentBadgeFits: fitsCell(departmentBadge), presenceBadgeFits: fitsCell(presenceBadge),
            legacyBadgeFits: Boolean(legacyBadge) && legacyBadge.scrollWidth <= legacyBadge.clientWidth + 1 && legacyBadge.getBoundingClientRect().right <= legacyCell.nextElementSibling.getBoundingClientRect().left + 1,
            font: Number.parseFloat(getComputedStyle(text).fontSize), coreColumns: cells.map(cell => getComputedStyle(cell).display !== 'none'),
            horizontalScroller: ['auto', 'scroll'].includes(getComputedStyle(node).overflowX),
            textClipped: getComputedStyle(text).textOverflow === 'ellipsis' || text.scrollHeight > text.clientHeight + 1 };
        });
        report.usersLayouts.push(metrics); const label = viewport.width + 'px Users';
        verify(metrics.body <= viewport.width + 1, label + ' has no whole-page horizontal overflow');
        verify(metrics.table <= 1240, label + ' populated table stays near 1200px rather than growing beyond 1500px');
        verify(metrics.actions <= 170, label + ' sticky Actions occupies at most 170px');
        verify(metrics.actionPosition === 'sticky', label + ' Actions stays reachable while other columns scroll');
        verify(metrics.filterRows <= 2, label + ' search and filters fit at most two rows');
        verify(metrics.badgeLines === 1 && !metrics.badgeOverflow, label + ' Administrator badge remains one readable line');
        verify(metrics.signInWordsWhole, label + ' Password maintenance wraps only between whole words');
        verify(metrics.departmentBadgeFits, label + ' Prod.Eng/TET badge fits its department column');
        verify(metrics.presenceBadgeFits, label + ' Unavailable presence fits its status column');
        verify(metrics.legacyBadgeFits, label + ' legacy No signing assignment remains fully readable inside its role column');
        verify(metrics.font >= 14, label + ' employee names preserve the established 14px minimum without shrinking');
        verify(metrics.coreColumns.length === 9 && metrics.coreColumns.every(Boolean), label + ' preserves every core column');
        verify(!metrics.textClipped, label + ' preserves long employee names without ellipsis or clipping');
        verify(metrics.horizontalScroller, label + ' confines any horizontal scrolling to the table wrapper');
        for (const user of laptopUsers()) {
          const row = page.locator('tr').filter({ has: page.locator('[data-user-id="' + user.id + '"]') });
          await expect(row).toContainText(user.displayName); await expect(row).toContainText(user.mailProfile.email);
        }
        const maintenance = page.locator('#adminUsersRows tr').filter({ has: page.locator('[data-user-id="laptop-user-0"]') });
        await expect(maintenance.locator('[data-user-action]')).toHaveCount(3);
        await maintenance.evaluate(node => node.scrollIntoView({ block: 'center' }));
        await wrapper.evaluate(node => { node.scrollLeft = 0; });
        for (const action of ['link', 'edit', 'remove']) {
          const control = maintenance.locator('[data-user-action="' + action + '"]');
          await expect(control).toBeEnabled(); await control.focus();
          const geometry = await control.evaluate(node => { const box = node.getBoundingClientRect(), wrap = node.closest('.users-table-wrap').getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); return { passed: box.left >= wrap.left && box.right <= Math.min(wrap.right, innerWidth) && box.top >= 0 && box.bottom <= innerHeight && hit?.closest('button') === node, button: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, wrapper: { left: wrap.left, right: wrap.right }, hit: { tag: hit?.tagName, id: hit?.id, class: hit?.className }, viewport: { width: innerWidth, height: innerHeight }, tableScroll: node.closest('.users-table-wrap').scrollLeft, pageScroll: scrollY }; });
          report.userActionBounds ||= []; report.userActionBounds.push({ width: viewport.width, action, ...geometry });
          verify(geometry.passed, label + ' ' + action + ' action is reachable without horizontal scrolling');
        }
        const documentBefore = await page.evaluate(() => document.documentElement.scrollLeft);
        await wrapper.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        verify(await page.evaluate(() => document.documentElement.scrollLeft) === documentBefore, label + ' table scrolling does not scroll the page');
        await wrapper.evaluate(node => { node.scrollLeft = 0; });
        await page.screenshot({ path: path.resolve('test-results/motion-ui-users-layout-' + viewport.width + '.png') });
      }
      const developerActions = page.locator('[data-user-id="laptop-user-3"]');
      for (const control of await developerActions.all()) await expect(control).toBeDisabled();
      assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
      assert.deepEqual(await repository.list(), before);
      if (failures.length) throw new Error(failures.join('; '));
      report.checks.push('Ten populated Users fixtures keep all content and established 14px names, narrow reachable sticky actions, one-line role badges and at most two filter rows on 1366/1280/1024px laptops');
      report.status = 'passed'; return;
    }
    if (nativeSelectOnly) {
      assert.equal(await page.evaluate(() => CSS.supports('appearance', 'base-select')), true, 'Bundled browser supports progressive native select styling');
      const failures = [];
      await page.evaluate(() => { window.__pickerKeys = []; document.addEventListener('keydown', event => { if (event.key === 'Escape') window.__pickerKeys.push({ target: event.target.tagName, id: event.target.id, selectOpen: event.target.matches?.('select:open'), closestSelect: event.target.closest?.('select')?.id, closestOpen: event.target.closest?.('select')?.matches(':open'), supported: CSS.supports('selector(select:open)'), path: event.composedPath().slice(0, 4).map(node => node.tagName || node.nodeName) }); }, true); });
      await page.locator('#adminUsersButton').click(); await page.locator('#usersCreateButton').click();
      const cases = [['#employeeRole', 'PCN role'], ['#employeeDepartment', 'PCN department']];
      for (const [selector, label] of cases) {
        const select = page.locator(selector), original = await select.inputValue();
        try { await pickerFade(select, () => select.click(), true, label); } catch (error) { failures.push(error.message); }
        try { await pickerFade(select, () => page.keyboard.press('Escape'), false, label); } catch (error) { failures.push(error.message); }
        report.nativeKeyEvents = await page.evaluate(() => window.__pickerKeys);
        await expect(page.locator('#employeeUserDialog')).toHaveJSProperty('open', true);
        await expect(select).toHaveValue(original); await expect(select).toBeFocused();
      }
      await page.locator('#employeeCancelButton').click(); await expect(page.locator('#employeeUserDialog')).toBeHidden();
      const filter = page.locator('#usersRoleFilter'), original = await filter.inputValue();
      try { await pickerFade(filter, () => filter.click(), true, 'Users role filter'); } catch (error) { failures.push(error.message); }
      try { await pickerFade(filter, () => page.keyboard.press('Escape'), false, 'Users role filter'); } catch (error) { failures.push(error.message); }
      await expect(filter).toHaveValue(original); await expect(filter).toBeFocused();
      if (failures.length) throw new Error(failures.join('; '));
      report.checks.push('Native role, department and filter pickers render entry/exit opacity frames and Escape preserves selection/focus');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const reducedEntry = await pickerFrames(filter, () => filter.click());
      assert.equal(reducedEntry.at(-1).open, true);
      assert(reducedEntry.every(frame => !(frame.opacity > 0.02 && frame.opacity < 0.98)), 'Reduced motion skips native picker entry fade');
      const reducedExit = await pickerFrames(filter, () => page.keyboard.press('Escape'));
      assert.equal(reducedExit.at(-1).open, false);
      assert(reducedExit.every(frame => !(frame.opacity > 0.02 && frame.opacity < 0.98)), 'Reduced motion skips native picker exit fade');
      report.checks.push('Reduced motion skips native picker opacity interpolation without changing normal selection controls');
      assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
      assert.deepEqual(await repository.list(), before); report.status = 'passed'; return;
    }
    const menu = page.locator('#createStartOptions');
    if (compatibilityOnly) {
      assert.equal(await page.evaluate(() => CSS.supports('transition-behavior', 'allow-discrete')), false);
      const failures = [];
      for (const [selector, trigger, label] of [['#createStartOptions', '#createStartToggle', 'Create dropdown without discrete CSS'], ['#accountProfilePanel', '.account-trigger', 'Account dropdown without discrete CSS']]) {
        const surface = page.locator(selector);
        for (const [opening, action] of [[true, { selector: trigger }], [false, { kind: 'escape' }]]) {
          try { await fade(surface, action, opening, label); }
          catch (error) { failures.push(error.message); }
        }
        await expect(surface).toBeHidden(); await expect(page.locator(trigger)).toBeFocused();
      }
      assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
      assert.deepEqual(await repository.list(), before);
      if (failures.length) throw new Error(failures.join('; '));
      report.checks.push('Create and profile entry/exit fades work without allow-discrete CSS, close noninteractively and preserve focus');
      report.status = 'passed'; return;
    }
    await fade(menu, { selector: '#createStartToggle' }, true, 'Create dropdown');
    await fade(menu, { kind: 'escape' }, false, 'Create dropdown');
    await expect(page.locator('#createStartToggle')).toBeFocused();
    const account = page.locator('#accountProfilePanel');
    await fade(account, { selector: '.account-trigger' }, true, 'Account dropdown');
    await fade(account, { kind: 'escape' }, false, 'Account dropdown');
    await expect(page.locator('.account-trigger')).toBeFocused();
    report.checks.push('Create and account dropdowns render entry and exit opacity frames, settle hidden, and restore keyboard focus');

    await page.locator('#adminMailRoutingButton').click();
    const assign = '.notification-department[data-department="gscTet"] .notification-department-add';
    await expect(page.locator(assign)).toBeVisible();
    const recipient = page.locator('#notificationRecipientDialog');
    await fade(recipient, { selector: assign }, true, 'Mail assignment popup');
    await expect(page.locator('#notificationRecipientRole')).toBeFocused();
    await page.locator('#notificationRecipientRole').selectOption('checked');
    await page.locator('#notificationRecipientEmail').fill('Motion');
    await expect(recipient.locator('.directory-suggestion')).toHaveCount(6);
    await fade(recipient, { selector: '#notificationRecipientCancelButton' }, false, 'Mail assignment popup', 'Motion contact');
    await expect(page.locator(assign)).toBeFocused();
    await page.locator('#adminUsersButton').click();
    await expect(page.locator('#usersAddRoleButton')).toBeVisible();
    const employee = page.locator('#employeeUserDialog');
    await fade(employee, { selector: '#usersAddRoleButton' }, true, 'Employee access popup');
    await page.keyboard.press('Tab'); await expect(employee).toBeVisible();
    await page.locator('#employeeSearch').fill('Motion');
    await expect(page.locator('#employeeResults .employee-result')).toHaveCount(30);
    await fade(employee, { selector: '#employeeCancelButton' }, false, 'Employee access popup', 'Motion employee');
    await expect(page.locator('#usersAddRoleButton')).toBeFocused();
    report.checks.push('Mail assignment and employee access popups render entry and exit fades, keep keyboard controls usable and return focus');

    await page.locator('#adminRecordsButton').click();
    const historyButton = page.getByRole('button', { name: 'History ' + before[0].id, exact: true });
    await expect(historyButton).toBeVisible();
    const historySelector = '[aria-label="History ' + before[0].id + '"]';
    const timeline = page.locator('#pcnTimelineDialog');
    await fade(timeline, { selector: historySelector }, true, 'Department timeline');
    await expect(page.locator('#pcnTimelineTrack')).toContainText('GSC/TET');
    await fade(timeline, { selector: '#pcnTimelineCloseButton' }, false, 'Department timeline', 'GSC/TET');
    await expect(historyButton).toBeFocused();
    const quickSelector = '[aria-label="Quick view ' + before[0].id + '"]';
    await page.locator(quickSelector).click();
    const quick = page.locator('#rdPreviewDialog');
    await expect(quick).toContainText('Responsive motion supplier');
    await fade(quick, { selector: '#rdPreviewDialog [aria-label="Close preview"]' }, false, 'PCN quick view', 'Responsive motion supplier');
    await expect(page.locator(quickSelector)).toBeFocused();
    await page.locator(historySelector).click(); await expect(timeline).toBeVisible();
    await page.keyboard.press('Escape'); await expect(timeline).toBeHidden(); await expect(historyButton).toBeFocused();
    report.checks.push('Timeline and quick view retain document content throughout fade-out and return focus');

    // Reopening during an exit must not let an older completion hide the new popup.
    await page.evaluate(() => { const trigger = document.querySelector('.account-trigger'); trigger.focus(); trigger.click(); trigger.click(); trigger.click(); });
    await expect(account).toBeVisible(); await page.waitForTimeout(350); await expect(account).toBeVisible();
    await expect(page.locator('.account-trigger')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape'); await expect(account).toBeHidden();
    await page.evaluate(() => { const trigger = document.querySelector('#createStartToggle'); trigger.focus(); trigger.click(); trigger.click(); trigger.click(); });
    await page.waitForTimeout(350); await expect(menu).toBeVisible();
    await page.keyboard.press('Escape'); await expect(menu).toBeHidden();
    report.checks.push('Rapid close/reopen cannot leave dropdowns hidden or aria-expanded stale');

    for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); const label = `${viewport.width}x${viewport.height}`;
      await page.locator('#adminUsersButton').click(); await page.locator('#usersAddRoleButton').click(); await expect(employee).toBeVisible();
      await fit(page, employee, `${label} employee`);
      await page.locator('#employeeSearch').fill('Motion');
      await expect(page.locator('#employeeResults')).toBeVisible();
      await fit(page, employee, `${label} employee results`);
      assert(await page.locator('#employeeResults').evaluate(node => node.scrollHeight > node.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)), `${label}: employee results scroll inside their own bounded area`);
      assert(await page.locator('#employeeCancelButton').evaluate(node => { const box = node.getBoundingClientRect(); return box.bottom <= innerHeight && box.top >= 0; }), `${label}: employee footer stays accessible`);
      await page.locator('#employeeCancelButton').click(); await expect(employee).toBeHidden();
      await page.locator('#adminMailRoutingButton').click(); await page.locator(assign).click(); await expect(recipient).toBeVisible();
      await page.locator('#notificationRecipientRole').selectOption('checked'); await page.locator('#notificationRecipientEmail').fill('Motion');
      await expect(recipient.locator('.directory-suggestion')).toHaveCount(6);
      await fit(page, recipient, `${label} mail results`);
      assert(await page.locator('#notificationRecipientCancelButton').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), `${label}: mail footer stays accessible`);
      await page.locator('#notificationRecipientCancelButton').click(); await expect(recipient).toBeHidden();
      await page.locator('#adminRecordsButton').click(); await fit(page, null, `${label} Records`);
      await page.locator('#createStartToggle').click(); await expect(menu).toBeVisible(); await fit(page, menu, `${label} Create dropdown`);
      await page.keyboard.press('Escape'); await expect(menu).toBeHidden();
      await page.screenshot({ path: path.resolve(`test-results/motion-ui-${viewport.width}.png`) });
    }
    report.checks.push('1366, 1280, 1024 and 390px layouts fit; search results scroll internally and popup actions remain visible');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const [surface, trigger, close] of [[menu, '#createStartToggle', { kind: 'escape' }], [account, '.account-trigger', { kind: 'escape' }]]) {
      const opening = await frames(surface, { selector: trigger });
      assert(opening.every(frame => !frame.displayed || frame.opacity === 1), 'Reduced motion has no partial opacity entry frames');
      const closing = await frames(surface, close);
      assert(!closing[0].displayed, 'Reduced motion hides dropdown immediately');
    }
    await page.locator('#adminMailRoutingButton').click();
    const opening = await frames(recipient, { selector: assign });
    assert(opening.every(frame => !frame.displayed || frame.opacity === 1), 'Reduced motion skips popup entry fade');
    const closing = await frames(recipient, { selector: '#notificationRecipientCancelButton' });
    assert(!closing[0].displayed, 'Reduced motion closes popup immediately');
    report.checks.push('Reduced motion skips fades and removes closed surfaces immediately');
    await page.goto(origin + '/create', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#startBlank')).toBeVisible();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await fit(page, null, viewport.width + 'px Create entry');
      assert(await page.locator('.create-entry-card').evaluateAll(cards => cards.every(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })), 'Create start choices fit without clipped actions');
    }
    await page.locator('#startBlank').click(); await expect(page.locator('#createEditor')).toBeVisible();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await fit(page, null, viewport.width + 'px Create editor');
      assert(await page.locator('.create-actionbar').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && box.top >= 0; }), 'Create fixed actionbar fits laptop and mobile viewport');
    }
    report.checks.push('Create entry choices and blank editor fit laptop and mobile sizes with the fixed save/continue actions accessible');
    assert.deepEqual(await repository.list(), before, 'Motion and layout checks never mutate PCNs');
    assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.forbidden, []);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.message; throw error; }
  finally {
    await fs.writeFile(path.resolve('test-results/motion-ui' + artifactSuffix + '-acceptance.json'), JSON.stringify(report, null, 2));
    if (context) { await context.tracing.stop({ path: path.resolve('test-results/motion-ui' + artifactSuffix + '-trace.zip') }); await context.close(); }
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    console.log(JSON.stringify({ storage: report.storage, status: report.status, checks: report.checks, errors: report.errors, external: report.external, forbidden: report.forbidden, ...(report.failure ? { failure: report.failure } : {}) }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

