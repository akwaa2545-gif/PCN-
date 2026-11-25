'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const create = require('../create');

const master = (word, risk = 'RL2', versionId = 1) => ({ versionId, formDefinitions: {
  rawMaterial: { id: 'rawMaterial', label: 'Raw material', riskOptions: [{ text: word, risk }] }
}, commonDocuments: [], workflowBase: [], statusDefinitions: [], adminItems: [] });
function form(fetch) {
  const source = fs.readFileSync(require.resolve('../app.js'), 'utf8').replace(/\}\)\(\);\s*$/,
    'populateSelectors=()=>{}; window.TEST={state,loadRecordMaster,activateRecordMaster};})();');
  const window = { location: {}, PCN_SESSION: { fetch } };
  vm.runInNewContext(source, { window, document: { addEventListener() {} }, URLSearchParams });
  return window.TEST;
}

test('existing signed and draft documents render pinned wording and risk while new documents use current enabled categories', async () => {
  const old = master('Original wording'), latest = master('Reworded category', 'RL3', 2), calls = [];
  const app = form(async path => { calls.push(path); return old; });
  app.state.latestMaster = latest;
  for (const status of ['draft', 'submitted', 'closed']) {
    const record = { id: 'T-24112601', masterDataVersionId: 1, status };
    await app.loadRecordMaster(record); app.activateRecordMaster(record);
    assert.equal(app.state.formDefinitions.rawMaterial.riskOptions[0].text, 'Original wording');
    assert.equal(app.state.formDefinitions.rawMaterial.riskOptions[0].risk, 'RL2');
  }
  assert.deepEqual(calls, ['/api/pcns/T-24112601/master-data']);
  app.activateRecordMaster({});
  assert.equal(app.state.formDefinitions.rawMaterial.riskOptions[0].text, 'Reworded category');
});

test('a missing saved master cannot silently fall back to the latest category wording', async () => {
  const app = form(async () => { throw new Error('Saved definition unavailable'); }); app.state.latestMaster = master('Newest');
  await assert.rejects(app.loadRecordMaster({ id: 'S-24112601', masterDataVersionId: 1 }), /unavailable/);
  assert.throws(() => app.activateRecordMaster({ id: 'S-24112601', masterDataVersionId: 1 }), /saved master data/i);
});

test('resumed guided drafts use their saved master while new work uses latest master', () => {
  const old = master('Old'), latest = master('New', 'RL3', 2);
  assert.equal(create.masterForDocument(latest, { masterData: old }, { id: 'T-24112601' }), old);
  assert.equal(create.masterForDocument(latest, {}, null), latest);
  assert.throws(() => create.masterForDocument(latest, {}, { id: 'T-24112601' }), /saved master data/i);
});

test('copying old templates removes disabled or reassigned categories and requires deliberate selection without changing risk', () => {
  const original = { changeForm: 'rawMaterial', riskLevel: 'RL2', selectedChange: 'Custom old wording', currentCondition: 'Keep this context',
    changeRows: [{ optionText: 'Old category', text: 'Custom old wording', risk: 'RL2', currentCondition: 'Keep this context', newCondition: 'Future' }] };
  for (const latest of [master('New category'), master('Old category', 'RL3'),
    { ...master('Old category'), formDefinitions: { rawMaterial: { riskOptions: [{ text: 'Old category', risk: 'RL2', enabled: false }] } } }]) {
    const result = create.templateForMaster(original, latest);
    assert.equal(result.requiresSelection, true); assert.equal(result.document.selectedChange, '');
    assert.equal(result.document.changeRows.length, 0); assert.equal(result.document.riskLevel, 'RL2');
    assert.equal(original.changeRows.length, 1); assert.equal(original.selectedChange, 'Custom old wording');
  }
  const unchanged = create.templateForMaster(original, master('Old category'));
  assert.equal(unchanged.requiresSelection, false); assert.equal(unchanged.document.selectedChange, 'Custom old wording');
});

