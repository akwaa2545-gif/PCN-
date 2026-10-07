const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function editor() {
  const window = { location: { hash: '' } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'window.EDITOR_TEST = { state, els, getMailRoutingPayload, mergeLegacyRecipients, isValidEmail, getEditorGroupRecipients, getRecipientAdditionIssue, recipientTargetLabel, getDirectorySelectionIssue };})();');
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

test('empty routing lists still save all sixteen explicit groups without blank recipients', () => {
  const api = editor();
  const keys = ['gscTet', 'prodEngTet', 'qaTet', 'gscTapbu', 'qaTapbu']
    .flatMap(department => ['approved', 'checked', 'prepared'].map(action => `department.${department}.${action}`))
    .concat('supplierNotification');
  api.state.notificationSettings = { schemaVersion: 2, version: 'b'.repeat(64), groups: [] };
  api.els.notificationGroups = { querySelectorAll: () => keys.map(key => ({ dataset: { notificationGroup: key }, querySelectorAll: () => [] })) };
  const result = JSON.parse(JSON.stringify(api.getMailRoutingPayload()));
  assert.equal(result.groups.length, 16);
  assert.deepEqual(result.groups.map(group => group.key), keys);
  assert(result.groups.every(group => group.emails === '' && group.recipients.length === 0));
});

test('one recipient field accepts one email and rejects separators', () => {
  const api = editor();
  assert.equal(api.isValidEmail('person@example.test'), true);
  for (const value of ['person@example.test;', 'person@example.test,', 'a@example.test;b@example.test', 'a@example.test,b@example.test']) {
    assert.equal(api.isValidEmail(value), false, value);
  }
});

test('dirty editor keeps raw separators, whitespace and explicitly added blank rows', () => {
  const api = editor();
  const group = { key: 'department.gscTet.approved', emails: 'saved@example.test', recipients: [] };
  const drafts = [{ email: 'a@example.test;b@example.test', inputValue: '  a@example.test;b@example.test  ', verifiedEmail: '' }, { email: '', inputValue: '', verifiedEmail: '' }];
  api.state.mailDraftRows = { [group.key]: drafts };
  const result = JSON.parse(JSON.stringify(api.getEditorGroupRecipients(group)));
  assert.deepEqual(result, drafts);
  assert.equal(result.length, 2);
  api.state.mailDraftRows = { [group.key]: [] };
  assert.equal(api.getEditorGroupRecipients(group).length, 0, 'Removing all draft rows does not restore saved rows');
  assert.deepEqual(JSON.parse(JSON.stringify(api.getEditorGroupRecipients({ key: 'department.qaTet.approved', emails: 'other@example.test' }))), [{ email: 'other@example.test' }]);
});

test('recipient popup labels the department and signing step or supplier purpose', () => {
  const api = editor();
  assert.equal(api.recipientTargetLabel({ label: 'GSC/TET Approved', action: 'approved' }), 'GSC/TET — Approved');
  assert.equal(api.recipientTargetLabel({ label: 'QA/TaPBU Prepared', action: 'prepared' }), 'QA/TaPBU — Prepared');
  assert.equal(api.recipientTargetLabel({ label: 'GSC/TET Supplier Notification', action: null }), 'GSC/TET Supplier Notification');
});

test('popup confirmation rejects invalid, duplicate and over-limit recipients', () => {
  const api = editor();
  assert.equal(api.getRecipientAdditionIssue('new@example.test', ['saved@example.test']), '');
  assert.match(api.getRecipientAdditionIssue('bad;value', []), /directory/i);
  assert.match(api.getRecipientAdditionIssue('SAVED@example.test', ['saved@example.test']), /already/i);
  assert.match(api.getRecipientAdditionIssue('new@example.test', Array.from({ length: 30 }, (_, index) => `person${index}@example.test`)), /30/);
  assert.match(api.getRecipientAdditionIssue('new@example.test', [`${'a'.repeat(985)}@example.test`]), /1,000/);
});

test('popup requires a current directory selection and configured lookup', () => {
  const api = editor();
  const targetKey = 'department.gscTet.approved';
  const input = { value: 'reviewer@example.test', dataset: { directoryLookupState: 'verified' } };
  const selection = { targetKey, email: 'reviewer@example.test', recipient: { email: 'reviewer@example.test' } };
  assert.equal(api.getDirectorySelectionIssue(input, selection, true, targetKey), '');
  assert.match(api.getDirectorySelectionIssue(input, null, true, targetKey), /select/i);
  assert.match(api.getDirectorySelectionIssue(input, selection, false, targetKey), /unavailable/i);
  assert.match(api.getDirectorySelectionIssue(input, selection, true, 'department.qaTet.approved'), /select/i);
  assert.match(api.getDirectorySelectionIssue({ ...input, value: 'typed@example.test' }, selection, true, targetKey), /select/i);
  for (const directoryLookupState of ['queued', 'searching', 'no-match', 'failed']) {
    assert.match(api.getDirectorySelectionIssue({ ...input, dataset: { directoryLookupState } }, selection, true, targetKey), /select/i);
  }
});
