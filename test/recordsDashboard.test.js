const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function dashboard() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../records.js'), 'utf8'), {
    window, document: { addEventListener() {} }, Date, Intl, Blob, URL, setTimeout, clearTimeout,
  });
  return window.PCN_RECORDS_DASHBOARD;
}

const records = [
  { id: 'PCN-2026-0001', status: 'submitted', riskLevel: 'High', supplierName: 'A', updatedAt: '2026-10-14T10:00:00Z', dashboard: { action: { department: 'qaTet', label: 'QA/TET — Checked', people: [{displayName:'Jane'}] }, pending:{needsAttention:true} } },
  { id: 'PCN-2026-0002', status: 'approved', riskLevel: 'Low', supplierName: 'B', updatedAt: '2026-10-13T10:00:00Z', dashboard: { action: {terminal:true}, pending:{needsAttention:false} } },
];

test('dashboard filters combine summary, text, department, supplier, dates and risk without changing source', () => {
  const api = dashboard();
  const result = api.filterRecords(records, { summary: 'attention', search: 'jane', department: 'QA/TET', supplier: 'A', risk: 'High', from: '2026-10-14', to: '2026-10-14' });
  assert.equal(result.length, 1); assert.equal(result[0].id, records[0].id);
  assert.equal(api.filterRecords(records, { summary: 'approved' }).length, 1);
  assert.equal(api.filterRecords(records, { from: 'invalid-date' }).length, 2);
  assert.equal(records[0].dashboard.action.people.length, 1);
});

test('counts use backend attention and approved evidence, never make missing readiness green', () => {
  const api = dashboard();
  assert.deepEqual(JSON.parse(JSON.stringify(api.summaryCounts([...records, { id: 'legacy', status: 'draft' }]))), { all: 3, review: 1, approved: 1, attention: 1 });
  assert.equal(api.documentLabel({}), 'Not available');
  assert.equal(api.documentLabel({dashboard:{documents:{}}}), 'Not available');
  assert.equal(api.pendingLabel({ updatedAt: '2026-10-12T00:00:00Z' }, Date.parse('2026-10-14T00:00:00Z')), 'Updated 2 days ago');
  assert.doesNotMatch(api.pendingLabel({ dashboard: { dueAt: 'invalid' } }), /overdue/i);
});

test('sorting and pagination are stable and do not mutate records', () => {
  const api = dashboard();
  assert.equal(api.sortRecords(records, 'supplierName', 'desc')[0].supplierName, 'B');
  assert.equal(records[0].supplierName, 'A');
  const page = api.paginate(records, 999, 10);
  assert.equal(page.page, 1); assert.equal(page.items.length, 2);
  assert.equal(api.paginate([], 1, 25).pages, 1);
});

test('CSV exports selected visible columns with BOM, preserves false/zero and prevents spreadsheet formulas', () => {
  const api = dashboard();
  const csv = api.exportCsv([{ id: 'PCN-1', supplierName: '  =WEBSERVICE("url")', materialName: 'Line\n"quote"', riskLevel: 0, status: false }], ['id', 'supplierName', 'materialName', 'riskLevel', 'status']);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /'  =WEBSERVICE/); assert.match(csv, /"Line\n""quote"""/);
  assert.match(csv, /"0","false"/);
  for (const formula of ['+x', '-x', '@x', '\tx', '\rx', ' \t=x']) assert.ok(api.csvCell(formula).startsWith('"\''));
  assert.doesNotMatch(api.exportCsv([{ id: 'PCN', supplierName: 'Hidden' }], ['id']), /Hidden/);
});

test('stored views reject malformed, oversized and unexpected data, and user preferences remain bounded', () => {
  const api = dashboard();
  assert.equal(api.readPreferences('{broken').views.length, 0);
  const prefs = api.readPreferences(JSON.stringify({ views: [{ name: 'QA queue', filters: { department: 'QA/TET', bad: 'ignored' } }, { name: '', filters: {} }], columns: ['id', 'unknown', 'status'], pageSize: 999 }));
  assert.equal(prefs.views.length, 1); assert.equal(prefs.views[0].filters.bad, undefined);
  assert.equal(prefs.pageSize, 25); assert.deepEqual(Array.from(prefs.columns), ['id', 'status']);
  assert.equal(api.readPreferences('x'.repeat(25000)).views.length, 0);
});

