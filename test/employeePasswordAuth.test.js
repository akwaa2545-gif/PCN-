const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEmployeePassword } = require('../src/passwords');
const { createEmployeePasswordFixture } = require('./helpers/employeePasswordHarness');

test('employee password policy accepts eight letters, numbers or a mix without trimming', () => {
  for (const value of ['12345678', 'abcdefgh', 'ABCDEFGH', 'Abcd1234']) assert.doesNotThrow(() => validateEmployeePassword(value));
  for (const value of [null, undefined, 12345678, '', '1234567', '123456789', ' abcdefg', 'abcdefg ', 'abcd123!', 'abcdefgh\n', 'ภาษาไทย12']) {
    assert.throws(() => validateEmployeePassword(value), { statusCode: 400 });
  }
});

test('an unenrolled employee gets only a ten-minute setup session even with remember', async () => {
  const f = await createEmployeePasswordFixture();
  const result = await f.service.login({ employeeCode: '0012345', remember: true }, { ip: 'setup' });
  assert.equal(result.user.passwordSetupRequired, true); assert.equal(result.user.mustChangePassword, true);
  assert.equal(result.user.canChangePassword, false);
  assert.equal(Date.parse(result.expiresAt) - f.state.now, 600000);
  assert.equal(f.state.sessions[0].authenticationMethod, 'password-setup');
  assert.equal(Object.hasOwn(result.user, 'passwordHash'), false);
  assert.equal((await f.service.session(result.token)).user.passwordSetupRequired, true);
});

test('first setup stores only a hash, rotates credentials, revokes sessions and requires normal login', async () => {
  const f = await createEmployeePasswordFixture();
  const setup = await f.service.login({ employeeCode: '0012345' });
  const another = await f.service.login({ employeeCode: '0012345' });
  const before = f.state.users[0];
  await f.service.setupPassword(setup.token, { newPassword: '12345678', confirmPassword: '12345678' });
  const after = f.state.users[0];
  assert.notEqual(after.securityStamp, before.securityStamp); assert.equal(after.passwordHash, 'fixture-hash:12345678');
  assert(after.passwordSetAt); assert.deepEqual(after.roles, before.roles); assert.equal(after.id, before.id);
  assert.equal(await f.service.session(setup.token), null); assert.equal(await f.service.session(another.token), null);
  await assert.rejects(f.service.login({ employeeCode: '0012345' }), { statusCode: 401 });
  const login = await f.service.login({ employeeCode: '0012345', password: '12345678' });
  assert.equal(login.user.passwordSetupRequired, false); assert.equal(login.user.canChangePassword, true);
  assert.equal(f.state.sessions.at(-1).authenticationMethod, 'employee-password');
});

test('setup confirmation and exact password rules are checked before any credential write', async () => {
  const f = await createEmployeePasswordFixture(); const setup = await f.service.login({ employeeCode: '0012345' });
  for (const body of [{ newPassword: '1234567', confirmPassword: '1234567' }, { newPassword: '12345678', confirmPassword: 'abcdefgh' },
    { newPassword: '12345678' }, { newPassword: '12345678', confirmPassword: '12345678', userId: 'another' }]) {
    await assert.rejects(f.service.setupPassword(setup.token, body), { statusCode: 400 });
  }
  assert.equal(f.state.writes.length, 0); assert.equal(f.state.users[0].passwordHash, null);
});

test('legacy, null-method and setup sessions cannot authorize enrolled employee-password access', async () => {
  const f = await createEmployeePasswordFixture({ enrolled: true });
  for (const method of [null, 'employee-code', 'password', 'password-setup', 'unknown']) {
    const old = await f.seedSession(undefined, method);
    assert.equal(await f.service.session(old.token), null);
  }
  const valid = await f.seedSession(); assert.equal((await f.service.session(valid.token)).user.canChangePassword, true);
  await assert.rejects(f.service.setupPassword(valid.token, { newPassword: '12345678', confirmPassword: '12345678' }), { statusCode: 403 });
});

test('full sessions require paired enrolled credentials and setup sessions require both absent', async () => {
  for (const changes of [{ passwordHash: 'fixture-hash:12345678', passwordSetAt: null },
    { passwordHash: null, passwordSetAt: new Date().toISOString() }, { passwordHash: '', passwordSetAt: new Date().toISOString() }]) {
    const f = await createEmployeePasswordFixture({ userOverrides: changes });
    await assert.rejects(f.service.login({ employeeCode: '0012345', password: '12345678' }), { statusCode: 401 });
    for (const method of ['employee-password', 'password-setup']) {
      const session = await f.seedSession(undefined, method); assert.equal(await f.service.session(session.token), null);
    }
  }
});

