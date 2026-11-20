// Synthetic PCNs on a loopback memory repository. Never contacts SQL or sends mail.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
const { createRequestHandler } = require('../src/httpServer');
const { PcnService } = require('../src/pcnService');
const { memoryRepository, fakeAuthService, TEST_PASSWORD, unsignedPayload } = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');

const output = path.resolve('test-results');
const report = { storage: 'isolated_memory_only', checks: [], documents: [], errors: [], external: [] };
const baseline = process.argv.includes('--baseline');
const diagnostic = process.argv.includes('--diagnostic');
const native = process.argv.includes('--native') || (!baseline && !diagnostic && !process.argv.includes('--emulated'));
const edge = process.argv.includes('--edge');
const historical = process.argv.includes('--historical');
const documentTypes = historical ? ['legacy'] : baseline || diagnostic ? ['ta'] : ['ta', 'sc'];
const pythonPdf = `import pymupdf as fitz,json,sys
doc=fitz.open(sys.argv[1])
result={'pages':len(doc),'sizes':[[round(p.rect.width,2),round(p.rect.height,2)] for p in doc],'text':'\\n'.join(p.get_text() for p in doc),'outside':[w[4] for p in doc for w in p.get_text('words') if w[0]<0 or w[1]<0 or w[2]>p.rect.width+1 or w[3]>p.rect.height+1],'titleWidth':next((b[2]-b[0] for p in doc for b in p.get_text('blocks') if 'SUPPLIER PROCESS CHANGE NOTIFICATION' in b[4]),0)}
result['headerRect']=next((list(s['rect']) for p in doc for s in p.get_drawings() if s['fill'] and max(s['fill'])<.4 and s['rect'].width>100 and 5<s['rect'].height<50 and s['rect'].y0<150),None)
if len(doc)==1: doc[0].get_pixmap(matrix=fitz.Matrix(1.5,1.5)).save(sys.argv[2])
print(json.dumps(result))`;