test('timeline signing points show department, action and signer from stored changes', () => {
  const api = dashboard();
  const points = api.timelinePoints([{ revision: 2, actor: 'Editor', createdAt: '2026-10-14T01:00:00Z', status: 'review', changes: [
    { path: 'internalReview.signoff.gscTet.checked', before: false, after: true },
    { path: 'internalReview.signoff.gscTet.checkedName', after: 'Alice' },
  ] }]);
  assert.equal(points[0].label, 'GSC/TET — Checked'); assert.equal(points[0].person, 'Alice');
  assert.equal(api.timelinePoints([{ revision: 1, isBaseline: true }])[0].label, 'History baseline');
});

test('preview markers never imply approval for rejected, draft or unknown baseline events', () => {
  const api = dashboard();
  assert.equal(api.timelineTone({ isBaseline: true, status: 'approved' }).tone, 'neutral');
  assert.equal(api.timelineTone({ status: 'rejected' }).marker, '!');
  assert.equal(api.timelineTone({ status: 'draft' }).tone, 'active');
  assert.equal(api.timelineTone({ signed: true, status: 'gsc_review' }).marker, '✓');
});

test('preview does not combine a newer record with stale assignee or readiness metadata', () => {
  const api = dashboard();
  const old = {version:1, dashboard:{action:{label:'QA checked'}}};
  const newer = {version:2,status:'approved'};
  assert.equal(api.currentSummary(newer, old), newer);
  assert.equal(api.currentSummary({...newer,version:1}, old), old);
});