test('roleless and local employees can enroll and change their own password', async () => {
  for (const provider of ['employee-code', 'pcn-local']) {
    const f = await createEmployeePasswordFixture({ provider, roles: [] });
    f.state.outage = provider === 'pcn-local';
    const setup = await f.service.login({ employeeCode: '0012345' });
    await f.service.setupPassword(setup.token, { newPassword: 'abcdefgh', confirmPassword: 'abcdefgh' });
    const login = await f.service.login({ employeeCode: '0012345', password: 'abcdefgh' });
    await f.service.changePassword(login.token, { currentPassword: 'abcdefgh', newPassword: '87654321', confirmPassword: '87654321' });
    assert.equal(await f.service.session(login.token), null);
    assert.equal((await f.service.login({ employeeCode: '0012345', password: '87654321' })).user.canChangePassword, true);
    if (provider === 'pcn-local') assert.equal(f.state.lookups.length, 0);
  }
});

test('password changes require current password and matching different new credentials, revoking all sessions', async () => {
  const f = await createEmployeePasswordFixture({ enrolled: true });
  const login = await f.service.login({ employeeCode: '0012345', password: f.password });
  const second = await f.service.login({ employeeCode: '0012345', password: f.password });
  for (const body of [{ currentPassword: 'wrongxxx', newPassword: '12345678', confirmPassword: '12345678' },
    { currentPassword: f.password, newPassword: f.password, confirmPassword: f.password },
    { currentPassword: f.password, newPassword: '12345678', confirmPassword: 'abcdefgh' }]) {
    await assert.rejects(f.service.changePassword(login.token, body), { statusCode: 400 });
  }
  assert.equal(f.state.writes.length, 0);
  await f.service.changePassword(login.token, { currentPassword: f.password, newPassword: '12345678', confirmPassword: '12345678' });
  assert.equal(await f.service.session(login.token), null); assert.equal(await f.service.session(second.token), null);
});

test('inactive employees, missing source identities and source outages never receive sessions', async () => {
  const inactive = await createEmployeePasswordFixture({ userOverrides: { isActive: false } });
  await assert.rejects(inactive.service.login({ employeeCode: '0012345' }), { statusCode: 401 });
  const absent = await createEmployeePasswordFixture(); absent.state.profileOverrides.set('0012345', null);
  await assert.rejects(absent.service.login({ employeeCode: '0012345' }), { statusCode: 401 });
  const outage = await createEmployeePasswordFixture(); outage.state.outage = true;
  await assert.rejects(outage.service.login({ employeeCode: '0012345' }), { statusCode: 503 });
  assert.equal(inactive.state.sessions.length + absent.state.sessions.length + outage.state.sessions.length, 0);
});

test('employee password failure lockout and login throttling remain enforced', async () => {
  const f = await createEmployeePasswordFixture({ enrolled: true });
  for (let index = 0; index < 5; index++) await assert.rejects(f.service.login({ employeeCode: '0012345', password: 'wrongxxx' }), { statusCode: 401 });
  await assert.rejects(f.service.login({ employeeCode: '0012345', password: f.password }), { statusCode: 401 });
  assert.equal(f.state.users[0].failedLoginCount, 5);
  f.state.now += 900001;
  assert((await f.service.login({ employeeCode: '0012345', password: f.password })).token);
  const throttled = await createEmployeePasswordFixture();
  for (let index = 0; index < 15; index++) await throttled.service.login({ employeeCode: '0012345' }, { ip: 'same' });
  await assert.rejects(throttled.service.login({ employeeCode: '0012345' }, { ip: 'same' }), { statusCode: 429 });
});

test('canonical identity changes during password verification cannot issue a session', async () => {
  const f = await createEmployeePasswordFixture({ enrolled: true });
  f.state.onVerify = () => { f.patchUser(f.state.users[0].id, { securityStamp: 'changed-by-another-request' }); };
  await assert.rejects(f.service.login({ employeeCode: '0012345', password: f.password }), { statusCode: 401 });
  assert.equal(f.state.sessions.length, 0);
});

test('two setup sessions cannot overwrite a password chosen by the winner', async () => {
  const f = await createEmployeePasswordFixture();
  const first = await f.service.login({ employeeCode: '0012345' }); const second = await f.service.login({ employeeCode: '0012345' });
  const result = await Promise.allSettled([
    f.service.setupPassword(first.token, { newPassword: '12345678', confirmPassword: '12345678' }),
    f.service.setupPassword(second.token, { newPassword: 'abcdefgh', confirmPassword: 'abcdefgh' })
  ]);
  assert.equal(result.filter(entry => entry.status === 'fulfilled').length, 1);
  assert.equal(f.state.writes.length, 1);
});

