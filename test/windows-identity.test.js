const test = require('node:test');
const assert = require('node:assert/strict');
const { readWindowsIdentity } = require('../src/windowsIdentity');

const options = { mode: 'windows', domain: 'KEMET', proxyKey: 'x'.repeat(48) };
const request = (changes = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-pcn-windows-user': 'KEMET\\2172172512501', 'x-pcn-windows-auth-key': options.proxyKey }, rawHeaders: ['X-PCN-Windows-User', 'KEMET\\2172172512501', 'X-PCN-Windows-Auth-Key', options.proxyKey], ...changes });

test('Windows identity uses only authenticated loopback proxy headers and configured domain', () => {
  assert.deepEqual(readWindowsIdentity(request(), options), { domain: 'KEMET', samAccountName: '2172172512501' });
  assert.equal(readWindowsIdentity(request(), { ...options, mode: 'password' }), null);
  for (const address of ['192.168.1.4', '127.0.0.2', undefined]) {
    assert.throws(() => readWindowsIdentity(request({ socket: { remoteAddress: address } }), options), /Windows sign-in/i);
  }
  assert.deepEqual(readWindowsIdentity(request({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), options), { domain: 'KEMET', samAccountName: '2172172512501' });
});

test('Windows identity rejects forged, duplicated, ambiguous and unconfigured proxy headers', () => {
  for (const value of ['OTHER\\2172172512501', 'KEMET\\user, KEMET\\admin', 'KEMET\\user\\admin', '2172172512501', 'KEMET\\user\r\n', 'KEMET\\' + 'a'.repeat(21), 'KEMET\\machine$']) {
    const req = request();
    req.headers['x-pcn-windows-user'] = value;
    req.rawHeaders[1] = value;
    assert.throws(() => readWindowsIdentity(req, options), /Windows sign-in/i);
  }
  const wrongKey = request();
  wrongKey.headers['x-pcn-windows-auth-key'] = 'z'.repeat(48);
  wrongKey.rawHeaders[3] = 'z'.repeat(48);
  assert.throws(() => readWindowsIdentity(wrongKey, options), /Windows sign-in/i);
  assert.throws(() => readWindowsIdentity(request({ rawHeaders: [...request().rawHeaders, 'x-pcn-windows-user', 'KEMET\\admin'] }), options), /Windows sign-in/i);
  assert.throws(() => readWindowsIdentity(request(), { ...options, proxyKey: '' }), /Windows sign-in/i);
});
