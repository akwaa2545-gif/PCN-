const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function editor() {
  const window = { location: { hash: '' } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'window.EDITOR_TEST = { state, els, getMailRoutingPayload, mergeLegacyRecipients };})();');
  vm.runInNewContext(source, { window, document: { addEventListener() {} } });
  return window.EDITOR_TEST;
}

test('routing save carries the exact server version and only explicit editable groups', () => {
  const api = editor();
  api.state.notificationSettings = { schemaVersion: 2, version: 'a'.repeat(64), groups: [], legacyGroups: [{ key: 'signoff.gscTet', emails: 'old@example.test' }] };
  const input = { value: 'new@example.test', dataset: {} };
  api.els.notificationGroups = { querySelectorAll: () => [{ dataset: { notificationGroup: 'department.gscTet.approved' }, querySelectorAll: () => [input] }] };
  const result = JSON.parse(JSON.stringify(api.getMailRoutingPayload()));
  assert.deepEqual(result, { schemaVersion: 2, version: 'a'.repeat(64), groups: [{ key: 'department.gscTet.approved', emails: 'new@example.test', recipients: [{ email: 'new@example.test', displayName: '', jobTitle: '', department: '', photo: '' }] }] });
  assert.equal(Object.hasOwn(result, 'legacyGroups'), false);
});

test('explicit legacy copy merges case-insensitively without editing its source', () => {
  const api = editor();
  const target = [{ email: 'member@example.test', displayName: 'Current' }];
  const source = [{ email: 'MEMBER@example.test', displayName: 'Old' }, { email: 'other@example.test', displayName: 'Legacy person', photo: 'photo' }];
  const snapshot = JSON.stringify({ target, source });
  const result = JSON.parse(JSON.stringify(api.mergeLegacyRecipients(target, source)));
  assert.deepEqual(result, [...target, source[1]]);
  assert.equal(JSON.stringify({ target, source }), snapshot);
});
