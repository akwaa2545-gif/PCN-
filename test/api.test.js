const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, validPayload, TEST_PASSWORD, TEST_NEW_PASSWORD } = require('./helpers/apiHarness');

test('SQL and authentication dependencies are required; no JSON fallback', () => {
  const { createApp } = require('../src/httpServer');
  assert.throws(() => createApp({}), /repository|SQL|authentication|authService/i);
});

test('login creates HttpOnly session, DTO excludes secrets, logout revokes it', async t => {
  const api = await startApi(t);
  const login = await api.login('admin');
  assert.match(login.cookie, /^pcn_session=/);
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /SameSite=Strict/);
  const session = await api.request('/api/session', { session: login });
  assert.equal(session.status, 200);
  assert.equal(session.body.data.authenticated, true);
  assert.equal(session.body.data.user.username, 'admin');
  assert.equal(session.body.data.csrfToken, login.csrfToken);
  assert.equal(session.body.data.user.passwordHash, undefined);
  assert.equal(session.body.data.token, undefined);
  assert.equal((await api.request('/api/auth/logout', { method: 'POST', session: login })).status, 200);
  assert.equal((await api.request('/api/pcns', { session: login })).status, 401);
});

test('incorrect credentials never establish a session', async t => {
  const api = await startApi(t);
  const result = await api.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'incorrect' } });
  assert.equal(result.status, 401);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.body.success, false);
});

test('seven digit Employee ID creates a session without a password', async t => {
  const api = await startApi(t);
  const login = await api.request('/api/auth/login', { method: 'POST', body: { employeeId: '0000001' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.user.username, 'admin');
  assert.equal(login.body.data.user.employeeId, '0000001');
  assert.match(login.headers.get('set-cookie'), /^pcn_session=/);
  const invalid = await api.request('/api/auth/login', { method: 'POST', body: { employeeId: '123456' } });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get('set-cookie'), null);
});

test('temporary password restricts PCNs until change and fresh login', async t => {
  const api = await startApi(t);
  const login = await api.login('temporary');
  assert.equal((await api.request('/api/pcns', { session: login })).status, 403);
  const change = await api.request('/api/auth/change-password', { method: 'POST', session: login,
    body: { currentPassword: TEST_PASSWORD, newPassword: TEST_NEW_PASSWORD } });
  assert.equal(change.status, 200);
  assert.equal((await api.request('/api/pcns', { session: login })).status, 401);
  const fresh = await api.login('temporary', TEST_NEW_PASSWORD);
  assert.equal((await api.request('/api/pcns', { session: fresh })).status, 200);
});

test('every PCN read and write requires authentication', async t => {
  const api = await startApi(t);
  for (const [route, method] of [['/api/pcns', 'GET'], ['/api/pcns', 'POST'], ['/api/pcns/PCN-2026-0001', 'GET'],
    ['/api/pcns/PCN-2026-0001', 'PATCH'], ['/api/pcns/PCN-2026-0001', 'DELETE'],
    ['/api/pcns/PCN-2026-0001/progress', 'GET'], ['/api/pcns/PCN-2026-0001/comments', 'POST']]) {
    assert.equal((await api.request(route, { method, body: method === 'GET' ? undefined : validPayload })).status, 401, `${method} ${route}`);
  }
});

test('writes enforce same origin and CSRF, including login origin', async t => {
  const api = await startApi(t);
  assert.equal((await api.request('/api/auth/login', { method: 'POST', origin: 'https://evil.example', body: { username: 'admin', password: TEST_PASSWORD } })).status, 403);
  const login = await api.login('admin');
  for (const options of [{ origin: 'https://evil.example' }, { origin: null }, { csrf: 'wrong' }, { csrf: null }]) {
    assert.equal((await api.request('/api/pcns', { method: 'POST', session: login, body: validPayload, ...options })).status, 403);
  }
  assert.equal((await api.repository.list()).length, 0);
});

test('PCN CRUD persists workbook review, comments and approval metadata', async t => {
  const api = await startApi(t);
  const admin = await api.login('admin');
  const create = await api.request('/api/pcns', { method: 'POST', session: admin, body: validPayload });
  assert.equal(create.status, 201);
  const record = create.body.data;
  assert.match(record.id, /^PCN-\d{4}-\d{4}$/);
  assert.match(record.version, /^[a-f0-9]{16}$/i);
  assert.equal(record.ownerUserId, 'admin-id');
  const get = await api.request(`/api/pcns/${record.id}`, { session: admin });
  assert.equal(get.status, 200);
  assert.equal(get.body.data.supplierName, 'Supplier ไทย');
  assert.equal(get.body.data.internalReview.signoff.gscTet.approvedDate, '2026-10-05');
  assert.equal(get.body.data.internalReview.qateFinal.signoff.prepared, true);
  const comment = await api.request(`/api/pcns/${record.id}/comments`, { method: 'POST', session: admin,
    body: { version: record.version, role: 'QA', comment: 'Checked: lot A ✅' } });
  assert.equal(comment.status, 201);
  const approval = await api.request(`/api/pcns/${record.id}/approvals`, { method: 'POST', session: admin,
    body: { version: comment.body.data.version, role: 'QA', decision: 'hold', comment: 'Need pilot lot' } });
  assert.equal(approval.status, 201);
  const update = await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: admin,
    body: { version: approval.body.data.version, internalReview: { materialCodeDescription: 'Updated workbook description' } } });
  assert.equal(update.status, 200);
  assert.equal(update.body.data.internalReview.materialCodeDescription, 'Updated workbook description');
  assert.equal(update.body.data.comments[0].comment, 'Checked: lot A ✅');
  assert.equal(update.body.data.approvals[0].decision, 'hold');
  assert.deepEqual(update.body.data.internalReview.qateFinal, approval.body.data.internalReview.qateFinal);
  assert.equal((await api.request('/api/pcns', { session: admin })).body.data.length, 1);
  const deletion = await api.request(`/api/pcns/${record.id}`, { method: 'DELETE', session: admin, body: { version: update.body.data.version } });
  assert.equal(deletion.status, 200);
  assert.equal((await api.request(`/api/pcns/${record.id}`, { session: admin })).status, 404);
});

