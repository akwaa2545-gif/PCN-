const test = require('node:test');
const assert = require('node:assert/strict');
const { startApi, fakeAuthService, unsignedPayload } = require('./helpers/apiHarness');
const { isEmployeeViewer, canViewAllRecords } = require('../src/workflowAccess');
const { normalizeMailRouting } = require('../src/mailRouting');
const { applyUserMailRouting, filterPendingRecipients, readUserMailAssignments } = require('../src/userMailRouting');
const { notificationRecipient, filterPendingUpdates } = require('../src/notificationUpdates');

const local = { id: 'local-id', username: 'local', employeeCode: '0098765', identityProvider: 'pcn-local',
  roles: [], isActive: true };
const signer = { ...local, roles: ['gsc'], department: 'gscTet', signingStep: 'checked',
  email: 'Local@example.test', mailDirectoryId: 'local-directory', mailVerifiedAt: '2026-10-12',
  mailProfile: { id: 'local-directory', email: 'Local@example.test', displayName: 'Local Employee' } };

test('PCN-only roleless accounts retain read-only access and never gain write authority', async t => {
  assert.equal(isEmployeeViewer(local), true);
  assert.equal(canViewAllRecords(local), true);
  assert.equal(canViewAllRecords({ ...local, isActive: false }), false);
  const api = await startApi(t, { authService: fakeAuthService({ additionalUsers: [local] }) });
  const supplier = await api.login('supplier');
  const created = await api.request('/api/pcns', { method: 'POST', session: supplier, body: unsignedPayload });
  assert.equal(created.status, 201);
  const session = await api.login('local');
  const code = created.body.data.id;
  const list = await api.request('/api/pcns', { session });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map(record => record.id), [code]);
  assert.equal((await api.request(`/api/pcns/${code}`, { session })).status, 200);
  for (const [method, route] of [['POST', '/api/pcns'], ['PATCH', `/api/pcns/${code}`],
    ['POST', '/api/admin/local-users'], ['POST', `/api/pcns/${code}/notifications/workflow`]]) {
    assert.equal((await api.request(route, { method, session, body: unsignedPayload })).status, 403);
  }
  assert.deepEqual(api.messages, []);
});

test('verified PCN-only signing assignments receive only their assigned step and revoke pending mail', () => {
  const settings = { schemaVersion: 2, groups: [] };
  const routing = normalizeMailRouting(applyUserMailRouting(settings, [signer]));
  assert.deepEqual(routing.groups.filter(group => group.automaticRecipients.length).map(group => group.key),
    ['department.gscTet.checked']);
  const payload = { to: signer.email, routingSnapshot: { groupKey: 'department.gscTet.checked', manualEmails: '',
    automaticRecipients: [{ userId: signer.id, email: signer.email, department: signer.department,
      signingStep: signer.signingStep, directoryId: signer.mailDirectoryId }] } };
  assert.equal(filterPendingRecipients(payload, [signer]).to, signer.email);
  for (const patch of [{ isActive: false }, { mailVerifiedAt: null }, { signingStep: 'approved' },
    { roles: ['supplier'] }, { identityProvider: 'unknown' }]) {
    assert.equal(filterPendingRecipients(payload, [{ ...signer, ...patch }]).to, '');
  }
});

test('PCN-only general notifications require verified identity and current record access', () => {
  const record = { id: 'PCN-2026-0001', ownerUserId: 'other' };
  assert.equal(notificationRecipient(signer, record).email, signer.email);
  const payload = { to: signer.email, updateSnapshot: { recipients: [
    { userId: signer.id, directoryId: signer.mailDirectoryId, email: signer.email }
  ] } };
  assert.equal(filterPendingUpdates(payload, [signer], record).to, signer.email);
  for (const patch of [{ isActive: false }, { roles: [] }, { roles: ['supplier'] },
    { mailDirectoryId: 'changed' }, { mailVerifiedAt: null }]) {
    assert.equal(filterPendingUpdates(payload, [{ ...signer, ...patch }], record).to, '');
  }
});

test('SQL managed-recipient reads include both supported employee account sources', async () => {
  let statement;
  const tx = { request: () => ({ query: async sql => { statement = sql; return { recordset: [] }; } }) };
  await readUserMailAssignments(tx);
  assert.match(statement, /IdentityProvider\s+IN\s*\(N'employee-code',\s*N'pcn-local'\)/);
});
