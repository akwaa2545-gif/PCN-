const test = require('node:test');
const assert = require('node:assert/strict');
const { readAuthConfiguration } = require('../src/authConfiguration');
const crypto = require('node:crypto');

test('SQL employee code mode is default and does not expose directory or proxy keys', () => {
  assert.deepEqual(readAuthConfiguration({}), { mode: 'employee-code' });
  assert.deepEqual(readAuthConfiguration({ AUTH_MODE: 'employee-code', AD_DOMAIN: 'ignored', WINDOWS_AUTH_PROXY_KEY: 'ignored' }), { mode: 'employee-code' });
});

test('password maintenance remains explicit while Windows SSO and unknown modes are rejected', () => {
  assert.deepEqual(readAuthConfiguration({ AUTH_MODE: 'password' }), { mode: 'password' });
  for (const AUTH_MODE of ['windows', 'empcode', 'unknown', '']) assert.throws(() => readAuthConfiguration({ AUTH_MODE }), /Invalid AUTH_MODE/);
});

test('Developer configuration accepts only a bounded Argon2id hash and never plaintext',()=>{
  const salt=crypto.randomBytes(16).toString('base64').replace(/=+$/,'');
  const digest=crypto.randomBytes(32).toString('base64').replace(/=+$/,'');
  const hash=`$argon2id$v=19$m=65536,t=3,p=1$${salt}$${digest}`;
  assert.equal(readAuthConfiguration({PCN_DEVELOPER_PASSWORD_HASH:hash}).developerPasswordHash,hash);
  for(const invalid of [crypto.randomBytes(8).toString('hex'),'$argon2i$v=19$m=65536,t=3,p=1$x$x',`${hash}trailing`,'x'.repeat(513)]) {
    assert.equal(readAuthConfiguration({PCN_DEVELOPER_PASSWORD_HASH:invalid}).developerPasswordHash,null);
  }
});