test('stale workbook update conflicts and preserves successful edit', async t => {
  const api = await startApi(t);
  const admin = await api.login('admin');
  const record = (await api.request('/api/pcns', { method: 'POST', session: admin, body: {...validPayload,status:'draft'} })).body.data;
  const first = await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: admin, body: { version: record.version, reason: 'first' } });
  assert.equal(first.status, 200);
  assert.equal((await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: admin, body: { version: record.version, reason: 'stale' } })).status, 409);
  assert.equal((await api.request(`/api/pcns/${record.id}`, { session: admin })).body.data.reason, 'first');
});

test('supplier sees own records only and cannot write privileged fields', async t => {
  const api = await startApi(t);
  const supplier = await api.login('supplier');
  const other = await api.login('other');
  const { internalReview, ...submission } = validPayload;
  const created = await api.request('/api/pcns', { method: 'POST', session: supplier, body: submission });
  assert.equal(created.status, 201);
  const record = created.body.data;
  assert.equal((await api.request('/api/pcns', { session: other })).body.data.length, 0);
  assert.equal((await api.request(`/api/pcns/${record.id}`, { session: other })).status, 404);
  assert.equal((await api.request(`/api/pcns/${record.id}/progress`, { session: other })).status, 404);
  for (const patch of [{ internalReview }, { status: 'gsc_review' }]) {
    assert.equal((await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: supplier, body: { version: record.version, ...patch } })).status, 403);
  }
  for (const patch of [{ ownerUserId: 'other-id' }, { approvals: [{ decision: 'approved' }] }]) {
    assert.equal((await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: supplier, body: { version: record.version, ...patch } })).status, 400);
  }
  assert.equal((await api.request(`/api/pcns/${record.id}`, { method: 'DELETE', session: supplier, body: { version: record.version } })).status, 403);
});

test('validation rejects mismatch, null body and skipped workflow transitions', async t => {
  const api = await startApi(t);
  const admin = await api.login('admin');
  for (const body of [null, [], { ...validPayload, riskLevel: 'RL0' }, { ...validPayload, changeRows: 'wrong type' }]) {
    assert.equal((await api.request('/api/pcns', { method: 'POST', session: admin, body })).status, 400);
  }
  const record = (await api.request('/api/pcns', { method: 'POST', session: admin, body: validPayload })).body.data;
  assert.equal((await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: admin, body: { version: record.version, status: 'technical_review' } })).status, 400);
  assert.equal((await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: admin, body: { reason: 'missing version' } })).status, 400);
  const next = await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: admin, body: { version: record.version, status: 'gsc_review' } });
  assert.equal(next.status, 200);
  assert.equal(next.body.data.status, 'gsc_review');
});

test('edited change text retains its original master option', async t => {
  const api = await startApi(t);
  const admin = await api.login('admin');
  const text = `${validPayload.selectedChange} - additional supplier note`;
  const create = await api.request('/api/pcns', { method: 'POST', session: admin, body: { ...validPayload,
    selectedChange: text, changeRows: validPayload.changeRows.map(row => ({ ...row, optionText: row.text, text })) } });
  assert.equal(create.status, 201);
  assert.equal(create.body.data.changeRows[0].optionText, validPayload.selectedChange);
  assert.equal(create.body.data.selectedChange, text);
});

test('notification mappings start empty, expose no secret URL and never auto send', async t => {
  const api = await startApi(t);
  const admin = await api.login('admin');
  const settings = await api.request('/api/notification-settings', { session: admin });
  assert.equal(settings.status, 200);
  assert.ok(settings.body.data.groups.every(group => !group.emails && !group.recipients.length));
  assert.equal(settings.body.data.flowUrl, undefined);
  const record = (await api.request('/api/pcns', { method: 'POST', session: admin, body: validPayload })).body.data;
  const notify = await api.request(`/api/pcns/${record.id}/notifications/workflow`, { method: 'POST', session: admin,
    body: { completedGroup: 'GSC/TET', nextGroupKey: 'signoff.prodEngTet', nextGroup: 'Prod.Eng/TET' } });
  assert.equal(notify.status, 202);
  assert.equal(notify.body.data.queued, false);
  assert.equal(notify.body.data.reason, 'recipient_not_configured');
  assert.equal(api.messages.length, 0);
  assert.equal((await api.request('/api/notification-settings', { session: await api.login('supplier') })).status, 403);
});

test('static serving denies private sources and browser pages contain no Firebase scripts', async t => {
  const api = await startApi(t);
  for (const file of ['/src/httpServer.js', '/data/pcn-db.json', '/plans/sql-server-migration.md', '/.env', '/package.json', '/test/api.test.js']) {
    const result = await api.request(file);
    assert.ok([403, 404].includes(result.status), `${file}: ${result.status}`);
  }
  for (const route of ['/', '/admin', '/create', '/PCN-2026-0001']) {
    const result = await api.request(route);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /text\/html/);
    assert.doesNotMatch(result.text, /firebase[^"']*\.js|firebasejs|firestore\.googleapis/i);
  }
});
