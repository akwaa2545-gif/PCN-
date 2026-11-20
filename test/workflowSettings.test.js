const test = require('node:test');
const assert = require('node:assert/strict');
const { RULES, defaultWorkflowSettings, validateWorkflowSettings, readWorkflowSettings } = require('../src/workflowSettings');

const input = () => {
  const { schemaVersion, version, pendingDays } = defaultWorkflowSettings();
  return { schemaVersion, version, pendingDays };
};

test('workflow defaults cover eight rules with separate typed PE allowances and QA final review', () => {
  assert.deepEqual(defaultWorkflowSettings(), { schemaVersion: 1, version: 0,
    pendingDays: { gscTet: null, prodEngTet: 3, prodEngTa: 3, prodEngSc: 3, qaTet: 3, gscTapbu: null, qaTapbu: null, qaFinal: null }, updatedAt: null, updatedBy: null });
  assert.equal(RULES.length, 8);
  assert.deepEqual([...new Set(RULES.map(rule => rule.stageKey))], ['signoff.gscTet', 'signoff.prodEngTet', 'signoff.qaTet', 'tapbu.gsc', 'tapbu.qa', 'qateFinal.signoff']);
  assert.equal(RULES.find(rule => rule.key === 'qaFinal').department, 'qaTet');
  const changed = defaultWorkflowSettings(); changed.pendingDays.qaTet = 20;
  assert.equal(defaultWorkflowSettings().pendingDays.qaTet, 3);
});

test('validation accepts only exact schema and bounded integer or disabled rules', () => {
  const valid = input();
  valid.pendingDays.gscTet = 1; valid.pendingDays.qaFinal = 365;
  assert.deepEqual(validateWorkflowSettings(valid), valid);
  for (const invalid of [null, [], {}, { ...input(), schemaVersion: 2 }, { ...input(), version: -1 },
    { ...input(), version: 0.1 }, { ...input(), version: '0' }, { ...input(), updatedBy: 'spoof' },
    { ...input(), pendingDays: [] }, { ...input(), pendingDays: { ...input().pendingDays, unknown: 1 } }]) {
    assert.throws(() => validateWorkflowSettings(invalid), { statusCode: 400 });
  }
  for (const value of [undefined, 0, 366, -1, 1.5, '3', true, {}, NaN]) {
    assert.throws(() => validateWorkflowSettings({ ...input(), pendingDays: { ...input().pendingDays, qaTet: value } }), { statusCode: 400 });
  }
  const missing = input(); delete missing.pendingDays.qaFinal;
  assert.throws(() => validateWorkflowSettings(missing), { statusCode: 400 });
});

test('settings reads default only isolated adapters and propagate SQL/capability failures', async () => {
  assert.deepEqual(await readWorkflowSettings({}), defaultWorkflowSettings());
  const custom = { ...defaultWorkflowSettings(), version: 7 };
  assert.equal(await readWorkflowSettings({ getWorkflowSettings: async () => custom }), custom);
  await assert.rejects(readWorkflowSettings({ isSql: true }), { statusCode: 503 });
  await assert.rejects(readWorkflowSettings({ getWorkflowSettings: async () => { throw new Error('read failed'); } }), /read failed/);
});
