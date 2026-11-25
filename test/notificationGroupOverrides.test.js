const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultNotificationPreferences, validateNotificationPreferences, readNotificationPreferences,
  notificationPreferencesView, selectNotificationRecipients, filterNotificationRecipients } = require('../src/notificationPreferences');
const { notificationRecipient } = require('../src/notificationUpdates');
const { filteredPreferenceMail } = require('../src/notificationPreferenceRuntime');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (n, changes = {}) => ({ id: id(n), employeeCode: String(n).padStart(7, '0'), isActive: true,
  identityProvider: 'employee-code', roles: ['developer'], department: 'developer', signingStep: null,
  email: `user${n}@example.test`, mailDirectoryId: `directory-${n}`, mailVerifiedAt: '2026-11-24T00:00:00Z',
  mailProfile: { id: `directory-${n}`, email: `user${n}@example.test` }, ...changes });
const record = { id: 'S-24112601', status: 'submitted', ownerUserId: id(9) };
function policy(type, changes = {}) {
  const preferences = defaultNotificationPreferences();
  preferences.rules[type] = { ...preferences.rules[type], ...changes };
  return { notificationPreferences: preferences };
}
const input = settings => ({ schemaVersion: 1, version: 'a'.repeat(64), rules: settings.notificationPreferences.rules });

test('Developer group projection shows the three existing general default deliveries without explicit selections', () => {
  const dev = user(1), settings = policy('submitted');
  const view = notificationPreferencesView(settings, [dev]);
  const group = view.options.groups.find(group => group.key === 'role.developer');
  assert.deepEqual(group.defaultTypes, ['submitted', 'updated', 'completed']);
  assert.equal(group.defaultModes.submitted, 'general');
  assert.equal(group.defaultModes.actionRequired, 'none');
  assert.deepEqual(group.members, [dev.id]);
  assert.deepEqual(notificationPreferencesView(settings).options.groups.find(group => group.key === 'role.developer').defaultTypes, ['submitted', 'updated', 'completed']);
  for (const type of ['submitted', 'updated', 'completed']) {
    const audience = [notificationRecipient(dev, record, ['gscTet'])].filter(Boolean);
    assert.deepEqual(selectNotificationRecipients(settings, type, { record, users: [dev], defaultRecipients: audience }).recipients.map(item => item.email), [dev.email]);
  }
});

test('group Off suppresses default manual addresses, custom overlapping groups and queued old snapshots', () => {
  const dev = user(1), qa = user(2, { roles: ['qa'], department: 'qaTet', signingStep: 'prepared' });
  const settings = policy('updated', { groupKeys: ['role.qa'], excludedGroupKeys: ['role.developer'] });
  const defaultRecipients = [{ email: dev.email.toUpperCase() }, { email: qa.email }];
  const result = selectNotificationRecipients(settings, 'updated', { record, users: [dev, qa], defaultRecipients });
  assert.deepEqual(result.recipients.map(item => item.email), [qa.email]);
  const old = [{ email: dev.email, source: 'default' }, { email: qa.email, source: 'default' }];
  assert.deepEqual(filterNotificationRecipients(settings, 'updated', old, { record, users: [dev, qa], defaultRecipients }).recipients.map(item => item.email), [qa.email]);
  const payload = { to: `${dev.email}; ${qa.email}`, subject: 'Earlier queued mail' };
  assert.equal(filteredPreferenceMail(settings, ['updated'], payload, { record, users: [dev, qa], defaultRecipients }).to, qa.email);
  const reviewer = user(3, { roles: ['qa', 'reviewer'], department: 'qaTet', signingStep: 'checked' });
  const overlapping = policy('updated', { includeDefaultRecipients: false, groupKeys: ['role.reviewer', 'department.qaTet.checked'], excludedGroupKeys: ['role.qa'] });
  assert.deepEqual(selectNotificationRecipients(overlapping, 'updated', { record, users: [reviewer] }).recipients, []);
});

