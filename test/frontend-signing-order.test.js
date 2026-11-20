const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const actions = ['prepared', 'checked', 'approved'];
const groups = ['signoff.gscTet', 'signoff.prodEngTet', 'signoff.qaTet', 'tapbu.gsc', 'tapbu.qa', 'qateFinal.signoff'];
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function workbook(controls = []) {
  const window = { PCN_TYPES: require('../pcn-types') };
  const source = read('app.js').replace(/\}\)\(\);\s*$/, 'window.TEST = { state, els, getApprovalLockRule, approvalSignoffFields, updateApprovalCheckLocks };})();');
  const document = {
    addEventListener() {},
    querySelector(selector) { return controls.find(control => selector.includes(`data-internal-field="${control.dataset.internalField}"`)) || null; },
    querySelectorAll() { return controls; }
  };
  vm.runInNewContext(source, { window, document });
  window.TEST.els.riskLevel = { value: 'RL2' };
  return window.TEST;
}

const control = (field, checked = false) => ({ dataset: { internalField: field }, checked, disabled: false, closest() { return null; } });

test('workbook and print columns keep Prepared, Checked, Approved with their own signature keys', () => {
  const html = read('form.html');
  for (const group of groups) {
    const actual = [...html.matchAll(/data-internal-field="([^"]+)"/g)].map(match => match[1])
      .filter(field => actions.some(action => field === `${group}.${action}`));
    assert.deepEqual(actual, actions.map(action => `${group}.${action}`), group);
    if (group !== 'qateFinal.signoff') {
      for (const action of actions) {
        const key = `${group}.${action}`.replaceAll('.', '\\.');
        const label = new RegExp(`<label class="excel-check"><input[^>]+data-internal-field="${key}"[^>]*\\/><span>([^<]+)<\\/span><\\/label>`).exec(html);
        assert.equal(label?.[1], action[0].toUpperCase() + action.slice(1), `${group}.${action} label`);
      }
    }
  }
  const supplier = [...html.matchAll(/data-internal-field="supplierSignoff\.(prepared|checked|approved)\.checked"/g)].map(match => match[1]);
  assert.deepEqual(supplier, actions);
  assert.deepEqual([...html.matchAll(/class="qate-signoff-head">([^<]+)/g)].map(match => match[1]), ['Prepared', 'Checked', 'Approved']);
  assert.deepEqual([...html.matchAll(/data-internal-field="qateFinal\.signoff\.(prepared|checked|approved)Date"/g)].map(match => match[1]), actions);
});

test('typed PCNs use their own Prod.Eng group while retaining the common signature block', () => {
  for (const documentType of ['ta', 'sc']) {
    const controls = actions.map(action => control(`signoff.gscTet.${action}`, true));
    const api = workbook(controls);
    api.state.activeRequest = { documentType };
    api.state.user = { roles: ['productionengineering'], department: documentType === 'ta' ? 'prodEngTa' : 'prodEngSc', signingStep: 'prepared', isActive: true };
    assert.equal(api.getApprovalLockRule('signoff.prodEngTet.prepared').locked, false);
    api.state.user = { ...api.state.user, department: documentType === 'ta' ? 'prodEngSc' : 'prodEngTa' };
    assert.equal(api.getApprovalLockRule('signoff.prodEngTet.prepared').locked, true);
    api.state.user = { ...api.state.user, department: 'prodEngTet' };
    assert.equal(api.getApprovalLockRule('signoff.prodEngTet.prepared').locked, true);
  }
});

test('browser locks each department in Prepared then Checked then Approved sequence', () => {
  for (const [index, group] of groups.entries()) {
    const controls = groups.flatMap((key, groupIndex) => actions.map(action => control(`${key}.${action}`, groupIndex < index)));
    controls.push(control('tapbu.need', true));
    const api = workbook(controls);
    api.state.user = { roles: ['admin'], isActive: true };
    assert.equal(api.getApprovalLockRule(`${group}.prepared`).locked, false, `${group} starts Prepared`);
    assert.equal(api.getApprovalLockRule(`${group}.checked`).locked, true);
    assert.equal(api.getApprovalLockRule(`${group}.approved`).locked, true);
    controls.find(item => item.dataset.internalField === `${group}.prepared`).checked = true;
    assert.equal(api.getApprovalLockRule(`${group}.checked`).locked, false);
    assert.equal(api.getApprovalLockRule(`${group}.approved`).locked, true);
    controls.find(item => item.dataset.internalField === `${group}.checked`).checked = true;
    assert.equal(api.getApprovalLockRule(`${group}.approved`).locked, false);
    controls.find(item => item.dataset.internalField === `${group}.prepared`).checked = false;
    assert.equal(api.getApprovalLockRule(`${group}.approved`).locked, true, 'a historical Checked signature cannot bypass missing Prepared');
    assert.deepEqual(Array.from(api.approvalSignoffFields()), groups.flatMap(key => actions.map(action => `${key}.${action}`)));
  }
});

