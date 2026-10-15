const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const actions = ['prepared', 'checked', 'approved'];
const groups = ['signoff.gscTet', 'signoff.prodEngTet', 'signoff.qaTet', 'tapbu.gsc', 'tapbu.qa', 'qateFinal.signoff'];
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function workbook(controls = []) {
  const window = {};
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
    const controls = ['approve', 'reject', 'reason', 'completedDate'].map(field => control(`qateFinal.${field}`));
    const api = workbook(controls); api.state.user = user; api.updateApprovalCheckLocks();
    assert.ok(controls.every(item => item.disabled === !allowed), JSON.stringify(user));
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
  const document = { addEventListener() {}, createElement() { return { dataset: {}, appendChild(child) { cards.push(child.key); } }; } };
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