test('priority is global Off, individual Exclude, individual Include, group Off, group/default delivery', () => {
  const dev = user(1), context = { record, users: [dev], defaultRecipients: dev.email };
  const off = { excludedGroupKeys: ['role.developer'], userIds: [dev.id] };
  assert.deepEqual(selectNotificationRecipients(policy('updated', off), 'updated', context).recipients.map(item => item.email), [dev.email]);
  const excluded = { excludedGroupKeys: ['role.developer'], excludedUserIds: [dev.id] };
  assert.deepEqual(selectNotificationRecipients(policy('updated', excluded), 'updated', context).recipients, []);
  assert.deepEqual(selectNotificationRecipients(policy('updated', { ...off, enabled: false }), 'updated', context), { enabled: false, recipients: [] });
  assert.deepEqual(selectNotificationRecipients(policy('updated', { excludedGroupKeys: ['role.developer'] }), 'updated', context).recipients, []);
});

test('group Off matches only current verified Developer assignments and individual Include cannot bypass access', () => {
  const dev = user(1), malformed = user(2, { roles: ['developer', 'qa'], department: 'qaTet', signingStep: 'prepared' });
  const settings = policy('updated', { excludedGroupKeys: ['role.developer'] });
  assert.deepEqual(selectNotificationRecipients(settings, 'updated', { record, users: [dev, malformed], defaultRecipients: `${dev.email}; ${malformed.email}` }).recipients.map(item => item.email), [malformed.email]);
  const supplier = user(3, { roles: ['supplier'], department: null });
  const inaccessible = policy('updated', { includeDefaultRecipients: false, excludedGroupKeys: ['role.supplier'], userIds: [supplier.id] });
  assert.deepEqual(selectNotificationRecipients(inaccessible, 'updated', { record, users: [supplier] }).recipients, []);
});

test('old five-field rules roundtrip and optional group exclusions validate without case normalization', () => {
  const old = input(policy('submitted'));
  assert.deepEqual(validateNotificationPreferences(old), old);
  assert.equal(Object.keys(readNotificationPreferences(policy('submitted')).rules.submitted).length, 5);
  const empty = input(policy('submitted', { excludedGroupKeys: [] }));
  assert.deepEqual(validateNotificationPreferences(empty).rules.submitted.excludedGroupKeys, []);
  assert.equal(Object.hasOwn(readNotificationPreferences(policy('submitted', { excludedGroupKeys: [] })).rules.submitted, 'excludedGroupKeys'), false);
  const accepted = input(policy('submitted', { excludedGroupKeys: ['role.developer'] }));
  assert.deepEqual(validateNotificationPreferences(accepted).rules.submitted.excludedGroupKeys, ['role.developer']);
  for (const value of [['role.Developer'], ['unknown'], ['role.developer', 'role.developer'], 'role.developer']) {
    assert.throws(() => validateNotificationPreferences(input(policy('submitted', { excludedGroupKeys: value }))), { statusCode: 400 });
  }
  assert.throws(() => validateNotificationPreferences(input(policy('submitted', { excludedGroupKeys: ['role.developer'], groupKeys: ['role.developer'] }))), { statusCode: 400 });
});

test('workflow defaults for Developer require actual manual routing while assigned departments expose conditional defaults', () => {
  const dev = user(1), qa = user(2, { roles: ['qa'], department: 'qaTet', signingStep: 'prepared' });
  const settings = { ...policy('actionRequired'), schemaVersion: 2, groups: [{ key: 'department.qaTet.prepared', emails: dev.email }] };
  const groups = notificationPreferencesView(settings, [dev, qa]).options.groups;
  const developer = groups.find(group => group.key === 'role.developer');
  for (const type of ['actionRequired', 'dueSoon', 'overdue']) {
    assert.ok(developer.defaultTypes.includes(type)); assert.equal(developer.defaultModes[type], 'routing');
  }
  assert.equal(groups.find(group => group.key === 'department.qaTet.checked').defaultModes.actionRequired, 'none');
  assert.equal(groups.find(group => group.key === 'role.qa').defaultModes.actionRequired, 'assigned');
  assert.equal(groups.find(group => group.key === 'role.supplier').defaultModes.submitted, 'ownPcns');
  assert.equal(groups.find(group => group.key === 'role.admin').defaultModes.submitted, 'departmentEvents');
});