test('final judgment fields belong to QA/TET Approved while Administrator and Developer retain authority', () => {
  for (const [user, allowed] of [
    [{ roles: ['qa'], department: 'qaTet', signingStep: 'prepared' }, false],
    [{ roles: ['qa'], department: 'qaTet', signingStep: 'checked' }, false],
    [{ roles: ['qa'], department: 'qaTet', signingStep: 'approved' }, true],
    [{ roles: ['admin'] }, true], [{ roles: ['developer'], department: 'developer' }, true]
  ]) {
    const controls = groups.slice(0, -1).flatMap(group => actions.map(action => control(`${group}.${action}`, true)));
    const judgment = ['approve', 'reject', 'qod206Number', 'completedDate'].map(field => control(`qateFinal.${field}`));
    controls.push(...judgment, control('tapbu.need', true));
    const api = workbook(controls); api.state.user = user; api.updateApprovalCheckLocks();
    assert.ok(judgment.every(item => item.disabled === !allowed), JSON.stringify(user));
  }
});

test('Final Judgment decisions and signatures wait for every required earlier review signature', () => {
  for (const user of [{ roles: ['admin'] }, { roles: ['qa'], department: 'qaTet', signingStep: 'approved' }]) {
    for (const group of groups.slice(0, -1)) {
      for (const action of actions) {
        const controls = groups.slice(0, -1).flatMap(stage => actions.map(step => control(`${stage}.${step}`, true)));
        controls.push(control('tapbu.need', true));
        const judgment = ['approve', 'reject', 'qod206Number', 'completedDate'].map(field => control(`qateFinal.${field}`));
        controls.push(...judgment);
        controls.find(item => item.dataset.internalField === `${group}.${action}`).checked = false;
        const api = workbook(controls); api.state.user = user; api.updateApprovalCheckLocks();
        assert.ok(judgment.every(item => item.disabled), `${group}.${action} is unfinished`);
        assert.equal(api.getApprovalLockRule('qateFinal.approve').locked, true);
        assert.match(judgment[0].title, /Complete all .*signoff checks/);
        if (user.roles.includes('admin')) assert.equal(api.getApprovalLockRule('qateFinal.signoff.prepared').locked, true);
        controls.find(item => item.dataset.internalField === `${group}.${action}`).checked = true;
        api.updateApprovalCheckLocks();
        assert.ok(judgment.every(item => !item.disabled), 'unlock after last missing signature');
      }
    }
  }
});

test('Final Judgment ignores TaPBU signatures only for RL0 or explicit No need', () => {
  for (const [risk, noNeed] of [['RL0', false], ['RL2', true], ['RL2', false]]) {
    const controls = groups.slice(0, 3).flatMap(group => actions.map(action => control(`${group}.${action}`, true)));
    const judgment = control('qateFinal.approve');
    controls.push(control('tapbu.noNeed', noNeed), judgment);
    const api = workbook(controls); api.els.riskLevel.value = risk; api.state.user = { roles: ['admin'] };
    api.updateApprovalCheckLocks();
    assert.equal(judgment.disabled, risk !== 'RL0' && !noNeed);
  }
});

test('top-right header signatures and dates wait for all Final Judgment signatures', () => {
  for (const missing of groups.flatMap(group => actions.map(action => `${group}.${action}`))) {
    const controls = groups.flatMap(group => actions.map(action => control(`${group}.${action}`, true)));
    controls.push(control('tapbu.need', true));
    const header = actions.flatMap(action => [control(`supplierSignoff.${action}.checked`), control(`supplierSignoff.${action}.date`)]);
    controls.push(...header);
    const api = workbook(controls); api.state.user = { roles: ['admin'] };
    controls.find(item => item.dataset.internalField === missing).checked = false;
    api.updateApprovalCheckLocks();
    assert.ok(header.every(item => item.disabled), `${missing} blocks top-right signatures and dates`);
    assert.equal(api.getApprovalLockRule('supplierSignoff.prepared.checked').locked, true);
    assert.match(header[0].title, /before signing the top-right approval/);
    controls.find(item => item.dataset.internalField === missing).checked = true;
    api.updateApprovalCheckLocks();
    assert.ok(header.every(item => !item.disabled), 'complete route unlocks header fields');
  }
});

