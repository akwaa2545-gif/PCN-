const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp } = require('../src/httpServer');
const { memoryRepository } = require('./helpers/apiHarness');
const { selectRuntimeFiles } = require('../scripts/package-release');

test('notification settings controller is included in runtime archives', () => {
  assert.deepEqual(selectRuntimeFiles(['notification-settings.js']), ['notification-settings.js']);
});

test('notification settings controller is served as a same-origin JavaScript asset', async t => {
  const server = createApp({ repository:memoryRepository(), authService:{ session:async () => null }, rootDir:path.resolve(__dirname, '..') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/notification-settings.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /PCN_NOTIFICATION_SETTINGS/);
});