function controllerPage(fetch, options = {}) {
  const all = [];
  const document = { activeElement: null, events: {}, addEventListener(name, listener) { this.events[name] = listener; }, removeEventListener(name) { delete this.events[name]; } };
  const createElement = tag => {
    const element = { tag, children: [], events: {}, attributes: {}, dataset: {}, value: '', textContent: '', open: false, isConnected: true,
      append(...children) { children.forEach(child => { child.parentElement = this; }); this.children.push(...children); }, prepend(child) { child.parentElement = this; this.children.unshift(child); },
      replaceChildren(...children) { children.forEach(child => { child.parentElement = this; }); this.children = children; }, getAttribute(key) { return this.attributes[key]; }, contains(target) { return this === target || this.querySelectorAll().includes(target); }, closest(selector) { return selector.split(',').includes(this.tag) ? this : this.parentElement?.closest(selector); }, setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(event, listener) { this.events[event] = [...(this.events[event] || []), listener]; },
      async emit(event, value = {}) { for (const listener of this.events[event] || []) await listener({target:this, preventDefault(){}, ...value}); },
      querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); },
      focus() { document.activeElement = this; }, showModal() { this.open = true; }, close() { this.open = false; }, remove() {},
    };
    if (tag === 'a' && options.resolveLinks) Object.defineProperty(element, 'href', { get() { return new URL(this.attributes.href, 'http://records.example').href; }, set(value) { this.attributes.href = value; } });
    all.push(element); return element;
  };
  document.createElement = createElement; document.body = createElement('body');
  const window = { localStorage: {getItem(){return null;},setItem(){} } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../records.js'), 'utf8'), {window, document, Date, Blob, URL});
  const root = createElement('main'); const rows = createElement('tbody'); root.append(rows);
  const search = createElement('input'); root.append(search);
  const count = createElement('span'); const message = createElement('p'); let accessLost = 0;
  const controller = window.PCN_RECORDS_DASHBOARD.create({root,rows,search,count,message,user:{id:'viewer'},fetch,onAccessLost(){accessLost++;}, ...options});
  return { controller, document, rows, root, count, message, all, createElement, find:id => all.find(item => item.id === id),
    button: (text, inside = root) => inside.querySelectorAll().find(item => item.tag === 'button' && (item.textContent === text || item.attributes['aria-label']?.startsWith(`${text} `))),
    lost:()=>accessLost };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('shared controller preserves focus after changed records and pauses polling while preview is open', async () => {
  const page = controllerPage(async url => url.endsWith('/progress') ? {steps:[]} : {id:'PCN-1',version:1});
  page.controller.setRecords([{id:'PCN-1',version:1}]);
  const preview = page.button('Quick view'); preview.focus();
  page.controller.setRecords([{id:'PCN-1',version:1,supplierName:'Changed'}]);
  assert.equal(page.document.activeElement.dataset.rdFocus, 'preview:PCN-1');
  assert.notEqual(page.document.activeElement, preview);
  await page.button('Quick view').emit('click');
  assert.equal(page.controller.canRefresh(),false);
  await page.find('rdPreviewDialog').emit('cancel');
  assert.equal(page.controller.canRefresh(),true);
  assert.equal(page.document.activeElement.dataset.rdFocus,'preview:PCN-1');
});

test('malformed timeline response is not cached and Retry issues a new authorized read', async () => {
  let revisionCalls = 0;
  const page = controllerPage(async url => {
    if(url.endsWith('/revisions')) return ++revisionCalls === 1 ? {items:null} : {items:[{revision:1,actor:'Actual signer'}]};
    return url.endsWith('/progress') ? {steps:[]} : {id:'PCN-1'};
  });
  page.controller.setRecords([{id:'PCN-1'}]); await page.button('Quick view').emit('click');
  await page.find('rdPreviewTab-history').emit('click'); await settle();
  const content = page.find('rdPreviewContent');
  assert.match(content.children[0].textContent,/invalid response/);
  await page.button('Retry',content).emit('click');
  assert.equal(revisionCalls,2); assert.ok(content.querySelectorAll().some(item=>item.textContent==='Actual signer'));
});

test('permission loss in preview clears record options and stops future preview reads', async () => {
  let calls = 0;
  const page = controllerPage(async()=>{calls++;throw Object.assign(new Error('Forbidden'),{status:403});});
  page.controller.setRecords([{id:'PCN-1',supplierName:'Protected supplier',status:'submitted'}]);
  const preview = page.button('Quick view'); await preview.emit('click');
  assert.equal(page.rows.children.length,0); assert.equal(page.count.textContent,'0');
  assert.equal(page.find('rdFilter-supplier').children.length,1);
  assert.equal(page.controller.canRefresh(),false); assert.equal(page.find('rdPreviewDialog').open,false); assert.equal(page.lost(),1);
  await preview.emit('click'); assert.equal(calls,2); // Two parallel overview GETs; no subsequent reads.
});

test('a closed or superseded preview cannot render late responses', async () => {
  let resolveRead;
  const late = new Promise(resolve=>{resolveRead=resolve;});
  const page = controllerPage(()=>late);
  page.controller.setRecords([{id:'PCN-1'}]);
  const opened = page.button('Quick view').emit('click');
  await page.find('rdPreviewDialog').emit('cancel');
  resolveRead({id:'PCN-1',supplierName:'Late private data',steps:[]}); await opened;
  assert.equal(page.find('rdPreviewContent').children.length,0);
  assert.equal(page.controller.getState().preview,null);
});

test('Portal selection retains its existing highlight and accessible selection state', () => {
  const page = controllerPage(async()=>({}),{selectedId:()=> 'PCN-2'});
  page.controller.setRecords([{id:'PCN-1'},{id:'PCN-2'}]);
  const selected = page.rows.children.find(row=>row.dataset.pcnId==='PCN-2');
  assert.equal(selected.className,'is-selected'); assert.equal(selected.attributes['aria-selected'],'true');
  assert.equal(page.rows.children.find(row=>row.dataset.pcnId==='PCN-1').attributes['aria-selected'],'false');
});

test('overview never mixes a fresh record with independently fetched old progress', async () => {
  const page = controllerPage(async url => url.endsWith('/progress') ? {status:'submitted',currentStepTitle:'Old GSC review',steps:[{title:'Old pending stage',state:'active'}]} : {id:'PCN-1',version:2,status:'approved'});
  page.controller.setRecords([{id:'PCN-1',version:1,status:'submitted',dashboard:{progress:{status:'submitted',currentStepTitle:'Old GSC review'},action:{label:'Old pending approver'}}}]);
  await page.button('Quick view').emit('click');
  const content = page.find('rdPreviewContent'); const text = content.querySelectorAll().map(item=>item.textContent).join(' ');
  assert.match(text,/Approved/); assert.match(text,/Refresh the records list/);
  assert.doesNotMatch(text,/Old GSC review|Old pending stage|Old pending approver/);
  const api = dashboard(); const record={version:3,status:'qa_review'};
  const summary={...record,dashboard:{progress:{status:'qa_review',currentStepTitle:'Verified snapshot'}}};
  assert.equal(api.currentProgress(record,summary,{status:'approved',currentStepTitle:'Racing independent read'}).currentStepTitle,'Verified snapshot');
  assert.equal(api.currentProgress(record,{...record},{status:'qa_review',currentStepTitle:'Stale same-status signing stage'}),null);
});

test('Rejected displays its actual signing count without a false 100 percent completed workflow', async () => {
  const progress = {status:'rejected',terminal:true,progressPercent:100,totalSignatures:18,completedSignatures:2,steps:[{title:'Stage never signed',state:'completed'}]};
  const record = {id:'PCN-1',version:1,status:'rejected',dashboard:{progress}};
  const page = controllerPage(async url => url.endsWith('/progress') ? progress : record);
  page.controller.setRecords([record]);
  assert.equal(page.rows.querySelectorAll().filter(item=>item.tag==='progress').length,0);
  assert.ok(page.rows.querySelectorAll().some(item=>item.textContent==='2/18 signing steps'));
  await page.button('Quick view').emit('click');
  const content = page.find('rdPreviewContent'); const displayed=content.querySelectorAll().map(item=>item.textContent).join(' ');
  assert.match(displayed,/Rejected/); assert.match(displayed,/Review ended with rejection/);
  assert.doesNotMatch(displayed,/Stage never signed|100%/);
  assert.equal(content.querySelectorAll().filter(item=>item.className==='rd-step-completed').length,0);
  const approved = {...record,status:'approved',dashboard:{progress:{...progress,status:'approved'}}};
  const normal = controllerPage(async()=>({})); normal.controller.setRecords([approved]);
  assert.equal(normal.rows.querySelectorAll().filter(item=>item.tag==='progress').length,1);
});


test('record opening uses native links with the exact authorized route and keeps testing identity separate', () => {
  const page = controllerPage(async () => ({}), { codeHref: record => `/view/${record.id}?readonly=1` });
  const record = { id: 'PCN-2026-0001', isTestDocument: true };
  page.controller.setRecords([record]);
  const links = page.rows.querySelectorAll().filter(item => item.tag === 'a');
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent, record.id);
  assert.equal(links[1].textContent, 'Open PCN');
  for (const link of links) {
    assert.equal(link.href, '/view/PCN-2026-0001?readonly=1');
    assert.equal(link.target, undefined);
    assert.equal(link.events.click, undefined, 'native navigation supports modifiers and middle click');
  }
  assert.equal(links[1].dataset.rdFocus, `open:${record.id}`);
  links[1].focus();
  page.controller.setRecords([{ ...record, supplierName: 'Updated' }]);
  assert.equal(page.document.activeElement.dataset.rdFocus, `open:${record.id}`);
  const identity = page.rows.querySelectorAll().find(item => item.className === 'rd-code-cell');
  assert.equal(identity.children[0].textContent, record.id);
  assert.equal(identity.children[1].textContent, 'TESTING DOC');
  assert.equal(identity.children[2].textContent, 'Open PCN');
  assert.equal(identity.parentElement.dataset.column, 'id');
});