test('header unlock respects existing signing roles and skipped TaPBU reviews', () => {
  for (const [user, permitted] of [
    [{ roles: ['admin'] }, true], [{ roles: ['reviewer'] }, true], [{ roles: ['supplier'] }, true],
    [{ roles: ['developer'], department: 'developer', signingStep: null }, true],
    [{ roles: ['qa'], department: 'qaTet', signingStep: 'approved' }, false],
    [{ roles: ['developer', 'qa'], department: 'developer' }, false], [{ roles: ['admin'], isActive: false }, false]
  ]) {
    for (const [risk, noNeed] of [['RL0', false], ['RL2', true], ['RL2', false]]) {
      const controls = [...groups.slice(0, 3), 'qateFinal.signoff'].flatMap(group => actions.map(action => control(`${group}.${action}`, true)));
      const header = control('supplierSignoff.prepared.checked');
      controls.push(control('tapbu.noNeed', noNeed), header);
      const api = workbook(controls); api.state.user = user; api.els.riskLevel.value = risk;
      api.updateApprovalCheckLocks();
      assert.equal(header.disabled, !permitted || (risk !== 'RL0' && !noNeed));
    }
  }
});

test('historical previous-group gaps block new signatures without changing saved signatures', () => {
  const controls = groups.flatMap((group, index) => actions.map(action => control(`${group}.${action}`, index < 2)));
  controls.push(control('tapbu.need', true));
  const api = workbook(controls); api.state.user = { roles: ['admin'], isActive: true };
  controls.find(item => item.dataset.internalField === 'signoff.gscTet.prepared').checked = false;
  const before = controls.map(item => item.checked);
  assert.equal(api.getApprovalLockRule('signoff.qaTet.prepared').locked, true, 'complete Prod.Eng does not bypass incomplete GSC');
  api.updateApprovalCheckLocks();
  assert.deepEqual(controls.map(item => item.checked), before);
  assert.equal(controls.find(item => item.dataset.internalField === 'signoff.gscTet.checked').disabled, false, 'saved Checked remains preserved');
});

test('admin current pending action and mail cards follow the same signing order', () => {
  const window = { location: { hash: '' } };
  const cards = [];
  const document = { addEventListener() {}, createElement() { return {
    dataset: {}, setAttribute() {}, addEventListener() {},
    appendChild(child) { if (child.key) cards.push(child.key); },
    append(...children) { children.forEach(child => this.appendChild(child)); }
  }; } };
  const source = read('admin.js').replace(/\}\)\(\);\s*$/, `
    createNotificationGroup = group => group;
    renderLegacyContacts = () => {};
    window.TEST = { state, els, getCurrentSignoffStepLabel, renderNotificationSettings };})();`);
  vm.runInNewContext(source, { window, document });
  const api = window.TEST;
  assert.equal(api.getCurrentSignoffStepLabel({}), 'GSC/TET Prepared');
  assert.equal(api.getCurrentSignoffStepLabel({ internalReview: { signoff: { gscTet: { prepared: true } } } }), 'GSC/TET Checked');
  assert.equal(api.getCurrentSignoffStepLabel({ internalReview: { signoff: { gscTet: { prepared: true, checked: true } } } }), 'GSC/TET Approved');
  const keys = ['gscTet', 'prodEngTet', 'qaTet', 'gscTapbu', 'qaTapbu'].flatMap(department => actions.map(action => `department.${department}.${action}`));
  api.state.notificationSettings = { groups: keys.map(key => ({ key })) };
  api.els.notificationGroups = { innerHTML: '', appendChild() {} };
  api.renderNotificationSettings();
  assert.deepEqual(cards, keys);
});

test('user role choices and filters list signing assignments in workflow order', () => {
  const html = read('admin.html');
  for (const id of ['employeeRole', 'usersRoleFilter']) {
    const select = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)<\\/select>`).exec(html)[1];
    assert.deepEqual([...select.matchAll(/<option value="(prepared|checked|approved)"/g)].map(match => match[1]), actions);
  }
});
