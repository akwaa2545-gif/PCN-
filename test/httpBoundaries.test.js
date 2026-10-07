const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, validPayload, memoryRepository, TEST_PASSWORD } = require('./helpers/apiHarness');

test('health and readiness reflect database availability without exposing driver errors', async t => {
  const api = await startApi(t);
  assert.equal((await api.request('/api/health')).body.data.status, 'ok');
  assert.equal((await api.request('/api/ready')).body.data.status, 'ready');
  const broken = await startApi(t, { repository: { ...memoryRepository(), async readiness() { throw new Error('SQL password or hostname must stay private'); } } });
  const result = await broken.request('/api/ready');
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'Database is unavailable');
  assert.doesNotMatch(result.text, /password|hostname/);
});

test('malformed and oversized bodies fail before persistence', async t => {
  const api = await startApi(t);
  const admin = await api.login('admin');
  for (const raw of ['{', 'true', 'null', '[{}]']) {
    assert.equal((await api.request('/api/pcns', { method: 'POST', session: admin, raw })).status, 400);
  }
  assert.equal((await api.request('/api/pcns', { method: 'POST', session: admin, raw: 'x'.repeat(1000001) })).status, 413);
  assert.equal((await api.repository.list()).length, 0);
});

test('notification settings save recipients while endpoint URLs remain server managed', async t => {
  const api = await startApi(t);
  const admin = await api.login('admin');
  const input = { groups: [{ key: 'signoff.gscTet', emails: 'gsc.one@example.com; gsc.two@example.com',
    recipients: [{ email: 'gsc.one@example.com', displayName: 'Planner', jobTitle: 'GSC', department: 'GSC', photo: '' }] }] };
  const save = await api.request('/api/notification-settings', { method: 'PUT', session: admin, body: input });
  assert.equal(save.status, 200);
  const load = await api.request('/api/notification-settings', { session: admin });
  const group = load.body.data.legacyGroups.find(item => item.key === 'signoff.gscTet');
  assert.equal(group.emails, 'gsc.one@example.com; gsc.two@example.com');
  assert.equal(group.recipients[0].displayName, 'Planner');
  for (const body of [{ flowUrl: 'https://evil.example/send' }, { directoryLookupUrl: 'https://evil.example/query' },
    { groups: [{ key: 'signoff.gscTet', emails: 'invalid' }] }]) {
    assert.equal((await api.request('/api/notification-settings', { method: 'PUT', session: admin, body })).status, 400);
  }
  assert.equal((await api.request('/api/notification-settings', { session: admin })).body.data.legacyGroups.find(item => item.key === 'signoff.gscTet').emails, group.emails);
});

test('workflow, progress, status filtering, audit and unsupported methods are scoped', async t => {
  const api = await startApi(t);
  const admin = await api.login('admin');
  const master = await api.request('/api/master-data', { session: admin });
  assert.equal(master.status, 200);
  assert.equal(master.body.data.versionId, 1);
  const record = (await api.request('/api/pcns', { method: 'POST', session: admin, body: validPayload })).body.data;
  const workflow = await api.request(`/api/pcns/${record.id}/workflow`, { session: admin });
  assert.equal(workflow.status, 200);
  assert.ok(workflow.body.data.length >= 4);
  const progress = await api.request(`/api/pcns/${record.id}/progress`, { session: admin });
  assert.equal(progress.body.data.currentOwner, 'GSC/TET');
  assert.equal(progress.body.data.steps[0].state, 'completed');
  assert.equal((await api.request('/api/pcns?status=draft', { session: admin })).body.data.length, 0);
  assert.equal((await api.request('/api/pcns?status=submitted', { session: admin })).body.data.length, 1);
  assert.equal((await api.request(`/api/pcns/${record.id}/audit`, { session: admin })).status, 200);
  assert.equal((await api.request(`/api/pcns/${record.id}/unknown`, { session: admin })).status, 405);
  assert.equal((await api.request('/api/not-a-route', { session: admin })).status, 404);
  assert.equal((await api.request(`/api/pcns/${record.id}`, { method: 'POST', session: admin, body: {} })).status, 405);
});

