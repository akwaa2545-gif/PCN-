(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PCN_TYPES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const types = Object.freeze([
    Object.freeze({ key: 'ta', label: 'TA', prefix: 'T', department: 'prodEngTa' }),
    Object.freeze({ key: 'sc', label: 'SC', prefix: 'S', department: 'prodEngSc' })
  ]);
  const CODE_PATTERN = '(?:PCN-\\d{4}-\\d{4}|[TS]-\\d{8})';
  const labels = Object.freeze({ gscTet: 'GSC/TET', prodEngTet: 'Prod.Eng/TET', prodEngTa: 'Prod.Eng/TA',
    prodEngSc: 'Prod.Eng/SC', qaTet: 'QA/TET', gscTapbu: 'GSC/TaPBU', qaTapbu: 'QA/TaPBU' });
  const stages = Object.freeze({ 'signoff.gscTet': 'gscTet', 'signoff.prodEngTet': 'prodEngTet',
    'signoff.qaTet': 'qaTet', 'tapbu.gsc': 'gscTapbu', 'tapbu.qa': 'qaTapbu', 'qateFinal.signoff': 'qaTet' });
  function normalizeType(value) {
    const key = typeof value === 'string' ? value.toLowerCase() : '';
    return types.some(type => type.key === key) ? key : null;
  }
  function validDay(day) {
    if (typeof day !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(day)) return false;
    const date = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
  }
  function parseCode(code) {
    if (typeof code !== 'string') return null;
    const legacy = /^PCN-(\d{4})-(\d{4})$/.exec(code);
    if (legacy) return { kind: 'legacy', documentType: null, year: Number(legacy[1]), sequence: Number(legacy[2]) };
    const typed = /^([TS])-(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(code);
    if (!typed) return null;
    const day = `20${typed[4]}-${typed[3]}-${typed[2]}`;
    const sequence = Number(typed[5]);
    return validDay(day) && sequence > 0
      ? { kind: 'typed', documentType: typed[1] === 'T' ? 'ta' : 'sc', day, sequence } : null;
  }
  const isCode = code => parseCode(code) !== null;
  function formatCode(documentType, day, sequence) {
    const type = types.find(entry => entry.key === normalizeType(documentType));
    if (!type || !validDay(day) || !Number.isInteger(sequence) || sequence < 1 || sequence > 99) throw new RangeError('Invalid PCN type, date or daily sequence');
    return `${type.prefix}-${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}${String(sequence).padStart(2, '0')}`;
  }
  function bangkokDay(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid PCN creation date');
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const at = key => parts.find(part => part.type === key).value;
    return `${at('year')}-${at('month')}-${at('day')}`;
  }
  const typeOf = record => normalizeType(record?.documentType) || parseCode(record?.id)?.documentType || null;
  function departmentForStage(record, stage) {
    if (stage === 'signoff.prodEngTet') return types.find(type => type.key === typeOf(record))?.department || 'prodEngTet';
    return stages[stage] || null;
  }
  const departmentLabel = key => labels[key] || key;
  const peLabel = record => departmentLabel(departmentForStage(record, 'signoff.prodEngTet'));
  return Object.freeze({ types, CODE_PATTERN, normalizeType, typeOf, parseCode, isCode, formatCode, bangkokDay, departmentForStage, departmentLabel, peLabel });
});