test('overflow actions pause refresh, close safely and never select their row', async () => {
  let removed = false; let selected = 0; let invalidations = 0; let page;
  page = controllerPage(async () => ({}), { onRowSelect() { selected++; }, onOpen() { invalidations++; }, actions() {
    const remove = page.createElement('button'); remove.textContent = 'Remove'; remove.dataset.rdOverflow = 'true';
    remove.addEventListener('click', () => { removed = true; }); return [remove];
  } });
  page.controller.setRecords([{ id: 'PCN-1' }]);
  const more = page.rows.querySelectorAll().find(item => item.tag === 'details');
  assert.ok(more, 'destructive actions live inside a disclosure');
  const summary = more.children[0];
  assert.equal(summary.title, 'More actions for PCN-1');
  assert.match(summary.innerHTML, /<svg/);
  assert.equal(summary.attributes['aria-label'], 'More actions for PCN-1');
  await summary.emit('click'); more.open = true; await more.emit('toggle');
  assert.ok(invalidations > 0); assert.equal(page.controller.canRefresh(), false);
  await page.rows.children[0].emit('click', { target: summary }); assert.equal(selected, 0);
  await more.emit('keydown', { key: 'Escape', stopPropagation() {} });
  assert.equal(more.open, false); assert.equal(page.document.activeElement, summary);
  more.open = true;
  await more.emit('focusout', { relatedTarget: page.root });
  assert.equal(more.open, false);
  more.open = true;
  page.document.events.click({ target: page.root });
  assert.equal(more.open, false);
  more.open = true;
  const remove = page.button('Remove');
  await more.emit('click', { target: remove });
  await remove.emit('click');
  assert.equal(more.open, false); assert.equal(removed, true);
  assert.equal(page.controller.canRefresh(), true);
});