test('late group Off filters new preference snapshots without adding newly enabled recipients', () => {
  const dev = user(1), qa = user(2, { roles: ['qa'], department: 'qaTet', signingStep: 'prepared' });
  const initial = policy('updated', { groupKeys: ['role.developer'] });
  const saved = selectNotificationRecipients(initial, 'updated', { record, users: [dev], defaultRecipients: dev.email }).recipients;
  const latest = policy('updated', { excludedGroupKeys: ['role.developer'], groupKeys: ['role.qa'] });
  const payload = { to: dev.email, notificationPreferenceSnapshot: { type: 'updated', batchIndex: 0, recipients: saved } };
  assert.equal(filteredPreferenceMail(latest, ['updated'], payload, { record, users: [dev, qa], defaultRecipients: `${dev.email}; ${qa.email}` }), null);
});

test('TA and SC department Off preserves canonical camel-case keys through validation, read and delivery', () => {
  for (const department of ['prodEngTa', 'prodEngSc']) {
    const person = user(2, { roles: ['productionengineering'], department, signingStep: 'prepared' });
    const groupKey = `department.${department}.prepared`;
    const settings = policy('actionRequired', { excludedGroupKeys: [groupKey] });
    const validated = validateNotificationPreferences(input(settings));
    assert.deepEqual(validated.rules.actionRequired.excludedGroupKeys, [groupKey]);
    assert.deepEqual(readNotificationPreferences(settings).rules.actionRequired.excludedGroupKeys, [groupKey]);
    assert.deepEqual(selectNotificationRecipients(settings, 'actionRequired', { record, users: [person], defaultRecipients: person.email }).recipients, []);
  }
});

test('individual exclusion wins across shared mailboxes while group Off still permits a valid individual Include', () => {
  const dev = user(1), shared = user(2, { roles: ['qa'], department: 'qaTet', signingStep: 'prepared',
    email: dev.email, mailProfile: { id: 'directory-2', email: dev.email } });
  const included = policy('updated', { excludedGroupKeys: ['role.developer'], userIds: [shared.id] });
  assert.deepEqual(selectNotificationRecipients(included, 'updated', { record, users: [dev, shared], defaultRecipients: dev.email }).recipients.map(item => item.email), [dev.email]);
  const excluded = policy('updated', { excludedGroupKeys: ['role.developer'], userIds: [shared.id], excludedUserIds: [dev.id] });
  assert.deepEqual(selectNotificationRecipients(excluded, 'updated', { record, users: [dev, shared], defaultRecipients: dev.email }).recipients, []);
});

test('individual exclusions normalize case and whitespace aliases even for inactive unverified manual contacts', () => {
  const dev = user(1), alias = user(2, { roles: ['qa'], department: 'qaTet', signingStep: 'prepared',
    email: ` ${dev.email.toUpperCase()} `, mailProfile: { id: 'directory-2', email: dev.email.toUpperCase() } });
  const saved = selectNotificationRecipients(policy('updated'), 'updated', { record, users: [dev], defaultRecipients: dev.email }).recipients;
  for (const excluded of [alias, { ...alias, isActive: false, mailVerifiedAt: null, mailProfile: null }]) {
    const settings = policy('updated', { userIds: [dev.id], excludedUserIds: [excluded.id] });
    const context = { record, users: [dev, excluded], defaultRecipients: dev.email };
    assert.deepEqual(selectNotificationRecipients(settings, 'updated', context).recipients, []);
    assert.deepEqual(filterNotificationRecipients(settings, 'updated', saved, context).recipients, []);
    assert.equal(filteredPreferenceMail(settings, ['updated'], { to: dev.email }, context), null);
  }
});