function inspectPdf(file, image) {
  const result = spawnSync('python', ['-c', pythonPdf, file, image], { encoding: 'utf8' });
  assert.equal(result.status, 0, `PDF inspection requires Python PyMuPDF: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function printRuleState(page) {
  return page.evaluate(() => ({
    media: [...document.styleSheets].flatMap(sheet => [...sheet.cssRules].flatMap((rule, index) =>
      rule instanceof CSSMediaRule ? [`${sheet.href || 'inline'}:${index}:${rule.media.mediaText}`] : [])),
    scale: document.getElementById('submissionView').style.getPropertyValue('--pcn-print-scale'),
    width: document.getElementById('submissionView').style.getPropertyValue('--pcn-print-width')
  }));
}

async function observePrint(page) {
  await page.evaluate(() => {
    window.__printEvents = [];
    window.addEventListener('beforeprint', () => {
      const sheet = document.getElementById('submissionView'), bounds = sheet.getBoundingClientRect();
      const bottom = document.querySelector('.approval-route-band-bottom')?.getBoundingClientRect();
      const childBottom = Math.max(...[...sheet.querySelectorAll('*')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.getBoundingClientRect().bottom));
      window.__printEvents.push({ media: matchMedia('print').matches, scale: sheet.style.getPropertyValue('--pcn-print-scale'),
        widthVariable: sheet.style.getPropertyValue('--pcn-print-width'), zoom: getComputedStyle(sheet).zoom,
        width: bounds.width, height: bounds.height, scrollHeight: sheet.scrollHeight,
        bottomRoute: bottom && { top: bottom.top - bounds.top, bottom: bottom.bottom - bounds.top }, childBottom: childBottom - bounds.top,
        sections: [...sheet.querySelectorAll('.pcn-excel-header,.change-options,.supplier-detail-grid,.approval-sheet,.approval-meta-row,.approval-review-grid,.approval-box,.signoff-grid,.tapbu-grid,.qate-final-grid')].map(node => ({
          name: node.className, height: node.getBoundingClientRect().height / Number(getComputedStyle(sheet).zoom),
          grid: getComputedStyle(node).gridTemplateRows })),
        textareaHeights: [...sheet.querySelectorAll('textarea')].map(node => ({ id: node.id, height: node.style.height })).filter(node => node.height) });
    });
  });
}

async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async () => ({ ...masterData, versionId: 1 });
  const service = new PcnService(repository);
  const admin = { id: 'admin-id', displayName: 'Print Fixture Administrator', roles: ['admin'] };
  const fixtures = [];
  const signing = Object.fromEntries(['prepared', 'checked', 'approved'].flatMap(action => [[action, true], [`${action}Name`, 'Print Test Signer'], [`${action}Date`, '2026-10-22']]));
  const skippedSigning = Object.fromEntries(['prepared', 'checked', 'approved'].flatMap(action => [[action, false], [`${action}Name`, ''], [`${action}Date`, '']]));
  for (const documentType of documentTypes) {
  for (const [form, definition] of Object.entries(masterData.formDefinitions)) {
    for (const signed of [false, true]) {
      if ((baseline || diagnostic) && (form !== 'rawMaterial' || signed)) continue;
      if (historical && (form !== 'rawMaterial' || !signed)) continue;
      const selected = definition.riskOptions.find(row => row.risk === 'RL2');
      const payload = { ...unsignedPayload, documentType, changeForm: form, riskLevel: selected.risk, selectedChange: selected.text,
        changeRows: [{ ...selected, currentCondition: 'Synthetic current condition', newCondition: 'Synthetic proposed condition' }],
        supplierName: 'TEST Print Supplier', manufacturerName: 'TEST Print Manufacturer', materialName: 'TEST Print Material',
        status: 'draft', internalReview: {} };
      // Seed historical data directly: today's creation API deliberately requires TA or SC.
      const now = new Date().toISOString();
      let record = historical
        ? await repository.create({ ...payload, documentType: undefined, createdAt: now, updatedAt: now,
          ownerUserId: admin.id, sourceTemplate: definition.sheet }, admin.displayName, admin)
        : await service.create(payload, admin.displayName, admin);
      record = await repository.update(record.id, current => ({ ...current, isTestDocument: true, status: signed ? 'closed' : 'draft',
        ...(signed ? { internalReview: { pcnCode: current.id, signoff: { gscTet: signing, prodEngTet: signing, qaTet: signing },
          supplierSignoff: Object.fromEntries(['prepared', 'checked', 'approved'].map(action => [action, { checked: true, name: 'Print Test Signer', date: '2026-10-22' }])),
          tapbu: { need: true, noNeed: false, gsc: signing, qa: signing }, qateFinal: { approve: true, reject: false,
            qod206Number: 'PRINT-QOD-206', completedDate: '2026-10-22', signoff: signing } } } : {}) }), admin, record.version);
      if (historical) record = await repository.update(record.id, current => ({ ...current, status: 'closed',
        changeRows: definition.riskOptions.map(row => ({ ...row, currentCondition: row === selected ? 'Synthetic current condition' : '', newCondition: row === selected ? 'Synthetic proposed condition' : '' })),
        internalReview: { ...current.internalReview,
          supplierSignoff: Object.fromEntries(['prepared', 'checked', 'approved'].map(action => [action, { checked: true, name: 'Print Test Signer', date: '' }])),
          tapbu: { need: false, noNeed: true, gsc: skippedSigning, qa: skippedSigning },
          qateFinal: { ...current.internalReview.qateFinal, approve: false, reject: false, qod206Number: '', completedDate: '' } } }), admin, record.version);
      fixtures.push({ record, form, signed, documentType, sheet: definition.sheet });
    }
  }
  }
  const server = http.createServer();
  let browser, context;
  try {
    await fs.mkdir(output, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createRequestHandler({ repository, service, authService: fakeAuthService(), rootDir: path.resolve(__dirname, '..'),
      publicOrigin: origin, secureCookies: false, documents: { async list() { return []; } } }));
    console.log('Print acceptance: starting isolated browser');
    browser = await chromium.launch({ channel: edge ? 'msedge' : 'chromium', headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { report.external.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/profile') return route.fulfill({ json: { success: true, data: { status: 'unavailable' } } });
      return route.continue();
    });
    console.log('Print acceptance: logging in to loopback fixture');
    const login = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { username: 'admin', password: TEST_PASSWORD } });
    assert.equal(login.status(), 200);
    async function documentPage(record) {
      const page = await context.newPage();
      page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
      page.on('pageerror', error => report.errors.push(error.message));
      await page.goto(`${origin}/form.html?id=${record.id}`);
      await expect(page.locator('#supplierName')).toHaveValue('TEST Print Supplier');
      await observePrint(page);
      return page;
    }
    for (const { record, form, signed, documentType, sheet } of fixtures) {
      console.log(`Print acceptance: ${documentType} ${sheet} ${signed ? 'signed' : 'draft'}`);
      let page = await documentPage(record);
      const originalPrintRules = await printRuleState(page);
      if (!native) await page.evaluate(() => { window.__printCalls = 0; window.print = () => { window.__printCalls += 1; window.dispatchEvent(new Event('beforeprint')); }; });
      const latestRead = page.waitForResponse(response => response.url().endsWith(`/api/pcns/${record.id}`) && response.request().method() === 'GET');
      await page.getByRole('button', { name: 'Print / PDF', exact: true }).click();
      await latestRead;
      if (!native) await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
      else await expect.poll(() => page.evaluate(() => window.__printEvents.length)).toBeGreaterThan(0);
      await expect(page.locator('#documentPrintIdentity')).toContainText(record.id);
      // Headless window.print has no preview UI to close. Model cancelling that UI;
      // the separate direct page.pdf path below receives genuine browser print events.
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      await expect.poll(() => printRuleState(page)).toEqual(originalPrintRules);
      await expect(page.locator('.topbar')).toBeVisible();
      report.checks.push(`${documentType} ${sheet} ${signed ? 'signed' : 'draft'}: print button invokes beforeprint and restores styles after modeled cancellation`);
      // Dispatching afterprint restores application styles but does not dismiss a
      // browser's internal headless print job. Closing this page releases that job;
      // PDF acceptance uses a fresh page with genuine beforeprint/afterprint events.
      await page.close();
      page = await documentPage(record);
      assert.deepEqual(await printRuleState(page), originalPrintRules);
      let desktopTitleWidth;
      for (const width of diagnostic ? [1440] : [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const screenWidth = await page.locator('.supplier-sheet').evaluate(node => node.getBoundingClientRect().width);
      if (!native) await page.emulateMedia({ media: 'print' });
      const dimensions = await page.locator('#submissionView').evaluate(node => ({ width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height, scrollHeight: node.scrollHeight, offsetHeight: node.offsetHeight,
        zoom: getComputedStyle(node).zoom, scale: node.style.getPropertyValue('--pcn-print-scale') }));
      const mode = native ? `native-${edge ? 'edge' : 'chromium'}-${historical ? 'historical' : `${documentType}-${form}-${signed ? 'signed' : 'draft'}`}` : baseline ? 'before' : diagnostic ? 'diagnostic' : `${documentType}-${form}-${signed ? 'signed' : 'draft'}`;
      const file = path.join(output, `pcn-a4-${mode}-${width}.pdf`);
      await page.pdf({ path: file, format: 'A4', printBackground: !historical, preferCSSPageSize: true });
      const pdf = inspectPdf(file, file.replace('.pdf', '.png'));
      const printEvents = await page.evaluate(() => window.__printEvents);
      report.documents.push({ file: path.basename(file), documentType, printBackground: !historical, pages: pdf.pages, sizes: pdf.sizes, titleWidth: pdf.titleWidth, headerRect: pdf.headerRect, dimensions, printEvents });
      if (!baseline) {
        assert.equal(pdf.pages, 1, `${width}px viewport must print the complete form on one A4 page`);
        assert(Math.abs(pdf.sizes[0][0] - 595.28) < 2 && Math.abs(pdf.sizes[0][1] - 841.89) < 2, 'Portrait A4 dimensions');
        const actualPrint = printEvents.at(-1);
        assert(actualPrint?.width >= 0.9 * 194 * 96 / 25.4 && actualPrint.width <= 1.01 * 194 * 96 / 25.4,
          'Prepared print layout fits within the printable A4 width');
        assert(pdf.headerRect && pdf.headerRect[2] - pdf.headerRect[0] >= 0.9 * 194 * 72 / 25.4,
          'The actual PDF form fills the printable A4 width');
        assert(pdf.headerRect[0] >= 20 && pdf.headerRect[2] <= pdf.sizes[0][0] - 20,
          'Both left and right edges of the printed form stay inside the A4 margins');
        const text = pdf.text.replace(/\s+/g, ' ');
        for (const required of ['SUPPLIER PROCESS CHANGE NOTIFICATION', 'TEST Print Supplier', 'TESTING DOC', 'Final Judgment', 'Requirements to suppliers', 'ROUTE: QOD-206', record.id, sheet]) {
          assert(text.includes(required), `Complete PDF includes ${required}`);
        }
        assert(text.includes(historical ? 'Prod.Eng/TET' : `Prod.Eng/${documentType.toUpperCase()}`), 'PDF retains the correct engineering team');
        assert.equal(text.includes('DRAFT'), !signed, 'Nonterminal documents preserve the controlled-copy draft watermark');
        // Official handwritten signatures intentionally display only the first given name.
        if (signed) {
          const expectedNames = historical ? 15 : 21;
          assert.equal((pdf.text.match(/^Print$/gm) || []).length, expectedNames, `All ${expectedNames} saved signature names remain in the PDF`);
          for (const required of historical ? ['2026-10-22'] : ['PRINT-QOD-206', '2026-10-22']) assert(text.includes(required), `Signed PDF includes ${required}`);
        }
        for (const hidden of ['Print / PDF', 'Save draft', 'Load Demo', 'Portal System']) assert(!text.includes(hidden), `Application chrome excluded: ${hidden}`);
        assert.deepEqual(pdf.outside, [], 'PDF text stays inside the page');
        if (width === 1440) desktopTitleWidth = pdf.titleWidth;
        else assert(Math.abs(pdf.titleWidth / desktopTitleWidth - 1) < 0.05, 'Mobile printing uses the same readable paper layout as desktop');
      }
      if (!native) await page.emulateMedia({ media: 'screen' });
      const restoredWidth = await page.locator('.supplier-sheet').evaluate(node => node.getBoundingClientRect().width);
      assert(Math.abs(restoredWidth - screenWidth) < 1, 'Printing restores the original screen layout');
      await expect.poll(() => printRuleState(page)).toEqual(originalPrintRules);
      await expect(page.locator('.topbar')).toBeVisible();
      }
      await page.close();
    }
    report.checks.push(`Saved record Print / PDF control invokes ${native ? 'genuine window.print' : 'the simulated print callback'} in ${edge ? 'installed Edge' : 'bundled Chromium'}`);
    if (native) report.checks.push('Headless print-preview cancellation uses an explicit afterprint event and closes the print page; fresh-page PDF afterprint cleanup is verified without dispatching any event');
    if (diagnostic) report.checks.push('Native beforeprint section heights captured for the print layout diagnostic');
    else if (historical) report.checks.push('Closed saved shape with all change rows, blank header dates, skipped TaPBU and no final decision fits a full-width A4 page at desktop and mobile widths');
    else if (!baseline) report.checks.push('TA and SC across Form-1 and Form-2, draft and fully signed, fit one portrait A4 page at desktop and mobile widths',
      'Final Judgment, supplier requirements, signature names/dates, testing labels, document identity and conditional draft watermark remain in the PDF',
      'Application controls are excluded, text stays inside the page and screen layout restores after printing');
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.external, []);
  } finally {
    const reportMode = native ? `native-${edge ? 'edge' : 'chromium'}${historical ? '-historical' : ''}` : baseline ? 'baseline' : diagnostic ? 'diagnostic' : 'acceptance';
    await fs.writeFile(path.join(output, `print-layout-${reportMode}.json`), JSON.stringify(report, null, 2));
    await context?.close(); await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ ...report, documents: report.documents.map(({ file, pages, sizes, titleWidth }) => ({ file, pages, sizes, titleWidth })) }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
