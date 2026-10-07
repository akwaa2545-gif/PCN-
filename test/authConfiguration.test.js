const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readAuthConfiguration } = require('../src/authConfiguration');

const network = { host: '127.0.0.1', trustProxy: 'loopback' };
const windows = () => ({ AUTH_MODE: 'windows', AD_DOMAIN: 'KEMET.COM', WINDOWS_AUTH_DOMAIN: 'KEMET', WINDOWS_AUTH_PROXY_KEY: crypto.randomBytes(32).toString('hex') });

test('password mode remains default; AD provisioning is separately configured', () => {
  assert.deepEqual(readAuthConfiguration({}, network), { mode: 'password', directoryDomain: null, windowsAuth: null });
  assert.equal(readAuthConfiguration({ AD_DOMAIN: 'KEMET.COM' }, network).directoryDomain, 'KEMET.COM');
});
test('Windows configuration requires explicit DNS and NetBIOS domains plus private proxy key', () => {
  const env = windows();
  const config = readAuthConfiguration(env, network);
  assert.equal(config.mode, 'windows');
  assert.equal(config.windowsAuth.domain, 'KEMET');
  assert.equal(config.windowsAuth.proxyKey, env.WINDOWS_AUTH_PROXY_KEY);
  for (const name of ['AD_DOMAIN', 'WINDOWS_AUTH_DOMAIN', 'WINDOWS_AUTH_PROXY_KEY']) assert.throws(() => readAuthConfiguration({ ...env, [name]: '' }, network));
});
test('Windows mode fails closed on exposed bind, proxy trust, unknown modes and malformed settings', () => {
  const env = windows();
  for (const host of ['0.0.0.0', '172.30.77.137', '::']) assert.throws(() => readAuthConfiguration(env, { ...network, host }));
  assert.throws(() => readAuthConfiguration(env, { ...network, trustProxy: 'off' }));
  for (const [name, value] of [['AUTH_MODE', 'empcode'], ['AD_DOMAIN', 'ldap://example'], ['WINDOWS_AUTH_DOMAIN', 'DOMAIN\\user'], ['WINDOWS_AUTH_PROXY_KEY', 'short'], ['WINDOWS_AUTH_PROXY_KEY', 'x'.repeat(257)], ['WINDOWS_AUTH_PROXY_KEY', 'x'.repeat(32) + '\n']]) assert.throws(() => readAuthConfiguration({ ...env, [name]: value }, network));
});
