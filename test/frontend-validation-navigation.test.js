const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const focusFunction = source.match(/  function focusDocumentField\(path\) \{[\s\S]+?\n  \}/)[0];

for (const field of ['sampleSubmitted', 'selectedChange']) {
  test(`missing ${field} navigation focuses a visible choice`, () => {
    let focused = false;
    const choice = { scrollIntoView() {}, focus() { focused = true; } };
    const hidden = { type: 'hidden', scrollIntoView() {}, focus() {} };
    const document = {
      getElementById: () => field === 'sampleSubmitted' ? hidden : null,
      querySelector: selector => selector.includes(':checked') ? null : choice,
      querySelectorAll: () => []
    };
    vm.runInNewContext(`${focusFunction}; focusDocumentField(field);`, { document, field, switchView() {} });
    assert.equal(focused, true);
  });
}
