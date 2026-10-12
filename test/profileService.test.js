const test = require('node:test');
const assert = require('node:assert/strict');
const { ProfileService } = require('../src/profileService');

const photo = 'data:image/png;base64,aGVsbG8=';
const user = { id: 'current-user', isActive: true, identityProvider: 'employee-code', employeeCode: '2205529', version: 'v1', sessionSecurityStamp: 'stamp1', email: null };
const candidate = { id: 'directory-current', displayName: 'Watcharaphong Banyen', email: 'person@example.test', photo, jobTitle: 'Engineer', department: 'Information Technology' };
const empty = { status: 'unavailable', photo: '', email: '', jobTitle: '', directoryDepartment: '' };
const employeeDirectory = { async getByCode(code) { assert.equal(code, '2205529'); return { employeeCode: code, englishName: 'WATCHARAPHONG BANYEN' }; } };

test('current employee is matched by exact normalized English full name, without persisting mail', async () => {
  const queries = [];
  const service = new ProfileService({ employeeDirectory, integrationService: { async directory(query) { queries.push(query); return { users: [{ ...candidate, displayName: ' Watcharaphong   Banyen ' }, { ...candidate, displayName: 'Another Person' }] }; } } });
  const input = structuredClone(user);
  assert.deepEqual(await service.get(input), { status: 'available', photo, email: candidate.email, jobTitle: candidate.jobTitle, directoryDepartment: candidate.department });
  assert.deepEqual(input, user);
  assert.deepEqual(queries, ['WATCHARAPHONG BANYEN']);
});

test('ambiguous name, partial names, missing employee, wrong employee and oversized names remain unavailable', async () => {
  for (const users of [[candidate, { ...candidate, id: 'another-id' }], [{ ...candidate, displayName: 'Watcharaphong Banyen Jr' }], []]) {
    const service = new ProfileService({ employeeDirectory, integrationService: { async directory() { return { users }; } } });
    assert.deepEqual(await service.get(user), empty);
  }
  for (const employee of [null, { employeeCode: 'other', englishName: candidate.displayName }, { employeeCode: user.employeeCode, englishName: 'x'.repeat(101) }]) {
    const service = new ProfileService({ employeeDirectory: { async getByCode() { return employee; } }, integrationService: { async directory() { assert.fail('No unsafe query'); } } });
    assert.deepEqual(await service.get(user), empty);
  }
});

test('verified saved profile is used immediately and missing photo requires exact directory id and email', async () => {
  const linked = { ...user, email: candidate.email, mailProfile: candidate };
  const immediate = new ProfileService({ integrationService: { async directory() { assert.fail('No lookup for stored safe photo'); } } });
  assert.equal((await immediate.get(linked)).photo, photo);
  for (const users of [[{ ...candidate, id: 'different' }], [{ ...candidate, email: 'other@example.test' }], [candidate, candidate]]) {
    const service = new ProfileService({ employeeDirectory, integrationService: { async directory(query) { assert.equal(query, candidate.email); return { users }; } } });
    assert.deepEqual(await service.get({ ...linked, mailProfile: { ...candidate, photo: '' } }), empty);
  }
  const service = new ProfileService({ integrationService: { async directory() { return { users: [candidate] }; } } });
  assert.equal((await service.get({ ...linked, mailProfile: { ...candidate, photo: '' } })).photo, photo);
});

test('unsafe photos and invalid directory fields are bounded and never become executable URLs', async () => {
  for (const unsafe of ['https://outside.example/photo', 'data:image/svg+xml;base64,PHN2Zz4=', 'javascript:alert(1)', 'data:image/png;base64,' + 'a'.repeat(104000)]) {
    const service = new ProfileService({ employeeDirectory, integrationService: { async directory() { return { users: [{ ...candidate, photo: unsafe, jobTitle: 'x'.repeat(500), department: 'y'.repeat(500) }] }; } } });
    const result = await service.get(user);
    assert.equal(result.photo, '');
    assert.equal(result.jobTitle.length, 120);
    assert.equal(result.directoryDepartment.length, 120);
  }
  const service = new ProfileService({ employeeDirectory, integrationService: { async directory() { return { users: [{ ...candidate, email: 'bad@example.test; attacker@example.test' }] }; } } });
  assert.deepEqual(await service.get(user), empty);
});

test('integration failures return generic fallback; in-flight requests deduplicate and cache respects stamp/version/TTL', async () => {
  let calls = 0;
  let time = 0;
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const service = new ProfileService({ employeeDirectory, now: () => time, integrationService: { async directory() { calls++; await wait; return { users: [candidate] }; } } });
  const pending = [service.get(user), service.get(user)];
  release();
  const responses = await Promise.all(pending);
  assert.equal(calls, 1);
  responses[0].email = 'mutation@example.test';
  assert.equal((await service.get(user)).email, candidate.email);
  assert.equal(calls, 1);
  await service.get({ ...user, sessionSecurityStamp: 'stamp2' });
  await service.get({ ...user, version: 'v2' });
  assert.equal(calls, 3);
  time = 300001;
  await service.get(user);
  assert.equal(calls, 4);
  const failing = new ProfileService({ employeeDirectory, integrationService: { async directory() { throw new Error('secret endpoint signature'); } } });
  assert.deepEqual(await failing.get(user), empty);
  assert.deepEqual(await failing.get({ ...user, isActive: false }), empty);
  assert.deepEqual(await failing.get(null), empty);
});

test('unverified profile, wrong account email and non-employee accounts cannot trigger name lookup', async () => {
  let calls = 0;
  const service = new ProfileService({ employeeDirectory: { async getByCode() { calls++; return null; } },
    integrationService: { async directory() { calls++; return { users: [candidate] }; } } });
  for (const input of [
    { ...user, mailProfile: candidate },
    { ...user, email: candidate.email, mailProfile: { ...candidate, id: '' } },
    { ...user, identityProvider: 'password', mailProfile: null },
    { ...user, employeeCode: '' }
  ]) assert.deepEqual(await service.get(input), empty);
  assert.equal(calls, 0);
  assert.deepEqual(await new ProfileService().get(user), empty);
});

test('cache capacity stays bounded and expired entries free capacity', async () => {
  let time = 0;
  const service = new ProfileService({ now: () => time });
  for (let index = 0; index < 501; index++) {
    await service.get({ ...user, id: `user-${index}`, email: candidate.email, mailProfile: candidate });
  }
  assert.equal(service.cache.size, 500);
  const input = { ...user, id: 'new-user', email: candidate.email, mailProfile: candidate };
  assert.deepEqual(await service.get(input), empty);
  time = 300001;
  assert.equal((await service.get(input)).status, 'available');
  assert.equal(service.cache.size, 1);
});
