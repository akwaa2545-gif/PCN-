const test = require('node:test');
const assert = require('node:assert/strict');
const { SqlNotificationPreferences } = require('../src/sqlNotificationPreferences');
const { defaultNotificationPreferences, validateNotificationPreferences } = require('../src/notificationPreferences');
const { settingsVersion } = require('../src/mailRouting');
const user = { id: '00000000-0000-4000-8000-000000000001', version: '0000000000000001', sessionSecurityStamp: 'stamp' };
function pool() {
  const calls = []; let stored = { schemaVersion: 2, groups: [], legacyGroups: [] };
  const request = () => { const inputs = {}; return { input(name, type, value) { inputs[name] = value; return this; }, async query(statement) {
    calls.push({ statement, inputs });
    if (statement.includes('sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
    if (statement.includes('SELECT IsActive,SecurityStamp,AccessVersion')) return { recordset: [{ IsActive: true, SecurityStamp: 'stamp', AccessVersion: Buffer.from(user.version, 'hex') }] };
    if (statement.includes('RoleName') && !statement.includes('MailProfileJson')) return { recordset: [{ IsActive: true, RoleName: 'admin', DepartmentKey: 'it', SigningStep: null }] };
    if (statement.includes('MailProfileJson')) return { recordset: [] };
    if (statement.includes('SELECT SettingsJson')) return { recordset: [{ SettingsJson: JSON.stringify(stored) }] };
    if (statement.includes('UPDATE pcn.NotificationSettings')) stored = JSON.parse(inputs.json);
    return { recordset: [], rowsAffected: [1] };
  } }; };
  const tx = { request, async begin() { calls.push('begin'); }, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); } };
  return { calls, request, transaction: () => tx, stored: () => structuredClone(stored) };
}

test('SQL stores group Off under existing settings CAS and rejects a same-version old client that omits Off', async () => {
  const db = pool(), adapter = new SqlNotificationPreferences(db);
  const rules = defaultNotificationPreferences().rules;
  rules.updated.excludedGroupKeys = ['role.developer'];
  const saved = await adapter.save({ schemaVersion: 1, version: settingsVersion(db.stored()), rules }, 'fixture-admin', user);
  assert.deepEqual(saved.rules.updated.excludedGroupKeys, ['role.developer']);
  assert.deepEqual(db.stored().notificationPreferences.rules.updated.excludedGroupKeys, ['role.developer']);
  const oldClient = { schemaVersion: 1, version: saved.version, rules: structuredClone(saved.rules) };
  delete oldClient.rules.updated.excludedGroupKeys;
  db.calls.length = 0;
  await assert.rejects(adapter.save(validateNotificationPreferences(oldClient), 'fixture-admin', user), { statusCode: 409 });
  assert.equal(db.calls.at(-1), 'rollback');
  assert.equal(db.calls.some(call => call.statement?.includes('UPDATE pcn.NotificationSettings')), false);
  assert.deepEqual(db.stored().notificationPreferences.rules.updated.excludedGroupKeys, ['role.developer']);
});

test('explicit empty group exclusions survive API-style validation and clear Off without leaving empty optional storage', async () => {
  const db = pool(), adapter = new SqlNotificationPreferences(db);
  const rules = defaultNotificationPreferences().rules;
  rules.actionRequired.excludedGroupKeys = ['department.prodEngTa.prepared'];
  const saved = await adapter.save({ schemaVersion: 1, version: settingsVersion(db.stored()), rules }, 'fixture-admin', user);
  assert.deepEqual(saved.rules.actionRequired.excludedGroupKeys, ['department.prodEngTa.prepared']);
  const clear = { schemaVersion: 1, version: saved.version, rules: structuredClone(saved.rules) };
  clear.rules.actionRequired.excludedGroupKeys = [];
  clear.rules.actionRequired.groupKeys = ['department.prodEngTa.prepared'];
  const roundtrip = validateNotificationPreferences(clear);
  assert.deepEqual(roundtrip.rules.actionRequired.excludedGroupKeys, []);
  const enabled = await adapter.save(roundtrip, 'fixture-admin', user);
  assert.equal(Object.hasOwn(enabled.rules.actionRequired, 'excludedGroupKeys'), false);
  assert.equal(Object.hasOwn(db.stored().notificationPreferences.rules.actionRequired, 'excludedGroupKeys'), false);
  assert.deepEqual(enabled.rules.actionRequired.groupKeys, ['department.prodEngTa.prepared']);
});
