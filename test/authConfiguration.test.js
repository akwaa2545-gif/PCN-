const test = require('node:test');
const assert = require('node:assert/strict');
const { readAuthConfiguration } = require('../src/authConfiguration');

test('SQL employee code mode is default and does not expose directory or proxy keys', () => {
  assert.deepEqual(readAuthConfiguration({}), { mode: 'employee-code' });
  assert.deepEqual(readAuthConfiguration({ AUTH_MODE: 'employee-code', AD_DOMAIN: 'ignored', WINDOWS_AUTH_PROXY_KEY: 'ignored' }), { mode: 'employee-code' });
});

test('password maintenance remains explicit while Windows SSO and unknown modes are rejected', () => {
  assert.deepEqual(readAuthConfiguration({ AUTH_MODE: 'password' }), { mode: 'password' });
  for (const AUTH_MODE of ['windows', 'empcode', 'unknown', '']) assert.throws(() => readAuthConfiguration({ AUTH_MODE }), /Invalid AUTH_MODE/);
});