test('Developer group membership uses exact exclusive role spelling without punctuation or whitespace aliases', () => {
  const valid = user(1, { roles: ['Developer'] });
  const invalid = [user(2, { roles: ['deve-loper'] }), user(3, { roles: [' developer '] }),
    user(4, { roles: ['developer', 'admin'] }), user(5, { department: 'qaTet' }), user(6, { signingStep: 'prepared' })];
  const users = [valid, ...invalid];
  const included = policy('updated', { includeDefaultRecipients: false, groupKeys: ['role.developer'] });
  assert.deepEqual(selectNotificationRecipients(included, 'updated', { record, users }).recipients.map(recipient => recipient.email), [valid.email]);
  assert.deepEqual(notificationPreferencesView(included, users).options.groups.find(group => group.key === 'role.developer').members, [valid.id]);
  const excluded = policy('updated', { excludedGroupKeys: ['role.developer'] });
  assert.deepEqual(selectNotificationRecipients(excluded, 'updated', { record, users, defaultRecipients: users.map(user => user.email).join('; ') }).recipients.map(recipient => recipient.email), invalid.map(user => user.email));
});

test('supplier notification and supported legacy routes project action requests without inventing deadline delivery', () => {
  const dev = user(1);
  for (const settings of [
    { schemaVersion: 2, groups: [{ key: 'supplierNotification', emails: dev.email }], legacyGroups: [] },
    { schemaVersion: 2, groups: [], legacyGroups: [{ key: 'signoff.gscTet', emails: dev.email }] },
    { groups: [{ key: 'signoff.gscTet', emails: dev.email }] }
  ]) {
    const group = notificationPreferencesView(settings, [dev]).options.groups.find(group => group.key === 'role.developer');
    assert.equal(group.defaultModes.actionRequired, 'routing');
    assert.equal(group.defaultModes.dueSoon, 'none'); assert.equal(group.defaultModes.overdue, 'none');
  }
  const ignored = notificationPreferencesView({ schemaVersion: 2, groups: [{ key: 'signoff.gscTet', emails: dev.email }], legacyGroups: [] }, [dev]);
  assert.equal(ignored.options.groups.find(group => group.key === 'role.developer').defaultModes.actionRequired, 'none');
});

test('department default modes follow verified member roles and actual signing assignments', () => {
  const viewer = user(1, { roles: [], department: 'qaTet', signingStep: null });
  const admin = user(2, { roles: ['admin'], department: 'qaTet', signingStep: null });
  const qa = user(3, { roles: ['qa'], department: 'qaTet', signingStep: 'prepared' });
  const groupFor = users => notificationPreferencesView({}, users).options.groups.find(group => group.key === 'department.qaTet.any');
  const empty = groupFor([]);
  assert.deepEqual(empty.defaultTypes, []);
  const own = groupFor([viewer]);
  assert.equal(own.defaultModes.updated, 'ownPcns'); assert.equal(own.defaultModes.actionRequired, 'none');
  const scoped = groupFor([admin]);
  assert.equal(scoped.defaultModes.updated, 'departmentEvents'); assert.equal(scoped.defaultModes.actionRequired, 'none');
  const assigned = groupFor([qa]);
  assert.equal(assigned.defaultModes.updated, 'general'); assert.equal(assigned.defaultModes.actionRequired, 'assigned');
  const mixed = groupFor([viewer, admin, qa]);
  assert.equal(mixed.defaultModes.updated, 'conditional'); assert.equal(mixed.defaultModes.actionRequired, 'assigned');
});

test('populated role groups derive general delivery from actual member roles including Administrator precedence', () => {
  const adminQa = user(1, { roles: ['admin', 'qa'], department: 'qaTet', signingStep: null });
  const supplierReviewer = user(2, { roles: ['supplier', 'reviewer'], department: null, signingStep: null });
  const adminIt = user(3, { roles: ['admin'], department: 'it', signingStep: null });
  const qa = user(4, { roles: ['qa'], department: 'qaTet', signingStep: 'prepared' });
  const groups = users => notificationPreferencesView({}, users).options.groups;
  assert.equal(groups([adminQa]).find(group => group.key === 'role.qa').defaultModes.updated, 'departmentEvents');
  assert.equal(groups([supplierReviewer]).find(group => group.key === 'role.supplier').defaultModes.updated, 'general');
  assert.equal(groups([adminIt]).find(group => group.key === 'role.admin').defaultModes.updated, 'none');
  assert.equal(groups([adminQa, qa]).find(group => group.key === 'role.qa').defaultModes.updated, 'conditional');
  assert.deepEqual(groups([]).find(group => group.key === 'role.developer').defaultTypes, ['submitted', 'updated', 'completed']);
});
