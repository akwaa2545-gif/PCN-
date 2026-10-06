const test = require('node:test');
const assert = require('node:assert/strict');
const { PcnService } = require('../src/pcnService');
const { mailGroups, normalizeMailRouting, settingsVersion, resolveNextMailTarget } = require('../src/mailRouting');

const legacy = { groups: [{ key: 'signoff.gscTet', label: 'GSC/TET', emails: 'old@example.com', recipients: [{ email: 'old@example.com', displayName: 'Original', photo: '' }] },
  { key: 'supplierNotification', emails: 'supplier@example.com', recipients: [] }] };
function repository(value = legacy) {
  let stored = structuredClone(value);
  return { getNotificationSettings: async () => structuredClone(stored),
    saveNotificationSettings: async (settings, actor, expected) => {
      assert.equal(expected, settingsVersion(stored)); stored = structuredClone(settings);
    } };
}
function input(settings) { return { schemaVersion: 2, version: settings.version, groups: structuredClone(settings.groups) }; }

test('five departments have three separate fixed lists and QA final reuses QA lists', () => {
  assert.equal(mailGroups.length, 16);
  assert.equal(new Set(mailGroups.map(group => group.key)).size, 16);
  assert.deepEqual(mailGroups.slice(0, 3).map(group => group.action), ['approved', 'checked', 'prepared']);
  const review = { signoff: Object.fromEntries(['gscTet', 'prodEngTet', 'qaTet'].map(key => [key, { approved: true, checked: true, prepared: true }])) };
  assert.equal(resolveNextMailTarget({ riskLevel: 'RL0', status: 'submitted', internalReview: review }).groupKey, 'department.qaTet.approved');
  assert.equal(resolveNextMailTarget({ riskLevel: 'RL0', status: 'submitted', internalReview: review }).label, 'QA/TET Final Judgment Approved');
  assert.equal(resolveNextMailTarget({ riskLevel: 'RL0', status: 'draft', internalReview: review }), null);
  assert.equal(resolveNextMailTarget({ riskLevel: 'RL1', status: 'submitted', internalReview: review }).blockedReason, 'tapbu_requirement_not_selected');
  assert.equal(resolveNextMailTarget({ riskLevel: 'RL1', status: 'submitted', internalReview: { ...review, tapbu: { need: true } } }).groupKey, 'department.gscTapbu.approved');
});

test('next target follows Approved Checked Prepared and supplier handoff after final', () => {
  const record = { riskLevel: 'RL0', status: 'submitted', internalReview: { signoff: { gscTet: { approved: true } } } };
  assert.equal(resolveNextMailTarget(record).action, 'checked');
  assert.equal(resolveNextMailTarget({ ...record, internalReview: { signoff: { gscTet: { approved: true, checked: true } } } }).action, 'prepared');
  const completed = { approved: true, checked: true, prepared: true };
  const done = { ...record, internalReview: { signoff: { gscTet: completed, prodEngTet: completed, qaTet: completed }, qateFinal: { signoff: completed } } };
  assert.equal(resolveNextMailTarget(done).groupKey, 'supplierNotification');
});

test('legacy contacts stay unassigned while supplier list is retained without modifying source', () => {
  const before = structuredClone(legacy);
  const normalized = normalizeMailRouting(legacy);
  assert.equal(normalized.schemaVersion, 2);
  assert.match(normalized.version, /^[a-f0-9]{64}$/);
  assert.equal(normalized.groups.length, 16);
  assert.ok(normalized.groups.slice(0, 15).every(group => group.emails === ''));
  assert.equal(normalized.groups[15].emails, 'supplier@example.com');
  assert.deepEqual(normalized.legacyGroups.find(group => group.key === 'signoff.gscTet'), legacy.groups[0]);
  assert.deepEqual(legacy, before);
});

