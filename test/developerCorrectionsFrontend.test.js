'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../developer');

const record = { id: 'T-24112601', version: '0000000000000001', status: 'submitted',
  reason: 'Original', supplierName: 'Supplier', selectedChange: 'Original change',
  changeRows: [{ optionText: 'Standard category', risk: 'RL2', text: 'Original change', currentCondition: 'Before', newCondition: 'After' }] };

test('correction changes include only changed editable fields and preserve original records', () => {
  const edited = { ...record, reason: 'Correction', status: 'closed', documentType: 'sc' };
  assert.deepEqual(tools.correctionChanges(record, edited), { reason: 'Correction' });
  assert.deepEqual(tools.correctionChanges(record, record), {});
  assert.equal(record.reason, 'Original');
});

test('editing selected Content of Changes keeps selected text synchronized without changing its category', () => {
  const edited = tools.editCorrectionRow(record, 0, 'text', 'Corrected change');
  assert.equal(edited.selectedChange, 'Corrected change');
  assert.equal(edited.changeRows[0].text, 'Corrected change');
  assert.equal(edited.changeRows[0].optionText, 'Standard category');
  assert.equal(edited.changeRows[0].risk, 'RL2');
  assert.equal(record.changeRows[0].text, 'Original change');
  const other = tools.editCorrectionRow({ ...record, selectedChange: 'Another row' }, 0, 'text', 'Corrected');
  assert.equal(other.selectedChange, 'Another row');
  assert.throws(() => tools.editCorrectionRow(record, 0, 'risk', 'RL0'));
});

test('correction preview reports per-field before and after values without writable workflow metadata', () => {
  const preview = tools.correctionPreview([{ original: record, edited: { ...record, reason: '<b>New</b>', version: 'fake' } }]);
  assert.deepEqual(preview, [{ id: record.id, version: record.version, changes: { reason: '<b>New</b>' },
    fields: [{ key: 'reason', label: 'Reason for change', before: 'Original', after: '<b>New</b>' }] }]);
  assert.deepEqual(tools.correctionPreview([{ original: record, edited: record }]), []);
});

test('selected change conditions and root summary conditions stay in sync in both editing directions', () => {
  const rowEdit = tools.editCorrectionRow(record, 0, 'currentCondition', 'Corrected current');
  assert.equal(rowEdit.currentCondition, 'Corrected current');
  const fieldEdit = tools.editCorrectionField(record, 'newCondition', 'Corrected future');
  assert.equal(fieldEdit.changeRows[0].newCondition, 'Corrected future');
  assert.equal(fieldEdit.newCondition, 'Corrected future');
  assert.equal(record.changeRows[0].newCondition, 'After');
});

test('retained signature notice covers historical unknown evidence and mismatched known bindings', () => {
  const signed = { documentControl: { contentHash: 'new', signatureBindings: { 'signoff.gscTet.prepared': { contentHash: 'old' } } },
    internalReview: { signoff: { gscTet: { prepared: true } } } };
  assert.equal(tools.correctedAfterSigning(signed), true);
  assert.equal(tools.correctedAfterSigning({ ...signed, documentControl: { contentHash: 'new', signatureBindings: { 'signoff.gscTet.prepared': { contentHash: 'new' } } } }), false);
  assert.equal(tools.correctedAfterSigning({ documentControl: { lastDeveloperCorrection: { retainedSignatures: ['signoff.gscTet.prepared'] } }, internalReview: signed.internalReview }), true);
  assert.equal(tools.correctedAfterSigning({ documentControl: { lastDeveloperCorrection: { retainedSignatures: ['signoff.gscTet.prepared'] } }, internalReview: {} }), false);
  assert.equal(tools.correctedAfterSigning({ ...signed, documentControl: { contentHash: 'new',
    correctedSignatures: ['signoff.gscTet.prepared'], signatureBindings: { 'signoff.gscTet.prepared': { contentHash: 'new' } } } }), false);
});

