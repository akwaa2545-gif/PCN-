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

test('directory sends both original search fields with the same trimmed query', async () => {
  const requests = [];
  const service = new IntegrationService({ directoryUrl: 'https://directory.example/find', allowedHosts: ['directory.example'], fetchImpl: async (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify([]));
  } });
  await Promise.all([service.directory('  alex.reviewer  '), service.directory("  QA ไทย '😀  ")]);
  assert.deepEqual(requests, [
    { query: 'alex.reviewer', searchTerm: 'alex.reviewer' },
    { query: "QA ไทย '😀", searchTerm: "QA ไทย '😀" }
  ]);
});

test('directory accepts original results envelope and all existing envelopes safely', async () => {
  const entries = [
    { id: 'one', displayName: 'Alex Reviewer', mail: 'alex.reviewer@example.com', photo: 'https://bad.example/pixel' },
    { userPrincipalName: 'qa@example.com' },
    null, 'invalid', { email: 'bad address' }, { email: 'one@example.com; two@example.com' }
  ];
  for (const body of [entries, { users: entries }, { value: entries }, { results: entries }]) {
    const service = new IntegrationService({ directoryUrl: 'https://directory.example/find', allowedHosts: ['directory.example'], fetchImpl: async () => new Response(JSON.stringify(body)) });
    assert.deepEqual(await service.directory('alex'), { users: [
      { id: 'one', displayName: 'Alex Reviewer', email: 'alex.reviewer@example.com', jobTitle: '', department: '', photo: '' },
      { id: '', displayName: 'qa@example.com', email: 'qa@example.com', jobTitle: '', department: '', photo: '' }
    ] });
  }
});

test('directory retains query boundaries and rejects invalid input before fetching', async () => {
  let requests = 0;
  const service = new IntegrationService({ directoryUrl: 'https://directory.example/find', allowedHosts: ['directory.example'], fetchImpl: async () => {
    requests++;
    return new Response(JSON.stringify({ results: [] }));
  } });
  for (const query of [undefined, null, '', '  ', 'a', 'a'.repeat(101), 42, {}, []]) {
    await assert.rejects(service.directory(query), { statusCode: 400 });
  }
  assert.equal(requests, 0);
  assert.deepEqual(await service.directory('ab'), { users: [] });
  assert.deepEqual(await service.directory('a'.repeat(100)), { users: [] });
  assert.equal(requests, 2);
});

test('directory bounds original results envelope to fifty normalized users', async () => {
  const entries = Array.from({ length: 60 }, (_, index) => ({ email: `user${index}@example.com` }));
  const service = new IntegrationService({ directoryUrl: 'https://directory.example/find', allowedHosts: ['directory.example'], fetchImpl: async () => new Response(JSON.stringify({ results: entries })) });
  const { users } = await service.directory('user');
  assert.equal(users.length, 50);
  assert.equal(users[49].email, 'user49@example.com');
});

test('directory preserves bounded profile metadata and normalized inline raster photos', async () => {
  for (const type of ['png', 'jpeg', 'gif', 'webp']) {
    const service = new IntegrationService({ directoryUrl: 'https://directory.example/find', allowedHosts: ['directory.example'], fetchImpl: async () => new Response(JSON.stringify({ users: [{
      displayName: 'Alex Reviewer', email: 'alex.reviewer@example.com', jobTitle: '  Quality Reviewer  ', department: '  QA ไทย  ',
      photo: `  data:image/${type};base64, aG Vs\t\r\nbG8=  `
    }] })) });
    assert.deepEqual(await service.directory('alex.reviewer'), { users: [{
      id: '', displayName: 'Alex Reviewer', email: 'alex.reviewer@example.com', jobTitle: 'Quality Reviewer', department: 'QA ไทย',
      photo: `data:image/${type};base64,aGVsbG8=`
    }] });
  }
});

test('directory drops unsafe photos and invalid metadata without losing a valid email', async () => {
  const invalidPhotos = [undefined, null, '', 42, {}, [], 'https://bad.example/pixel', '//bad.example/pixel', 'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PHN2Zz4=', 'data:image/png;base64,',
    'data:image/png;base64,aGVsbG8', 'data:image/png;base64,=aGVsbG8', 'data:image/png;base64,aGVsbG8===',
    'data:image/png;base64,aGVs\u200bbG8=', `data:image/png;base64,${'A'.repeat(100 * 1024)}`];
  for (const photo of invalidPhotos) {
    const service = new IntegrationService({ directoryUrl: 'https://directory.example/find', allowedHosts: ['directory.example'], fetchImpl: async () => new Response(JSON.stringify({ users: [{
      email: 'alex.reviewer@example.com', jobTitle: { toString: 'malicious' }, department: 42, photo
    }] })) });
    const { users } = await service.directory('alex.reviewer');
    assert.equal(users.length, 1);
    assert.equal(users[0].email, 'alex.reviewer@example.com');
    assert.equal(users[0].jobTitle, '');
    assert.equal(users[0].department, '');
    assert.equal(users[0].photo, '');
  }
});

test('directory limits metadata to 120 characters and encoded photo to 100 KiB', async () => {
  const prefix = 'data:image/png;base64,';
  const withinLimit = prefix + 'A'.repeat(Math.floor((100 * 1024 - prefix.length) / 4) * 4);
  for (const [photo, expected] of [[withinLimit, withinLimit], [withinLimit + 'AAAA', '']]) {
    const service = new IntegrationService({ directoryUrl: 'https://directory.example/find', allowedHosts: ['directory.example'], fetchImpl: async () => new Response(JSON.stringify({ users: [{
      email: 'alex.reviewer@example.com', jobTitle: ` ${'J'.repeat(121)} `, department: ` ${'D'.repeat(121)} `, photo
    }] })) });
    const { users } = await service.directory('alex.reviewer');
    assert.equal(users[0].jobTitle, 'J'.repeat(120));
    assert.equal(users[0].department, 'D'.repeat(120));
    assert.equal(users[0].photo, expected);
  }
});

test('directory rejects excessive upstream body and malformed response', async () => {
  for (const body of ['x'.repeat(256 * 1024 + 1), '{}', 'not json', 'null', '42', '"text"', '{"results":{}}']) {
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