test('v2 settings save preserves server-owned legacy contacts and normalizes selected profiles', async () => {
  const service = new PcnService(repository());
  const request = input(await service.getNotificationSettings());
  request.groups[0].emails = 'one@example.com; ONE@example.com';
  request.groups[0].recipients = [{ email: 'one@example.com', displayName: 'Selected', department: 'QA' }];
  request.legacyGroups = [];
  const saved = await service.updateNotificationSettings(request, 'admin');
  assert.equal(saved.groups[0].emails, 'one@example.com');
  assert.equal(saved.groups[0].recipients[0].displayName, 'Selected');
  assert.equal(saved.legacyGroups.find(group => group.key === 'signoff.gscTet').emails, 'old@example.com');
  await assert.rejects(service.updateNotificationSettings({ groups: [] }), { statusCode: 409 });
  await assert.rejects(service.updateNotificationSettings(request), { statusCode: 409 });
});

test('v2 requires complete unique fixed groups, version, valid emails and outbound limits', async () => {
  const service = new PcnService(repository());
  const original = input(await service.getNotificationSettings());
  const variants = [
    { ...original, version: '' }, { ...original, groups: original.groups.slice(1) },
    { ...original, schemaVersion: 3 }, null, [],
    { ...original, groups: [...original.groups.slice(1), original.groups[1]] },
    { ...original, groups: original.groups.map((group, index) => index ? group : { ...group, key: 'unknown' }) }
  ];
  for (const variant of variants) await assert.rejects(service.updateNotificationSettings(variant), { statusCode: 400 });
  for (const emails of ['invalid', 'not-an-outgoing-address@exa_mple.com', Array.from({ length: 31 }, (_, index) => `person${index}@example.com`).join(';'), `${'x'.repeat(990)}@example.com`]) {
    const variant = structuredClone(original); variant.groups[0].emails = emails;
    await assert.rejects(service.updateNotificationSettings(variant), { statusCode: 400 });
  }
  for (const fields of [{ emails: [] }, { recipients: [null] }, { recipients: {} }]) {
    const variant = structuredClone(original); variant.groups[0] = { ...variant.groups[0], ...fields };
    await assert.rejects(service.updateNotificationSettings(variant), { statusCode: 400 });
  }
});

test('all three actions and all department paths resolve independently', () => {
  const { stageDepartments } = require('../src/mailRouting');
  const completed = { approved: true, checked: true, prepared: true };
  const stages = Object.keys(stageDepartments);
  for (const [index, stageKey] of stages.entries()) {
    for (const [actionIndex, action] of ['approved', 'checked', 'prepared'].entries()) {
      const review = { tapbu: { need: true } };
      for (const [stageIndex, stage] of stages.entries()) {
        const [parent, key] = stage.split('.');
        review[parent] = { ...review[parent], [key]: stageIndex < index ? completed : {} };
      }
      const [parent, key] = stageKey.split('.');
      review[parent][key] = Object.fromEntries(['approved', 'checked', 'prepared'].slice(0, actionIndex).map(flag => [flag, true]));
      const target = resolveNextMailTarget({ status: 'submitted', riskLevel: 'RL1', internalReview: review });
      assert.equal(target.stageKey, stageKey);
      assert.equal(target.groupKey, `department.${stageDepartments[stageKey]}.${action}`);
    }
  }
  assert.equal(resolveNextMailTarget(null), null);
  assert.equal(resolveNextMailTarget({ status: 'closed' }), null);
});

test('public routing response strips integration properties and unsafe profile URLs', () => {
  const source = { groups: [{ key: 'signoff.gscTet', label: 'GSC/TET', emails: 'old@example.com', flowUrl: 'private',
    recipients: [{ email: 'old@example.com', displayName: 'Original', photo: 'https://private.example/?sig=secret', flowUrl: 'private' }] }], flowUrl: 'private' };
  const publicSettings = normalizeMailRouting(source);
  const group = publicSettings.legacyGroups[0];
  assert.equal(group.flowUrl, undefined);
  assert.equal(publicSettings.flowUrl, undefined);
  assert.equal(group.recipients[0].flowUrl, undefined);
  assert.equal(group.recipients[0].photo, '');
  assert.equal(group.recipients[0].displayName, 'Original');
  assert.deepEqual(normalizeMailRouting(null).groups.length, 16);
});
