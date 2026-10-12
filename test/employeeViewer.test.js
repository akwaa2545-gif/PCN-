const test = require('node:test');
const assert = require('node:assert/strict');
const { PcnService } = require('../src/pcnService');
const { SqlDocuments } = require('../src/sqlDocuments');
const { startApi, fakeAuthService, memoryRepository, unsignedPayload } = require('./helpers/apiHarness');

const viewer = { id: 'viewer-id', username: 'viewer', roles: [], isActive: true,
  identityProvider: 'employee-code', employeeCode: '0012345' };
const fileId = '11111111-1111-4111-8111-111111111111';

async function viewerApi(t) {
  const calls = [];
  const file = { id: fileId, FileName: 'report.txt', ContentType: 'text/plain', Bytes: Buffer.from('Approved report') };
  const api = await startApi(t, {
    authService: fakeAuthService({ additionalUsers: [viewer,
      { ...viewer, id: 'disabled-id', username: 'disabled', isActive: false }] }),
    documents: {
      async list(code) { calls.push(['list', code]); return [{ id: fileId, fileName: file.FileName, scanStatus: 'clean' }]; },
      async get(code, id) { calls.push(['get', code, id]); return file; },
      async save() { calls.push(['save']); throw new Error('Viewer must never upload'); },
      async delete() { calls.push(['delete']); throw new Error('Viewer must never delete'); }
    }
  });
  const supplier = await api.login('supplier');
  const other = await api.login('other');
  const own = await api.request('/api/pcns', { method: 'POST', session: supplier, body: { ...unsignedPayload, status: 'draft' } });
  const foreign = await api.request('/api/pcns', { method: 'POST', session: other, body: unsignedPayload });
  assert.equal(own.status, 201);
  assert.equal(foreign.status, 201);
  return { ...api, calls, supplier, own: own.body.data, foreign: foreign.body.data, session: await api.login('viewer') };
}

test('active roleless employee reads all records, progress, workflow, revisions and documents', async t => {
  const api = await viewerApi(t);
  const list = await api.request('/api/pcns', { session: api.session });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map(record => record.id).sort(), [api.own.id, api.foreign.id].sort());
  const filtered = await api.request('/api/pcns?status=draft', { session: api.session });
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.data.map(record => record.id), [api.own.id]);
  assert.equal((await api.request('/api/master-data', { session: api.session })).status, 200);
  for (const record of [api.own, api.foreign]) {
    for (const suffix of ['', '/progress', '/workflow', '/checks', '/action', '/revisions', '/revisions/1', '/documents']) {
      const result = await api.request(`/api/pcns/${record.id}${suffix}`, { session: api.session });
      assert.equal(result.status, 200, suffix || 'details');
      if (!suffix) assert.equal(result.body.data.id, record.id);
      if (suffix === '/action') assert.equal(result.body.data.canAct, false);
      if (suffix === '/revisions') assert.equal(result.body.data.capabilities.canStartRevision, false);
    }
    for (const suffix of [`/documents/${fileId}`, `/documents/${fileId}/preview`]) {
      const result = await api.request(`/api/pcns/${record.id}${suffix}`, { session: api.session });
      assert.equal(result.status, 200, suffix);
      assert.equal(result.text, 'Approved report');
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal((await api.request('/api/pcns/PCN-2026-9999', { session: api.session })).status, 404);
  assert.equal((await api.request(`/api/pcns/${api.foreign.id}`, { session: api.supplier })).status, 404);
  assert.equal((await api.request(`/api/pcns/${api.foreign.id}/documents/${fileId}`, { session: api.supplier })).status, 404);
});