test('a committed first save retains its code and version when the following master read fails and cannot POST again', async () => {
  const calls = [], notices = [], paths = [], classes = new Set();
  const saved = { id: 'T-24112601', version: '0000000000000001', status: 'draft', documentType: 'ta' };
  const window = { location: {}, PCN_TYPES: require('../pcn-types'), history: { replaceState(a,b,path) { paths.push(path); } },
    PCN_SESSION: { async fetch(path, options) { calls.push({ path, options }); if (options?.method === 'POST') return saved; throw new Error('Definition temporarily unavailable'); } } };
  const document = { addEventListener() {}, body: { classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) } } };
  const source = fs.readFileSync(require.resolve('../app.js'), 'utf8').replace(/\}\)\(\);\s*$/, `
    hideUpdateSuccess=()=>{}; updateStateFromForm=()=>{}; setSaveOverlayVisible=()=>{}; getSubmissionSnapshot=()=>'';
    markSubmissionSaved=()=>{}; renderAll=()=>{}; toApiPayload=()=>({}); showSaveError=()=>{};
    showNotice=(...args)=>window.notices.push(args); els.submitButton={};
    state.apiReady=true; state.activeRequest={documentType:'ta',status:'draft'};
    window.TEST={state,submitActiveRequest};})();`);
  window.notices = notices; vm.runInNewContext(source, { window, document, URLSearchParams });
  await window.TEST.submitActiveRequest('draft');
  assert.equal(window.TEST.state.activeRequest.id, saved.id); assert.equal(window.TEST.state.activeRequest.version, saved.version);
  assert.equal(window.TEST.state.savedRecord.id, saved.id); assert.equal(window.TEST.state.apiReady, false);
  assert.deepEqual(paths, [`/form.html?id=${saved.id}`]);
  assert.equal(notices.some(args => /saved.*reload/i.test(args[1])), true);
  await window.TEST.submitActiveRequest('draft');
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
});

test('a late failed first-save master read cannot lock another draft session', async () => {
  let reject, current = 'draft-A', locked = false, loaded = false;
  const pending = create.refreshSavedMaster({ read: () => new Promise((resolve, fail) => { reject = fail; }),
    current: () => current === 'draft-A', loaded: () => { loaded = true; }, failed: () => { locked = true; } });
  current = 'draft-B'; reject(new Error('Old draft metadata unavailable')); await pending;
  assert.equal(locked, false); assert.equal(loaded, false);
});

test('initial pinned-master failure hides the sheet and prevents latest categories from rendering, changing, or printing an old PCN', async () => {
  const saved = { id: 'T-24112601', masterDataVersionId: 1, status: 'submitted', selectedChange: 'Original wording', riskLevel: 'RL2' };
  const latest = master('Replacement wording', 'RL3', 2), classes = new Set(), sheet = { hidden: false, setAttribute(key) { if(key==='hidden')this.hidden=true; },
    style: { setProperty(key,value,priority) { this[key] = {value,priority}; } } };
  const window = { location: { pathname: `/${saved.id}`, search: '' }, PCN_TYPES: require('../pcn-types'), renders: 0,
    PCN_SESSION: { require: async () => ({ user: { roles: ['admin'] } }), mountProfile() {},
      async fetch(path) { if(path==='/api/master-data')return latest;if(path==='/api/pcns')return [saved];if(path.endsWith('/master-data'))throw new Error('Pinned data unavailable');return saved; } } };
  const document = { addEventListener() {}, querySelectorAll: () => [], getElementById: id => id==='submissionView'?sheet:null,
    body: { classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) } } };
  const source = fs.readFileSync(require.resolve('../app.js'), 'utf8').replace(/\}\)\(\);\s*$/, `
    cacheElements=()=>{els.submitButton={};}; bindEvents=()=>{}; populateSelectors=()=>{}; showNotice=()=>{};
    renderAll=()=>{window.renders++;renderChangeOptions();};window.TEST={init,state,renderChangeOptions,fitPrintedPage};})();`);
  vm.runInNewContext(source, { window, document, URLSearchParams }); await window.TEST.init();
  assert.equal(window.TEST.state.masterUnavailable, true); assert.equal(sheet.hidden, true);
  assert.equal(sheet.style.display.priority, 'important'); assert.equal(window.renders, 0);
  window.TEST.renderChangeOptions(); window.TEST.fitPrintedPage();
  assert.equal(window.TEST.state.activeRequest.selectedChange, 'Original wording'); assert.equal(window.TEST.state.activeRequest.riskLevel, 'RL2');
});
