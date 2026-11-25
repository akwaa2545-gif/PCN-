const test = require('node:test');
const assert = require('node:assert/strict');
const baseline = require('../src/masterData');
const { validateChangeCategories, categorySettings, publicMaster, recordMaster, buildDefinition, baselineDefinition } = require('../src/changeCategories');

const master = () => ({ ...baselineDefinition(), versionId: 1 });
const payload = () => ({ ...categorySettings(master()), reason: 'Update change categories' });

test('category settings support wording, additions, disabled options and risk changes without changing workflow definitions', () => {
  const input = payload();
  input.forms.packaging[0] = { text: 'Updated packaging category', risk: 'RL1', enabled: false };
  input.forms.packaging.push({ text: 'New packaging category', risk: 'RL0', enabled: true });
  const before = master();
  const result = buildDefinition(before, validateChangeCategories(input), { id: 'publication-1', time: '2026-11-24T00:00:00Z', actor: 'user:admin' });
  assert.equal(result.formDefinitions.packaging.riskOptions[0].text, 'Updated packaging category');
  assert.equal(result.formDefinitions.packaging.riskOptions.at(-1).risk, 'RL0');
  assert.deepEqual(result.workflowBase, before.workflowBase);
  assert.equal(before.formDefinitions.packaging.riskOptions[0].text, baseline.formDefinitions.packaging.riskOptions[0].text);
  assert.equal(Object.hasOwn(result, 'versionId'), false);
  assert.equal(result.changeCategoriesPublication.id, 'publication-1');
  assert.equal(publicMaster(result).formDefinitions.packaging.riskOptions.some(row => row.enabled === false), false);
  assert.equal(Object.hasOwn(publicMaster(result), 'changeCategoriesPublication'), false);
  assert.equal(categorySettings({ ...result, versionId: 2 }).forms.packaging[0].enabled, false);
});

test('master data schema rejects protected fields, unsafe entries, duplicate categories and empty enabled lists', () => {
  const invalid = [];
  for (const patch of [{ versionId: 0 }, { versionId: '1' }, { reason: '' }, { versionId: 1.5 }, { workflowBase: [] }]) invalid.push({ ...payload(), ...patch });
  for (const row of [{ text: '', risk: 'RL1', enabled: true }, { text: 'x'.repeat(501), risk: 'RL1', enabled: true },
    { text: 'Valid', risk: 'RL4', enabled: true }, { text: 'Valid', risk: 'RL1', enabled: 'true' }, { text: 'Valid', risk: 'RL1', enabled: true, id: 'arbitrary' }]) {
    const input = payload(); input.forms.rawMaterial[0] = row; invalid.push(input);
  }
  for (const rows of [[], Array(101).fill({ text: 'Category', risk: 'RL1', enabled: true }),
    [{ text: 'Same', risk: 'RL1', enabled: true }, { text: ' same ', risk: 'RL2', enabled: true }],
    [{ text: 'Disabled', risk: 'RL1', enabled: false }]]) {
    const input = payload(); input.forms.packaging = rows; invalid.push(input);
  }
  for (const input of invalid) assert.throws(() => validateChangeCategories(input), { statusCode: 400 });
  assert.equal(categorySettings(master()).forms.rawMaterial.every(row => row.enabled), true);
});

test('existing documents resolve their pinned snapshot; null legacy uses baseline and missing pinned version fails closed', async () => {
  const calls = [];
  const repository = { async getMasterData(id) { calls.push(id); return { ...master(), versionId: id }; } };
  assert.equal((await recordMaster(repository, { masterDataVersionId: 5 })).versionId, 5);
  const legacy = await recordMaster(repository, {});
  assert.deepEqual(legacy.formDefinitions, baseline.formDefinitions);
  assert.deepEqual(calls, [5]);
  await assert.rejects(recordMaster({ async getMasterData() { throw Object.assign(new Error('Missing'), { statusCode: 503 }); } }, { masterDataVersionId: 99 }), { statusCode: 503 });
});