test('administrator user endpoints require role and do not return stored passwords', async t => {
  const api = await startApi(t);
  const admin = await api.login('admin');
  const list = await api.request('/api/admin/users', { session: admin });
  assert.equal(list.status, 200);
  assert.ok(list.body.data.every(item => item.password === undefined));
  const created = await api.request('/api/admin/users', { method: 'POST', session: admin,
    body: { username: 'new-user', password: TEST_PASSWORD, roles: ['supplier'] } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.username, 'new-user');
  assert.equal(created.body.data.mustChangePassword, true);
  assert.equal(created.body.data.password, undefined);
  const supplier = await api.login('supplier');
  assert.equal((await api.request('/api/admin/users', { session: supplier })).status, 403);
  assert.equal((await api.request('/api/admin/users', { method: 'POST', session: supplier, body: {} })).status, 403);
  assert.equal((await api.request('/api/admin/directory-users?query=aa', { session: admin })).status, 503);
  assert.equal((await api.request('/api/admin/notifications/test', { method: 'POST', session: admin, body: {} })).status, 503);
});

test('document upload, attachment download and delete retain record permissions', async t => {
  const documentId = 'bce2c03d-0582-4a48-9c85-1b7b746b4458';
  let files = {};
  const documents = {
    async save(code, input, context) {
      assert.equal(context.version, input.version);
      assert.equal(context.actor, `user:${context.user.id}`);
      const file = { Id: documentId, FileName: input.fileName, ContentType: 'text/plain', Bytes: Buffer.from('saved attachment') };
      files = { ...files, [code]: file }; return { id: file.Id, version: '0000000000000012' };
    },
    async get(code) { return files[code]; }, async delete(code, id, context) {
      assert.equal(context.version, '0000000000000012');
      const { [code]: removed, ...remaining } = files; files = remaining; return { id, version: '0000000000000013' };
    }
  };
  const api = await startApi(t, { documents });
  const admin = await api.login('admin');
  const record = (await api.request('/api/pcns', { method: 'POST', session: admin, body: validPayload })).body.data;
  assert.equal((await api.request(`/api/pcns/${record.id}/documents`, { method: 'POST', session: admin, body: {} })).status, 400);
  const upload = await api.request(`/api/pcns/${record.id}/documents`, { method: 'POST', session: admin, body: { version: record.version, fileName: 'pilot report.txt', contentType: 'text/plain', base64: Buffer.from('saved attachment').toString('base64') } });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.data.version, '0000000000000012');
  const download = await api.request(`/api/pcns/${record.id}/documents/${documentId}`, { session: admin });
  assert.equal(download.status, 200);
  assert.equal(download.text, 'saved attachment');
  assert.match(download.headers.get('content-disposition'), /attachment; filename="pilot_report.txt"/);
  assert.equal((await api.request(`/api/pcns/${record.id}/documents/${documentId}`, { session: await api.login('other') })).status, 404);
  assert.equal((await api.request(`/api/pcns/${record.id}/documents/${documentId}`, { method: 'DELETE', session: admin, body: {} })).status, 400);
  const deleted = await api.request(`/api/pcns/${record.id}/documents/${documentId}`, { method: 'DELETE', session: admin, body: { version: upload.body.data.version } });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.data.version, '0000000000000013');
  assert.equal(files[record.id], undefined);
});

test('static HEAD and security headers work while malformed paths and write methods fail', async t => {
  const api = await startApi(t);
  const head = await api.request('/styles.css', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(head.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(head.headers.get('x-frame-options'), 'DENY');
  assert.match(head.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal((await api.request('/%ZZ')).status, 400);
  assert.equal((await api.request('/create', { method: 'POST', body: {} })).status, 405);
});

test('administrator login rejects supplier accounts and missing sessions remain anonymous', async t => {
  const api = await startApi(t);
  const login = await api.request('/api/admin/login', { method: 'POST', body: { username: 'supplier', password: TEST_PASSWORD } });
  assert.equal(login.status, 403);
  assert.equal(login.headers.get('set-cookie'), null);
  assert.equal((await api.request('/api/session')).body.data.authenticated, false);
  assert.equal((await api.request('/api/auth/logout', { method: 'POST' })).status, 200);
  assert.equal((await api.request('/api/auth/login', { method: 'POST' })).status, 401);
});

test('HTTP server validates dependencies, applies defaults and hides unexpected failures', async t => {
  const { createApp, writeJson } = require('../src/httpServer');
  assert.throws(() => createApp({ repository: memoryRepository() }), /authentication/i);
  const defaults = await startApi(t, { rootDir: undefined, publicOrigin: undefined, secureCookies: undefined });
  assert.equal((await defaults.request('/api/health')).status, 200);
  assert.equal((await defaults.request('/create')).status, 200);
  const missing = await startApi(t, { rootDir: 'C:/__pcn_test_missing_directory__' });
  assert.equal((await missing.request('/create')).status, 404);
  const failing = await startApi(t, { service: { async list() { throw new Error('private SQL connection string'); } } });
  const failure = await failing.request('/api/pcns', { session: await failing.login('admin') });
  assert.equal(failure.status, 500);
  assert.equal(failure.body.error, 'Internal server error');
  assert.doesNotMatch(failure.text, /private SQL/);
  assert.equal(typeof failure.body.requestId, 'string');
  const alreadySent = { headersSent: true, writeHead() { throw new Error('duplicate response'); } };
  writeJson(alreadySent, 500, {});
});
