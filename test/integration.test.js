const test = require('node:test');
const assert = require('node:assert/strict');
const { IntegrationService } = require('../src/integrationService');

test('mail configuration health validates locally and discloses only an allowlisted status', () => {
  let requests = 0;
  const cases = [
    [undefined, 'not_configured'], [null, 'not_configured'], ['', 'not_configured'],
    ['https://mail.example/send?sig=private-health-test', 'configured'],
    ['http://mail.example/send?sig=private-health-test', 'invalid'],
    ['https://evil.example/send?sig=private-health-test', 'invalid'],
    ['https://name:private-health-test@mail.example/send', 'invalid'],
    ['https://mail.example:444/send', 'invalid'], ['not a url', 'invalid'], [123, 'invalid']
  ];
  for (const [mailUrl, expected] of cases) {
    const service = new IntegrationService({ mailUrl, allowedHosts: ['mail.example'], fetchImpl: () => { requests++; throw new Error('private-health-test'); } });
    assert.equal(service.mailConfigurationStatus(), expected);
  }
  assert.equal(requests, 0);
});

test('empty mappings never invoke mail or fallback to a recipient', async () => {
  let calls = 0;
  const service = new IntegrationService({ mailUrl: 'https://mail.example/send', allowedHosts: ['mail.example'], fetchImpl: async () => { calls++; } });
  await assert.rejects(service.testMail({ groupId: 'qa' }, { groups: [{ key: 'qa', emails: '' }] }), { statusCode: 400 });
  assert.equal(calls, 0);
});

test('integration endpoints must use approved HTTPS host without credentials or redirects', async () => {
  for (const mailUrl of ['http://mail.example/send', 'https://evil.example/send', 'https://name:pass@mail.example/send', 'https://mail.example:444/send']) {
    const service = new IntegrationService({ mailUrl, allowedHosts: ['mail.example'] });
    await assert.rejects(service.sendMail({ to: 'qa@example.com', subject: 'Test', message: 'Test' }), { statusCode: 503 });
  }
  let request;
  const service = new IntegrationService({ mailUrl: 'https://mail.example/send', allowedHosts: ['mail.example'], fetchImpl: async (url, options) => { request = options; return { ok: true }; } });
  assert.equal((await service.sendMail({ to: 'qa@example.com', subject: 'Test', message: 'Test' })).sent, true);
  assert.equal(request.redirect, 'error');
  assert.ok(request.signal);
});

test('directory results are bounded and normalized without disclosing secrets', async () => {
  const service = new IntegrationService({ directoryUrl: 'https://directory.example/find?secret=hidden', allowedHosts: ['directory.example'], fetchImpl: async () => new Response(JSON.stringify({ users: [{ displayName: 'QA', mail: 'qa@example.com', id: 'one', photo: 'https://bad.example/pixel' }] })) });
  const result = await service.directory('QA');
  assert.equal(result.users[0].email, 'qa@example.com');
  assert.equal(result.users[0].photo, '');
  await assert.rejects(service.directory('a'), { statusCode: 400 });
});

test('directory rejects excessive upstream body and malformed response', async () => {
  for (const body of ['x'.repeat(256 * 1024 + 1), '{}', 'not json']) {
    const service = new IntegrationService({ directoryUrl: 'https://directory.example/find', allowedHosts: ['directory.example'], fetchImpl: async () => new Response(body) });
    await assert.rejects(service.directory('QA'), { statusCode: 502 });
  }
});

test('mail rejects malformed recipients and maps upstream errors without exposing secret URL', async () => {
  const service = new IntegrationService({ mailUrl: 'https://mail.example/send?secret=hidden', allowedHosts: ['mail.example'], fetchImpl: async () => { throw new Error('secret=hidden'); } });
  await assert.rejects(service.sendMail({ to: 'qa@example.com\r\nbcc:x@example.com', subject: 'Test', message: 'Test' }), { statusCode: 400 });
  await assert.rejects(service.sendMail({ to: 'qa@example.com', subject: 'Test', message: 'Test' }), (error) => error.statusCode === 502 && !error.message.includes('hidden'));
});

test('mail transports the restored HTML with the original four JSON fields unchanged', async () => {
  const { buildWorkflowNotificationMessage } = require('../src/notificationTemplate');
  const message = buildWorkflowNotificationMessage({ id: 'PCN-2026-0001', supplierName: 'Supplier ไทย', materialName: 'Copper', riskLevel: 'RL2' },
    { completedGroup: 'GSC/TET', nextGroup: 'Prod.Eng/TET', pcnUrl: 'https://pcn.example/form.html?id=PCN-2026-0001' }).trim();
  let payload;
  const service = new IntegrationService({ mailUrl: 'https://mail.example/send', allowedHosts: ['mail.example'], fetchImpl: async (url, options) => { payload = JSON.parse(options.body); return { ok: true }; } });
  await service.sendMail({ to: 'qa@example.com', subject: '[PCN] PCN-2026-0001 - GSC/TET completed', message, senderName: 'QA' });
  assert.deepEqual(payload, { to: 'qa@example.com', subject: '[PCN] PCN-2026-0001 - GSC/TET completed', message, senderName: 'QA' });
});