test('roleless Records viewer cannot mutate PCNs, documents, workflow mail or administration', async t => {
  const api = await viewerApi(t);
  const root = `/api/pcns/${api.own.id}`;
  const before = await api.repository.findById(api.own.id);
  const mutations = [
    ['POST', '/api/pcns'], ['PATCH', root], ['PUT', root], ['DELETE', root],
    ['POST', `${root}/comments`], ['POST', `${root}/approvals`], ['POST', `${root}/revisions`],
    ['POST', `${root}/notifications/workflow`], ['POST', `${root}/documents`],
    ['DELETE', `${root}/documents/${fileId}`], ['PUT', '/api/notification-settings'],
    ['PATCH', '/api/notification-settings'], ['POST', '/api/admin/users'],
    ['POST', '/api/admin/notifications/test']
  ];
  for (const [method, route] of mutations) {
    assert.equal((await api.request(route, { method, session: api.session,
      body: { ...unsignedPayload, version: api.own.version, comment: 'Forbidden change' } })).status, 403, `${method} ${route}`);
  }
  for (const route of ['/api/notification-settings', '/api/admin/users',
    '/api/admin/employees?query=001', '/api/admin/directory-users?query=name', '/api/admin/notifications/health', `${root}/audit`]) {
    assert.equal((await api.request(route, { session: api.session })).status, 403, route);
  }
  assert.deepEqual(await api.repository.findById(api.own.id), before);
  assert.deepEqual(api.messages, []);
  assert.equal(api.calls.some(([action]) => ['save', 'delete'].includes(action)), false);
});

test('roleless former supplier receives no actionable control even for their own draft', async t => {
  const api = await viewerApi(t);
  const record = await api.repository.create({ ...api.own, ownerUserId: viewer.id }, 'historical');
  const action = await api.request(`/api/pcns/${record.id}/action`, { session: api.session });
  assert.equal(action.status, 200);
  assert.equal(action.body.data.canAct, false);
  assert.equal((await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: api.session,
    body: { version: record.version, reason: 'Forbidden own-record edit' } })).status, 403);
});

test('unauthenticated and disabled employees cannot read Records or attached documents', async t => {
  const api = await viewerApi(t);
  const disabled = await api.login('disabled');
  for (const route of ['/api/pcns', `/api/pcns/${api.own.id}`, `/api/pcns/${api.own.id}/revisions`,
    `/api/pcns/${api.own.id}/documents/${fileId}`]) {
    assert.equal((await api.request(route)).status, 401, route);
    assert.equal((await api.request(route, { session: disabled })).status, 403, route);
  }
  assert.deepEqual(api.calls, []);
});

test('service grants active employee viewer reads but rejects every mutation before persistence', async () => {
  const repository = memoryRepository();
  const service = new PcnService(repository);
  const supplier = { id: 'supplier-id', roles: ['supplier'], isActive: true };
  const record = await service.create({ ...unsignedPayload, status: 'draft' }, 'supplier', supplier);
  const savedSettings = await repository.getNotificationSettings();
  assert.deepEqual((await service.list({}, viewer)).map(item => item.id), [record.id]);
  assert.equal((await service.getById(record.id, viewer)).id, record.id);
  assert.equal((await service.getRevisions(record.id, viewer)).length, 1);
  assert.equal((await service.getRevision(record.id, 1, viewer)).revision, 1);
  const mutations = [
    () => service.create(unsignedPayload, 'viewer', viewer),
    () => service.update(record.id, { version: record.version, reason: 'Forbidden' }, 'viewer', viewer),
    () => service.remove(record.id, 'viewer', record.version, viewer),
    () => service.addComment(record.id, { version: record.version, comment: 'Forbidden' }, 'viewer', viewer),
    () => service.addApproval(record.id, { version: record.version, decision: 'hold' }, 'viewer', viewer),
    () => service.startRevision(record.id, { version: record.version, reason: 'Forbidden' }, 'viewer', viewer),
    () => service.updateNotificationSettings({ groups: [] }, 'viewer', viewer)
  ];
  for (const mutate of mutations) await assert.rejects(mutate(), { statusCode: 403 });
  assert.deepEqual(await repository.findById(record.id), record);
  assert.deepEqual(await repository.getNotificationSettings(), savedSettings);
});

test('document storage rejects roleless viewer upload and delete before scanning or SQL access', async () => {
  const calls = [];
  const documents = new SqlDocuments({
    transaction() { calls.push('transaction'); throw new Error('Viewer must never reach SQL writes'); }
  }, { scanner: { async scan() { calls.push('scan'); return 'clean'; } } });
  const context = { user: viewer, actor: 'viewer', version: '0000000000000001' };
  const file = { fileName: 'report.txt', contentType: 'text/plain', base64: Buffer.from('Report').toString('base64') };
  await assert.rejects(documents.save('PCN-2026-0001', file, context), { statusCode: 403 });
  await assert.rejects(documents.delete('PCN-2026-0001', fileId, context), { statusCode: 403 });
  assert.deepEqual(calls, []);
});