test('a newly discovered employee keeps leading zeros and receives no roles before enrollment', async () => {
  const f = await createEmployeePasswordFixture();
  f.state.profileOverrides.set('0000101', { employeeCode: '0000101', displayName: 'Synthetic New Employee', isActive: true });
  const setup = await f.service.login({ employeeCode: '0000101' });
  assert.equal(setup.user.employeeCode, '0000101'); assert.deepEqual(setup.user.roles, []);
  assert.equal(setup.user.passwordSetupRequired, true); assert.equal(f.state.users.length, 2);
  await f.service.setupPassword(setup.token, { newPassword: 'abcdefgh', confirmPassword: 'abcdefgh' });
  const login = await f.service.login({ employeeCode: '0000101', password: 'abcdefgh' });
  assert.equal(login.user.id, setup.user.id); assert.deepEqual(login.user.roles, []);
});

test('setup sessions expire without online presence and cannot change an existing password', async () => {
  const f = await createEmployeePasswordFixture(); const setup = await f.service.login({ employeeCode: '0012345' });
  assert.deepEqual(f.service.presence.candidates(), []);
  await assert.rejects(f.service.changePassword(setup.token, { currentPassword: 'abcdefgh', newPassword: '12345678', confirmPassword: '12345678' }), { statusCode: 403 });
  f.state.now += 600001;
  assert.equal(await f.service.session(setup.token), null);
  await assert.rejects(f.service.setupPassword(setup.token, { newPassword: '12345678', confirmPassword: '12345678' }), { statusCode: 401 });
  assert.equal(f.state.writes.length, 0);
});

test('new login rejects injected privilege fields and malformed supplied credentials', async () => {
  const f = await createEmployeePasswordFixture();
  for (const body of [{ employeeCode: '0012345', roles: ['admin'] }, { employeeCode: '0012345', remember: 'yes' },
    { employeeCode: '0012345', password: {} }, { employeeCode: '0012345', password: 'x'.repeat(129) }, { employeeCode: 12345 }]) {
    await assert.rejects(f.service.login(body), error => [400, 401].includes(error.statusCode));
  }
  assert.equal(f.state.sessions.length, 0);
});

test('current-password attempts are bounded without permitting an old session after a successful change', async () => {
  const f = await createEmployeePasswordFixture({ enrolled: true });
  const login = await f.service.login({ employeeCode: '0012345', password: f.password });
  const body = { currentPassword: 'wrongxxx', newPassword: '12345678', confirmPassword: '12345678' };
  for (let index = 0; index < 5; index++) await assert.rejects(f.service.changePassword(login.token, body), { statusCode: 400 });
  await assert.rejects(f.service.changePassword(login.token, { ...body, currentPassword: f.password }), { statusCode: 429 });
  assert.equal(f.state.writes.length, 0);
  f.state.now += 900001;
  await f.service.changePassword(login.token, { ...body, currentPassword: f.password });
  assert.equal(await f.service.session(login.token), null); assert.equal(f.state.writes.length, 1);
});

test('a credential change during current-password verification cannot be overwritten', async () => {
  const f = await createEmployeePasswordFixture({ enrolled: true });
  const login = await f.service.login({ employeeCode: '0012345', password: f.password });
  const priorHash = f.state.users[0].passwordHash;
  f.state.onVerify = () => f.patchUser(f.state.users[0].id, { securityStamp: 'another-credential-version' });
  await assert.rejects(f.service.changePassword(login.token, { currentPassword: f.password, newPassword: '12345678', confirmPassword: '12345678' }), { statusCode: 409 });
  assert.equal(f.state.users[0].passwordHash, priorHash); assert.equal(f.state.writes.length, 0);
});

test('session method is rechecked after delayed employee verification', async () => {
  const f = await createEmployeePasswordFixture({ enrolled: true });
  const login = await f.service.login({ employeeCode: '0012345', password: f.password });
  f.state.onLookup = () => { f.state.sessions = f.state.sessions.map(session => ({ ...session, authenticationMethod: 'employee-code' })); };
  assert.equal(await f.service.session(login.token), null);
});

test('invalid stored hashes fail as credentials instead of exposing verifier details', async () => {
  const f = await createEmployeePasswordFixture({ enrolled: true });
  f.state.onVerify = () => { throw new Error('Synthetic private verifier detail'); };
  await assert.rejects(f.service.login({ employeeCode: '0012345', password: f.password }), error => error.statusCode === 401 && !error.message.includes('private'));
  assert.equal(f.state.sessions.length, 0);
});
