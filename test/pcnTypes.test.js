const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const types = require('../pcn-types');

test('legacy and typed codes validate dates and nonzero two-digit sequences', () => {
  for (const code of ['PCN-2026-0001', 'T-19112601', 'S-29022499']) assert.equal(types.isCode(code), true, code);
  for (const code of ['T-31022601', 'S-29022501', 'T-19112600', 'T-191126100', 't-19112601', 'S-00112601', 'T-19132601', 'PCN-26-0001', null]) assert.equal(types.isCode(code), false, String(code));
  assert.equal(types.parseCode('T-19112601').documentType, 'ta');
  assert.equal(types.parseCode('S-19112602').sequence, 2);
  assert.equal(types.parseCode('PCN-2026-0001').documentType, null);
});

test('typed formatting and Bangkok business days cover midnight and leap dates', () => {
  assert.equal(types.formatCode('ta', '2026-11-19', 1), 'T-19112601');
  assert.equal(types.formatCode('sc', '2026-11-19', 99), 'S-19112699');
  assert.equal(types.bangkokDay(new Date('2026-11-18T16:59:59Z')), '2026-11-18');
  assert.equal(types.bangkokDay(new Date('2026-11-18T17:00:00Z')), '2026-11-19');
  for (const args of [['bad', '2026-11-19', 1], ['ta', '2026-02-30', 1], ['ta', '2026-11-19', 0], ['ta', '2026-11-19', 100], ['ta', '2026-11-19', 1.5]]) assert.throws(() => types.formatCode(...args));
  assert.throws(() => types.bangkokDay(new Date('invalid')));
});

test('one PE stage resolves to the correct team and preserves legacy and shared teams', () => {
  assert.equal(types.departmentForStage({ documentType: 'ta' }, 'signoff.prodEngTet'), 'prodEngTa');
  assert.equal(types.departmentForStage({ id: 'S-19112601' }, 'signoff.prodEngTet'), 'prodEngSc');
  assert.equal(types.departmentForStage({ id: 'PCN-2026-0001' }, 'signoff.prodEngTet'), 'prodEngTet');
  assert.equal(types.departmentForStage({ documentType: 'ta' }, 'qateFinal.signoff'), 'qaTet');
  assert.equal(types.departmentForStage({}, 'unknown'), null);
  assert.equal(types.typeOf({ id: 'PCN-2026-0001' }), null);
  assert.equal(types.normalizeType('TA'), 'ta');
  assert.equal(types.normalizeType('other'), null);
  assert.equal(types.peLabel({ documentType: 'sc' }), 'Prod.Eng/SC');
});

test('browser and Node use the same code and team rules', () => {
  const root = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../pcn-types'), 'utf8'), root);
  assert.equal(root.PCN_TYPES.formatCode('ta', '2026-11-19', 1), 'T-19112601');
  assert.equal(root.PCN_TYPES.departmentForStage({ documentType: 'sc' }, 'signoff.prodEngTet'), 'prodEngSc');
});
