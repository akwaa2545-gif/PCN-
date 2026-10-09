const test = require('node:test');
const assert = require('node:assert/strict');
const { applySignatureIdentity, assertReviewUpdate } = require('../src/workflowAccess');
const { startApi, unsignedPayload, fakeAuthService } = require('./helpers/apiHarness');

const now = '2026-10-09T09:00:00.000Z';
const supplier = { id: 'supplier-id', roles: ['supplier'], displayName: 'Alice Supplier' };
const actions = ['approved', 'checked', 'prepared'];

test('supplier signing stamps canonical names for all actions without changing dates or input', () => {
  for (const action of actions) {
    const input = { supplierSignoff: { [action]: { checked: true, name: 'Forged', date: '2026-10-01' } } };
    const result = applySignatureIdentity({}, input, supplier, now);
    assert.deepEqual(result.supplierSignoff[action], { checked: true, name: 'Alice Supplier', date: '2026-10-01' });
    assert.equal(input.supplierSignoff[action].name, 'Forged');
    for (const [user, expected] of [
      [{ username: 'Supplier Username', employeeCode: 'E100' }, 'Supplier Username'],
      [{ employeeCode: 'E100' }, 'E100'], [{ displayName: 'A'.repeat(220) }, 'A'.repeat(200)]
    ]) assert.equal(applySignatureIdentity({}, input, user, now).supplierSignoff[action].name, expected);
  }
});

test('clearing supplier checks clears signer names while preserving supplier date behavior', () => {
  for (const action of actions) {
    const before = { supplierSignoff: { [action]: { checked: true, name: 'Original Signer', date: '2026-10-01' } } };
    const after = { supplierSignoff: { [action]: { ...before.supplierSignoff[action], checked: false } } };
    const result = applySignatureIdentity(before, after, supplier, now);
    assert.equal(result.supplierSignoff[action].name, '');
    assert.equal(result.supplierSignoff[action].date, '2026-10-01');
    assert.equal(before.supplierSignoff[action].name, 'Original Signer');
  }
});

test('unchanged supplier checks preserve saved names and historical nameless signatures', () => {
  for (const group of [
    { checked: true, name: 'Original Signer', date: '2026-10-01' },
    { checked: true, date: '2026-10-01' }, { checked: true, name: '', date: '2026-10-01' }
  ]) {
    const before = { supplierSignoff: { approved: group } };
    assert.deepEqual(applySignatureIdentity(before, before, supplier, now), before);
    for (const name of ['Forged', '']) {
      if (name === group.name || (name === '' && group.name === undefined)) continue;
      const after = { supplierSignoff: { approved: { ...group, name } } };
      assert.throws(() => applySignatureIdentity(before, after, supplier, now), { statusCode: 400 });
    }
  }
  assert.throws(() => applySignatureIdentity({ supplierSignoff: { approved: { checked: false } } },
    { supplierSignoff: { approved: { checked: false, name: 'Forged' } } }, supplier, now), { statusCode: 400 });
});

test('supplier signature groups and check values require the expected shape', () => {
  for (const value of [null, '', false, [], 1]) {
    assert.throws(() => assertReviewUpdate({}, { supplierSignoff: value }, supplier, 'RL2'), { statusCode: 400 });
    for (const action of actions) {
      assert.throws(() => assertReviewUpdate({}, { supplierSignoff: { [action]: value } }, supplier, 'RL2'), { statusCode: 400 });
    }
  }
  for (const checked of ['true', '', 1, null]) {
    assert.throws(() => assertReviewUpdate({}, { supplierSignoff: { prepared: { checked } } }, supplier, 'RL2'), { statusCode: 400 });
  }
});

test('removing supplier signatures or saved names without an explicit uncheck is rejected', () => {
  const before = { supplierSignoff: { approved: { checked: true, name: 'Original Signer' } } };
  for (const after of [{}, { supplierSignoff: {} }, { supplierSignoff: { approved: {} } },
    { supplierSignoff: { approved: { checked: true } } }]) {
    assert.throws(() => applySignatureIdentity(before, after, supplier, now), { statusCode: 400 });
  }
});