test('Open uses the original route once without resolving it through the code anchor URL property', () => {
  let hrefCalls = 0;
  const page = controllerPage(async () => ({}), { resolveLinks: true, codeHref(record) { hrefCalls++; return `/document/${record.id}?readonly=1`; } });
  page.controller.setRecords([{ id: 'PCN-1' }]);
  const links = page.rows.querySelectorAll().filter(item => item.tag === 'a');
  assert.equal(hrefCalls, 1);
  assert.equal(links[0].getAttribute('href'), '/document/PCN-1?readonly=1');
  assert.equal(links[1].getAttribute('href'), links[0].getAttribute('href'));
  const quickView = page.button('Quick view');
  assert.equal(quickView.title, 'Quick view PCN-1');
  assert.match(quickView.innerHTML, /<svg/);
});


test('Quick view timeline reads a coherent department snapshot and keeps revision history secondary', async () => {
  const calls = [];
  const snapshot = { id: 'PCN-1', version: 'fresh', status: 'qa_review', stages: [{ key: 'qaTet', label: 'QA/TET', completed: 1, total: 3, state: 'current', currentStep: 'Checked', steps: [
    { action: 'prepared', label: 'Prepared', completed: true, person: 'Actual preparer', signedAt: '2026-10-15' },
    { action: 'checked', label: 'Checked', completed: false, person: null, signedAt: null },
    { action: 'approved', label: 'Approved', completed: false, person: null, signedAt: null }] }], nextAction: { stage: 'qaTet', signingStep: 'checked', label: 'QA/TET ? Checked', terminal: false } };
  const page = controllerPage(async url => { calls.push(url); return url.endsWith('/workflow-summary') ? snapshot : url.endsWith('/progress') ? { steps: [] } : { id: 'PCN-1', version: 'stale' }; });
  page.controller.setRecords([{ id: 'PCN-1', version: 'stale' }]); await page.button('Quick view').emit('click');
  await page.find('rdPreviewTab-timeline').emit('click'); await settle();
  assert.equal(calls.at(-1), '/api/pcns/PCN-1/workflow-summary');
  assert.equal(calls.some(url => url.endsWith('/revisions')), false);
  const content = page.find('rdPreviewContent');
  const text = content.querySelectorAll().map(item => item.textContent).join(' ');
  assert.match(text, /QA\/TET/); assert.match(text, /1\/3 signed/); assert.match(text, /Waiting for Checked/);
  assert.match(text, /Actual preparer/); assert.match(text, /2026-10-15/);
  assert.equal(content.querySelectorAll().filter(item => item.dataset.workflowStage).length, 1);
});
