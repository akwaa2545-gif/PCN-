const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi } = require('./helpers/apiHarness');
const { IntegrationService } = require('../src/integrationService');
const { NotificationWorker } = require('../src/notificationWorker');

const route = '/api/admin/notifications/health';
function dependencies(mailUrl = 'https://mail.example/send?sig=private-health-test') {
  const calls = [];
  const integrationService = new IntegrationService({ mailUrl, allowedHosts: ['mail.example'], fetchImpl: async () => { calls.push('mail'); throw new Error('sig=private-health-test'); } });
  const notificationWorker = new NotificationWorker({ request() { return { async query(query) {
    calls.push(query);
    return { recordset: [{ pending: 2, sending: 1, accepted: 8, uncertain: 3, latestAcceptedAt: new Date('2026-10-06T01:02:03Z') }] };
  } }; } }, { integrationService });
  return { integrationService, notificationWorker, calls };
}

test('administrator health returns redacted configuration, worker and queue without contacting the flow', async t => {
  const deps = dependencies();
  const api = await startApi(t, deps);
  const result = await api.request(route, { session: await api.login('admin') });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { configuration: { status: 'configured' }, worker: { lastCheckedAt: null, lastOutcome: null },
    queue: { pending: 2, sending: 1, accepted: 8, uncertain: 3, latestAcceptedAt: '2026-10-06T01:02:03.000Z' }, deliveryVerified: false });
  assert.doesNotMatch(result.text, /private-health-test|mail\.example|PayloadJson|LastError|recipient/);
  assert.equal(deps.calls.length, 1);
  assert.notEqual(deps.calls[0], 'mail');
  assert.equal(api.messages.length, 0);
  assert.deepEqual(await api.repository.getNotificationSettings(), { groups: [] });
});

test('health requires a fully authenticated administrator before querying the queue', async t => {
  const deps = dependencies();
  const api = await startApi(t, deps);
  assert.equal((await api.request(route)).status, 401);
  assert.equal((await api.request(route, { session: await api.login('supplier') })).status, 403);
  assert.equal((await api.request(route, { session: await api.login('temporary') })).status, 403);
  assert.deepEqual(deps.calls, []);
});

test('health reports missing or invalid configuration safely without any flow request', async t => {
  for (const [mailUrl, expected] of [['', 'not_configured'], ['https://private-health-test.invalid/send?sig=private-health-test', 'invalid']]) {
    const deps = dependencies(mailUrl);
    const api = await startApi(t, deps);
    const result = await api.request(route, { session: await api.login('admin') });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.configuration.status, expected);
    assert.doesNotMatch(result.text, /private-health-test/);
    assert.equal(deps.calls.length, 1);
  }
});

test('health hides dependency and database error details behind a generic unavailable response', async t => {
  const cases = [{}, { integrationService: dependencies().integrationService }, { notificationWorker: dependencies().notificationWorker },
    { ...dependencies(), notificationWorker: { health: async () => { throw new Error('Database sig=private-health-test'); } } },
    { ...dependencies(), integrationService: { mailConfigurationStatus: () => { throw new Error('URL sig=private-health-test'); } } }];
  for (const overrides of cases) {
    const api = await startApi(t, overrides);
    const result = await api.request(route, { session: await api.login('admin') });
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'Notification health is unavailable');
    assert.doesNotMatch(result.text, /private-health-test|mail\.example|Database sig|URL sig/);
  }
});