function fixture(respond) {
  const nodes = new Map(), calls = [];
  function element(tag = 'div') {
    return { tagName: tag.toUpperCase(), value: '', textContent: '', hidden: false, disabled: false, children: [], events: {}, attributes: {},
      appendChild(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; },
      setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(key, fn) { this.events[key] = fn; },
      focus() { this.focused = true; }, showModal() { this.open = true; }, close() { this.open = false; } };
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const root = { document: { createElement: element, getElementById: get }, location: { search: '' }, PCN_SESSION: {
    async require() { return { user: { isActive: true, roles: ['developer'], department: 'developer', signingStep: null } }; },
    async fetch(url, options) { calls.push({ url, options }); return respond(url, options); }
  } };
  return { root, get, calls };
}
function correctionData(id = record.id) { return { record: { ...structuredClone(record), id }, signatures: [] }; }
function descendant(parent, predicate) {
  if(predicate(parent))return parent;
  for(const child of parent.children || []){const found=descendant(child,predicate);if(found)return found;}
}
const byAttribute = (parent,key,value) => descendant(parent,node=>Object.hasOwn(node.attributes || {},key)&&(value===undefined||node.attributes[key]===value));

test('Corrections starts with selection only and no detail requests until at least one document is chosen', async () => {
  const page = fixture(url => url === '/api/developer/pcns' ? {items:[{id:record.id}]} : correctionData());
  await tools.mount(page.root);
  assert.equal(page.get('correctionSelectionStage').hidden,false);assert.equal(page.get('correctionEditStage').hidden,true);
  assert.equal(page.get('loadCorrections').disabled,true);assert.equal(page.get('previewCorrections').disabled,true);
  await page.get('loadCorrections').events.click();assert.deepEqual(page.calls.map(call=>call.url),['/api/developer/pcns']);
});

test('Edit stage opens the first document and selected change first while secondary, other changes and signature tools stay collapsed', async () => {
  const second='S-24112601';
  const page=fixture(url=>url==='/api/developer/pcns'?{items:[{id:record.id},{id:second}]}:{...correctionData(url.includes(second)?second:record.id),
    record:{...correctionData(url.includes(second)?second:record.id).record,changeRows:[{text:'Unused',optionText:'Other',risk:'RL1'},...record.changeRows]},
    signatures:[{path:'signoff.gscTet.prepared',label:'GSC Prepared',clears:['signoff.gscTet.prepared']}]});
  const mounted=await tools.mount(page.root);mounted.corrections.state.selected.add(record.id);mounted.corrections.state.selected.add(second);
  await page.get('loadCorrections').events.click();
  assert.equal(page.get('correctionSelectionStage').hidden,true);assert.equal(page.get('correctionEditStage').hidden,false);
  assert.equal(page.get('correctionEditHeading').focused,true);
  const [first,other]=page.get('correctionEditors').children;
  assert.equal(first.open,true);assert.equal(other.open,false);
  assert.equal(byAttribute(first,'data-correction-group','content').open,true);
  for(const group of ['supplier','additional','otherChanges','signatures'])assert.equal(Boolean(byAttribute(first,'data-correction-group',group).open),false,group);
  const content=byAttribute(first,'data-correction-group','content');assert.equal(byAttribute(content,'data-correction-row','1').value,'Original change');
});

test('Back preserves selected documents, content edits and audit reason without a reload; live changed count controls review', async () => {
  const page=fixture(url=>url==='/api/developer/pcns'?{items:[{id:record.id}]}:correctionData());
  const mounted=await tools.mount(page.root);mounted.corrections.state.selected.add(record.id);await page.get('loadCorrections').events.click();
  const input=byAttribute(page.get('correctionEditors'),'data-correction-field','text');input.value='Revised wording';input.events.input();
  assert.match(page.get('correctionChangeCount').textContent,/1 document changed/);assert.equal(page.get('previewCorrections').disabled,true);
  page.get('correctionReason').value='Correct wording';page.get('correctionReason').events.input();assert.equal(page.get('previewCorrections').disabled,false);
  const requests=page.calls.length;page.get('changeCorrectionSelection').events.click();
  assert.equal(page.get('correctionSelectionStage').hidden,false);assert.equal(page.get('correctionReason').value,'Correct wording');
  await page.get('loadCorrections').events.click();assert.equal(page.calls.length,requests);
  assert.equal(mounted.corrections.state.entries[0].edited.changeRows[0].text,'Revised wording');assert.equal(mounted.corrections.state.selected.has(record.id),true);
  page.get('discardCorrections').events.click();assert.equal(page.get('correctionReason').value,'');
  assert.equal(page.get('correctionSelectionStage').hidden,false);assert.equal(mounted.corrections.state.entries.length,0);
});

test('return to editing cannot open a previously loaded document after a different selection is chosen', async () => {
  const second='S-24112601';const page=fixture(url=>url==='/api/developer/pcns'?{items:[{id:record.id},{id:second}]}:correctionData());
  const mounted=await tools.mount(page.root);mounted.corrections.state.selected.add(record.id);await page.get('loadCorrections').events.click();
  page.get('changeCorrectionSelection').events.click();
  for(const [id,checked] of [[record.id,false],[second,true]]){
    const checkbox=descendant(page.get('correctionChoices'),node=>node.tagName==='INPUT'&&node.value===id);checkbox.checked=checked;checkbox.events.change();
  }
  assert.equal(page.get('resumeCorrectionEditing').hidden,true);
  page.get('resumeCorrectionEditing').events.click();assert.equal(page.get('correctionSelectionStage').hidden,false);
});

test('a partial load can return to its loaded document with edits intact when the selection has not changed', async () => {
  const second='S-24112601';const page=fixture(url=>{
    if(url==='/api/developer/pcns')return {items:[{id:record.id},{id:second}]};
    if(url.includes(second))throw new Error('Document unavailable');return correctionData();
  });
  const mounted=await tools.mount(page.root);mounted.corrections.state.selected.add(record.id);mounted.corrections.state.selected.add(second);
  await page.get('loadCorrections').events.click();
  const input=byAttribute(page.get('correctionEditors'),'data-correction-field','text');input.value='Keep my edit';input.events.input();
  page.get('changeCorrectionSelection').events.click();const count=page.calls.length;
  assert.equal(page.get('resumeCorrectionEditing').hidden,false);page.get('resumeCorrectionEditing').events.click();
  assert.equal(page.get('correctionEditStage').hidden,false);assert.equal(page.calls.length,count);
  assert.equal(mounted.corrections.state.entries[0].edited.changeRows[0].text,'Keep my edit');
});

test('bulk preview submits only changed documents and keeps failed edits after partial conflicts', async () => {
  const second = 'S-24112601';
  const page = fixture((url, options) => {
    if (url === '/api/developer/pcns') return { items: [{ id: record.id }, { id: second }] };
    if (url === '/api/developer/pcns/corrections') return { results: [
      { id: record.id, success: true, changed: true, version: '0000000000000002' },
      { id: second, success: false, status: 409, error: 'PCN changed' }] };
    const data = correctionData(url.includes(second) ? second : record.id);
    if (options === undefined && page.calls.some(call => call.options?.method === 'POST')) {
      data.record.reason = 'Shared correction'; data.record.version = '0000000000000002';
    }
    return data;
  });
  const mounted = await tools.mount(page.root);
  mounted.corrections.state.selected.add(record.id); mounted.corrections.state.selected.add(second);
  await page.get('loadCorrections').events.click();
  page.get('sharedCorrectionField').value = 'reason'; page.get('sharedCorrectionValue').value = 'Shared correction';
  page.get('setSharedCorrection').events.click();
  page.get('correctionReason').value = 'Fix imported information'; page.get('previewCorrections').events.click();
  assert.equal(page.get('correctionPreviewDialog').open, true);
  await page.get('applyCorrections').events.click();
  const sent = JSON.parse(page.calls.find(call => call.options?.method === 'POST').options.body);
  assert.equal(sent.items.length, 2); assert.equal(sent.reason, 'Fix imported information');
  assert.deepEqual(sent.items[0].changes, { reason: 'Shared correction' });
  assert.equal(page.get('correctionPreviewDialog').open, false);
  assert.match(page.get('correctionResults').textContent, /Saved/); assert.match(page.get('correctionResults').textContent, /409|conflict/);
  assert.deepEqual(tools.correctionPreview(mounted.corrections.state.entries).map(item => item.id), [second]);
});

test('access loss during correction loading clears all document editors and blocks later correction requests', async () => {
  const page = fixture(url => {
    if (url === '/api/developer/pcns') return { items: [{ id: record.id }] };
    throw Object.assign(new Error('Access denied'), { status: 403 });
  });
  const mounted = await tools.mount(page.root); mounted.corrections.state.selected.add(record.id);
  await page.get('loadCorrections').events.click();
  assert.equal(page.get('developerMain').hidden, true); assert.equal(mounted.corrections.state.entries.length, 0);
  const count = page.calls.length; mounted.corrections.state.selected.add(record.id);
  await page.get('loadCorrections').events.click(); assert.equal(page.calls.length, count);
});

test('unsign confirmation lists cascading signatures and completed-document reopening', async () => {
  const page = fixture(url => url === '/api/developer/pcns' ? { items: [{ id: record.id }] } : {
    ...correctionData(), signatures: [{ path: 'signoff.gscTet.prepared', label: 'GSC Prepared',
      clears: ['signoff.gscTet.prepared', 'supplierSignoff.approved'], reopens: true },
    { path: 'supplierSignoff.approved', label: 'Header Approved', clears: ['supplierSignoff.approved'], reopens: true }] });
  const mounted = await tools.mount(page.root); mounted.corrections.state.selected.add(record.id); await page.get('loadCorrections').events.click();
  const document = page.get('correctionEditors').children[0];
  byAttribute(document,'data-unsign-select').value = 'signoff.gscTet.prepared'; byAttribute(document,'data-unsign-preview').events.click();
  const content = page.get('unsignImpact').children.map(node => node.textContent || node.children.map(child => child.textContent).join(' ')).join(' ');
  assert.match(content, /GSC Prepared/); assert.match(content, /Header Approved/); assert.match(content, /reopen/);
  assert.equal(page.get('unsignDialog').open, true);
});

test('successful unsign uses authoritative response and cannot resubmit a saved removal if a refresh fails', async () => {
  let removed = false;
  const page = fixture((url, options) => {
    if (url === '/api/developer/pcns') return { items: [{ id: record.id }] };
    if (options?.method === 'POST') { removed = true; return { id: record.id, version: '0000000000000002', status: 'submitted', cleared: ['signoff.gscTet.prepared'], reopened: true }; }
    if (removed) throw new Error('Details unavailable after save');
    return { ...correctionData(), signatures: [{ path: 'signoff.gscTet.prepared', label: 'GSC Prepared', clears: ['signoff.gscTet.prepared'], reopens: true }] };
  });
  const mounted = await tools.mount(page.root); mounted.corrections.state.selected.add(record.id); await page.get('loadCorrections').events.click();
  const document = page.get('correctionEditors').children[0];
  byAttribute(document,'data-unsign-select').value = 'signoff.gscTet.prepared'; byAttribute(document,'data-unsign-preview').events.click();
  page.get('unsignReason').value = 'Remove incorrect signature'; await page.get('confirmUnsign').events.click();
  assert.equal(page.get('unsignDialog').open, false);
  assert.equal(mounted.corrections.state.entries[0].original.version, '0000000000000002');
  assert.deepEqual(mounted.corrections.state.entries[0].signatures, []);
  await page.get('confirmUnsign').events.click();
  assert.equal(page.calls.filter(call => call.options?.method === 'POST').length, 1);
});
