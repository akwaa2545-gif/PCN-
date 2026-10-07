const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function client(responses, location = {}) {
  const calls = [];
  const redirects = [];
  const window = { location: { origin: 'https://pcn.example', pathname: '/PCN-2026-0001', search: '', hash: '', ...location, assign: (url) => redirects.push(url) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'session-client.js'), 'utf8'), {
    window, URL, Headers,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = responses.shift();
      return { ok: response.status < 400, status: response.status, json: async () => response.body };
    }
  });
  return { api: window.PCN_SESSION, calls, redirects };
}
const success = (data) => ({ status: 200, body: { success: true, data } });

test('loading an expired or mismatched session resets authentication and stale CSRF without a login loop', async () => {
  const c = client([success({ authenticated: true, user: { roles: ['admin'] }, csrfToken: 'stale-token' }),
    { status: 401, body: { success: false, error: 'Employee access could not be verified' } }, success({})]);
  await c.api.load();
  assert.equal(JSON.stringify(await c.api.load()), JSON.stringify({ authenticated: false, user: null, csrfToken: '' }));
  await c.api.fetch('/api/auth/login', { method: 'POST', body: '{"employeeCode":"001234"}' });
  assert.equal(c.calls[2].options.headers.has('x-csrf-token'), false);
  assert.deepEqual(c.redirects, []);
});

test('session infrastructure failures remain errors instead of appearing signed out', async () => {
  const c = client([{ status: 503, body: { success: false, error: 'Employee service is unavailable' } }]);
  await assert.rejects(c.api.load(), (error) => error.status === 503);
  assert.deepEqual(c.redirects, []);
});

test('cookie session supplies CSRF for edits and never trusts role headers from callers', async () => {
  const c = client([success({ authenticated: true, user: { roles: ['supplier'] }, csrfToken: 'session-token' }), success({ id: 'PCN-2026-0001' })]);
  await c.api.load();
  await c.api.fetch('/api/pcns/PCN-2026-0001', { method: 'PATCH', headers: { 'x-user-role': 'admin' }, body: '{"version":"v1"}' });
  assert.equal(c.calls[1].options.credentials, 'same-origin');
  assert.equal(c.calls[1].options.headers.get('x-csrf-token'), 'session-token');
  assert.equal(c.calls[1].options.headers.has('x-user-role'), false);
});

test('auth gate redirects unauthenticated users with a local return path', async () => {
  const c = client([success({ authenticated: false })]);
  assert.equal(await c.api.require(), null);
  assert.equal(c.redirects[0], '/login?returnTo=%2FPCN-2026-0001');
});

test('email PCN query link survives sign-in and expired-session redirects', async () => {
  const location = { pathname: '/form.html', search: '?id=PCN-2026-0001', hash: '#review' };
  const expected = '/login?returnTo=%2Fform.html%3Fid%3DPCN-2026-0001%23review';
  const signedOut = client([success({ authenticated: false })], location);
  assert.equal(await signedOut.api.require(), null);
  assert.deepEqual(signedOut.redirects, [expected]);
  const expired = client([{ status: 401, body: { success: false, error: 'Authentication required' } }], location);
  await assert.rejects(expired.api.fetch('/api/pcns/PCN-2026-0001'), (error) => error.status === 401);
  assert.deepEqual(expired.redirects, [expected]);
  assert.equal(expired.api.safeReturnTo('/form.html?id=PCN-2026-0001#review'), '/form.html?id=PCN-2026-0001#review');
});

test('temporary-password users are sent to password change before protected data loads', async () => {
  const c = client([success({ authenticated: true, user: { mustChangePassword: true }, csrfToken: 't' })]);
  assert.equal(await c.api.require(), null);
  assert.equal(c.redirects[0], '/login?returnTo=%2FPCN-2026-0001&changePassword=1');
  assert.equal(c.calls.length, 1);
});