test('supplier API stamps, preserves and clears saved signer identity with existing access rules', async t => {
  const api = await startApi(t, { authService: fakeAuthService({ additionalUsers: [
    { username: 'named-supplier', roles: ['supplier'], displayName: 'Alice Supplier' },
    { username: 'gsc', roles: ['gsc'], displayName: 'Other Viewer' }
  ] }) });
  const owner = await api.login('named-supplier');
  const admin = await api.login('admin');
  const other = await api.login('other');
  const gsc = await api.login('gsc');
  const created = await api.request('/api/pcns', { method: 'POST', session: owner, body: {
    ...unsignedPayload, status: 'draft', internalReview: { supplierSignoff: {
      approved: { checked: true, name: 'Forged', date: '2026-10-01' }
    } }
  } });
  assert.equal(created.status, 201);
  let record = created.body.data;
  assert.equal(record.internalReview.supplierSignoff.approved.name, 'Alice Supplier');
  const patch = (session, internalReview) => api.request(`/api/pcns/${record.id}`, {
    method: 'PATCH', session, body: { version: record.version, internalReview }
  });
  const updated = await patch(admin, { supplierSignoff: { approved: { checked: true } } });
  assert.equal(updated.status, 200);
  record = updated.body.data;
  assert.equal(record.internalReview.supplierSignoff.approved.name, 'Alice Supplier', 'another viewer cannot relabel a checked signature');
  for (const invalid of [
    { supplierSignoff: null }, { supplierSignoff: { approved: null } },
    { supplierSignoff: { approved: { name: 'Rewritten' } } },
    { supplierSignoff: { approved: { name: '' } } },
    { supplierSignoff: { approved: { checked: 'true' } } }
  ]) {
    assert.equal((await patch(owner, invalid)).status, 400);
    assert.deepEqual(await api.repository.findById(record.id), record, 'invalid patch is atomic');
  }
  for (const empty of [{ supplierSignoff: {} }, { supplierSignoff: { approved: {} } }]) {
    const preserved = await patch(owner, empty);
    assert.equal(preserved.status, 200);
    record = preserved.body.data;
    assert.equal(record.internalReview.supplierSignoff.approved.name, 'Alice Supplier');
  }
  assert.equal((await patch(gsc, { supplierSignoff: { approved: { checked: false } } })).status, 403);
  assert.equal((await patch(other, { supplierSignoff: { approved: { checked: false } } })).status, 404);
  const cleared = await patch(owner, { supplierSignoff: { approved: { checked: false } } });
  assert.equal(cleared.status, 200);
  record = cleared.body.data;
  assert.equal(record.internalReview.supplierSignoff.approved.name, '');
  assert.equal(record.internalReview.supplierSignoff.approved.date, '2026-10-01');
  const signed = await patch(owner, { supplierSignoff: { approved: { checked: true, name: 'Forged Again' } } });
  assert.equal(signed.status, 200);
  assert.equal(signed.body.data.internalReview.supplierSignoff.approved.name, 'Alice Supplier');
});

test('historical nameless supplier signatures remain nameless when saved through HTTP', async t => {
  const api = await startApi(t);
  const owner = await api.login('supplier');
  const created = await api.request('/api/pcns', { method: 'POST', session: owner, body: { ...unsignedPayload, status: 'draft' } });
  const historical = { supplierSignoff: { prepared: { checked: true, date: '2020-01-01' } } };
  let record = await api.repository.seedHistoricalReview(created.body.data.id, historical);
  const saved = await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: owner,
    body: { version: record.version, internalReview: { supplierSignoff: { prepared: { checked: true } } } } });
  assert.equal(saved.status, 200);
  record = saved.body.data;
  assert.deepEqual(record.internalReview.supplierSignoff, historical.supplierSignoff);
  const rewrite = await api.request(`/api/pcns/${record.id}`, { method: 'PATCH', session: owner,
    body: { version: record.version, internalReview: { supplierSignoff: { prepared: { name: 'New Viewer' } } } } });
  assert.equal(rewrite.status, 400);
  assert.deepEqual(await api.repository.findById(record.id), record);
});