test('foreign API destinations and protocol-relative URLs never receive credentials', async () => {
  const c = client([]);
  await assert.rejects(c.api.fetch('https://evil.example/api/users'), /same-origin/);
  await assert.rejects(c.api.fetch('//evil.example/api/users'), /same-origin/);
  assert.equal(c.calls.length, 0);
});

test('version conflict preserves status and tells user to refresh instead of retrying write', async () => {
  const c = client([{ status: 409, body: { success: false, error: 'Stale version' } }]);
  await assert.rejects(c.api.fetch('/api/pcns/x', { method: 'PATCH' }), (error) => error.status === 409 && /refresh/i.test(error.message));
  assert.equal(c.calls.length, 1);
});

test('return destinations reject external and encoded authority redirects', () => {
  const c = client([]);
  for (const url of ['https://evil.example/', '//evil.example/', '/\\evil.example/', '/%2f%2fevil.example']) assert.equal(c.api.safeReturnTo(url), '/create');
  assert.equal(c.api.safeReturnTo('/admin#mail-routing'), '/admin#mail-routing');
});

test('login response rotates the CSRF token used by the next password change', async () => {
  const c = client([success({ authenticated: true, user: { mustChangePassword: true }, csrfToken: 'login-token' }), success({ changed: true })]);
  await c.api.fetch('/api/auth/login', { method: 'POST', body: '{"username":"user","password":"temporary"}' });
  await c.api.fetch('/api/auth/change-password', { method: 'POST', body: '{"currentPassword":"temporary","newPassword":"a-long-password"}' });
  assert.equal(c.calls[0].options.headers.has('x-csrf-token'), false);
  assert.equal(c.calls[1].options.headers.get('x-csrf-token'), 'login-token');
});

test('expired protected session redirects to login and propagates the failure', async () => {
  const c = client([{ status: 401, body: { success: false, error: 'Authentication required' } }]);
  await assert.rejects(c.api.fetch('/api/pcns'), (error) => error.status === 401);
  assert.equal(c.redirects.length, 1);
});

test('admin gate checks server roles without relying on hostname or local state', async () => {
  const c = client([success({ authenticated: true, user: { roles: ['supplier'] } })]);
  await assert.rejects(c.api.require('admin'), /does not have access/);
  const admin = client([success({ authenticated: true, user: { roles: ['Admin'] } })]);
  assert.equal((await admin.api.require('admin')).authenticated, true);
});

test('server password-change rejection redirects to password change', async () => {
  const c = client([{ status: 403, body: { success: false, error: 'Change password first', code: 'PASSWORD_CHANGE_REQUIRED' } }]);
  await assert.rejects(c.api.fetch('/api/pcns'), (error) => error.status === 403 && error.code === 'PASSWORD_CHANGE_REQUIRED');
  assert.match(c.redirects[0], /changePassword=1$/);
});

test('employee-code sign-in preserves the code and rotates session CSRF for provisioning', async () => {
  const c = client([success({ authenticated: true, user: { username: 'EMP001', employeeCode: 'EMP001', roles: ['admin'], mustChangePassword: false }, csrfToken: 'employee-session-token' }), success({ id: 'created-user' })]);
  const session = await c.api.fetch('/api/auth/login', { method: 'POST', body: '{"employeeCode":"EMP001"}' });
  assert.equal(session.user.employeeCode, 'EMP001');
  assert.equal(session.user.mustChangePassword, false);
  assert.equal(c.calls[0].options.body, '{"employeeCode":"EMP001"}');
  assert.equal(c.calls[0].options.headers.has('x-windows-user'), false);
  await c.api.fetch('/api/admin/users', { method: 'POST', body: '{"employeeCode":"001234","roles":["reviewer"],"department":"qaTet"}' });
  assert.equal(c.calls[1].options.headers.get('x-csrf-token'), 'employee-session-token');
  assert.deepEqual(c.redirects, []);
});
