const test = require('node:test');
const assert = require('node:assert/strict');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');

function fixture(results) {
  const state = { calls: [], committed: false, rolledBack: false };
  const request = () => {
    let inputs = {};
    return {
      input(name, type, value) { inputs = { ...inputs, [name]: value }; return this; },
      async query(query) {
        state.calls = [...state.calls, { query, inputs }];
        const result = results[state.calls.length - 1];
        if (result instanceof Error) throw result;
        return { rowsAffected: [1], recordset: [], ...result };
      }
    };
  };
  const pool = { request, transaction: () => ({ request, async begin() {}, async commit() { state.committed = true; }, async rollback() { state.rolledBack = true; } }) };
  return { repo: new SqlAuthRepository(pool), state };
}

test('SQL auth binds hostile login input and hydrates role grants', async () => {
  const { repo, state } = fixture([{ recordsets: [[{ Id: 'id', Username: 'user', PasswordHash: 'secret', IsActive: true, SecurityStamp: 'stamp' }], [{ Name: 'admin' }, { Name: 'qa' }]] }]);
  const hostile = "someone' OR 1=1 --";
  const user = await repo.getUserByLogin(hostile);
  assert.deepEqual(user.roles, ['admin', 'qa']);
  assert.equal(state.calls[0].inputs.login, hostile);
  assert.equal(state.calls[0].query.includes(hostile), false);
});

test('password change rolls back when account stamp changed concurrently', async () => {
  const { repo, state } = fixture([{ rowsAffected: [0] }]);
  await assert.rejects(repo.updatePassword('id', 'new-hash', 'new-stamp', 'old-stamp'), error => error.statusCode === 409);
  assert.equal(state.rolledBack, true);
  assert.equal(state.committed, false);
  assert.equal(state.calls.length, 1);
});

test('password change updates stamp and revokes sessions/tokens in one transaction', async () => {
  const { repo, state } = fixture([{ rowsAffected: [1] }, { rowsAffected: [3, 1] }]);
  await repo.updatePassword('id', 'new-hash', 'new-stamp', 'old-stamp');
  assert.equal(state.committed, true);
  assert.equal(state.calls[0].inputs.expected, 'old-stamp');
  assert.equal(state.calls[0].inputs.hash, 'new-hash');
  assert.equal(state.calls[1].inputs.id, 'id');
});

test('user list groups multiple roles without exposing password hashes', async () => {
  const { repo } = fixture([{ recordset: [{ Id: 'one', Username: 'user', Email: null, IsActive: true, Role: 'admin' }, { Id: 'one', Username: 'user', IsActive: true, Role: 'qa' }, { Id: 'two', Username: 'another', Role: null }] }]);
  const users = await repo.listUsers();
  assert.equal(users.length, 2);
  assert.deepEqual(users[0].roles, ['admin', 'qa']);
  assert.deepEqual(users[1].roles, []);
  assert.equal(users[0].passwordHash, undefined);
});

test('first employee sign-in stores a roleless account without PCN grants', async () => {
  const row = { Id: 'viewer-id', Username: '001234', EmployeeCode: '001234', NormalizedEmployeeCode: '001234',
    IdentityProvider: 'employee-code', IsActive: true, SecurityStamp: 'stamp' };
  const { repo, state } = fixture([{ rowsAffected: [1] }, { rowsAffected: [1] }, { recordsets: [[row], []] }]);
  const viewer = await repo.createEmployeeViewer({ employeeCode: '001234', displayName: 'Employee Name' });
  assert.deepEqual(viewer.roles, []);
  assert.equal(viewer.identityProvider, 'employee-code');
  assert.equal(state.calls[0].inputs.normalizedEmployeeCode, '001234');
  assert.match(state.calls[0].query, /DepartmentKey.*NULL/);
  assert.equal(state.calls.some(call => /INSERT pcn.UserRoles/i.test(call.query)), false);
  assert.equal(state.committed, true);
});

test('create user stores hash and commits normalized identity and role together', async () => {
  const { repo, state } = fixture([{ rowsAffected: [1] }, { rowsAffected: [1] }, { recordsets: [[{ Id: 'created', Username: 'ITadmin', Email: null }], [{ Name: 'admin' }]] }]);
  const result = await repo.createUser({ username: 'ITadmin', email: null, passwordHash: 'salted-hash', roles: ['admin'], mustChangePassword: true });
  assert.equal(result.username, 'ITadmin');
  assert.equal(state.calls[0].inputs.normalizedUsername, 'itadmin');
  assert.equal(state.calls[0].inputs.normalizedEmail, null);
  assert.equal(state.calls[0].inputs.hash, 'salted-hash');
  assert.equal(state.calls[0].inputs.change, true);
  assert.equal(state.committed, true);
});

test('duplicate identity creation rolls back and reports safe conflict', async () => {
  const duplicate = Object.assign(new Error('internal unique key SQL detail'), { number: 2627 });
  const { repo, state } = fixture([duplicate]);
  await assert.rejects(repo.createUser({ username: 'user', email: 'user@example.com', passwordHash: 'hash', roles: ['supplier'], mustChangePassword: false }), error => error.statusCode === 409 && !error.message.includes('internal'));
  assert.equal(state.rolledBack, true);
});

test('SQL sessions persist hash instead of token and hydrate expiry', async () => {
  const expires = new Date('2026-01-02');
  const { repo, state } = fixture([{ rowsAffected: [1] }, { recordset: [{ Id: 'session', UserId: 'user', TokenHash: 'hash', CsrfToken: 'csrf', SecurityStamp: 'stamp', ExpiresAt: expires, RevokedAt: null }] }, { recordset: [] }]);
  await repo.saveSession({ id: 'session', userId: 'user', tokenHash: 'hash', csrfToken: 'csrf', securityStamp: 'stamp', createdAt: '2026-01-01', expiresAt: expires });
  assert.equal(state.calls[0].inputs.hash, 'hash');
  const session = await repo.getSession('hash');
  assert.equal(session.userId, 'user');
  assert.equal(session.expiresAt, expires);
  assert.equal(await repo.getSession('missing'), null);
  await repo.revokeSession('hash');
  await repo.recordLoginFailure('user', expires);
  await repo.resetLoginFailures('user');
  assert.match(state.calls.at(-1).query,/FailedLoginCount=0/);
});

test('presence batch SQL binds observed hashes and revalidates active accounts, expiry, revocation and stamps',async () => {
  const hash = 'a'.repeat(64);
  const now = new Date('2026-10-15T08:00:00Z');
  const {repo,state} = fixture([{recordset:[{TokenHash:hash,UserId:'one',SecurityStamp:'stamp',ExpiresAt:new Date(now.getTime()+10000)}]}]);
  assert.deepEqual(await repo.validPresenceSessions([{tokenHash:hash}],now),[{tokenHash:hash,userId:'one',securityStamp:'stamp',expiresAt:new Date(now.getTime()+10000)}]);
  const call = state.calls[0];
  assert.equal(call.inputs.presence0,hash);
  assert.equal(call.inputs.presenceNow,now);
  assert.equal(call.query.includes(hash),false);
  assert.match(call.query,/JOIN pcn\.Users/);
  assert.match(call.query,/IsActive=1/);
  assert.match(call.query,/RevokedAt IS NULL/);
  assert.match(call.query,/ExpiresAt>@presenceNow/);
  assert.match(call.query,/s\.SecurityStamp=u\.SecurityStamp/);
  assert.deepEqual(await repo.validPresenceSessions([],now),[]);
  assert.equal(state.calls.length,1);
  await assert.rejects(repo.validPresenceSessions([{tokenHash:'hostile input'}],now),/presence/i);
});

test('role changes invalidate old session stamp and roll back missing user', async () => {
  const user={Id:'user',IdentityProvider:'employee-code',IsActive:true,DepartmentKey:'qaTet',AccessVersion:Buffer.from('0011223344556677','hex')};
  const hydrated={recordsets:[[user],[{Name:'qa'}]]};
  const first = fixture([hydrated, {},hydrated, { rowsAffected: [1] },{}, {rowsAffected:[1]}, {},{}, {}, {},hydrated]);
  await first.repo.setUserRoles('user', ['qa', 'qa']);
  assert.equal(first.state.committed, true);
  const update=first.state.calls.find(call=>/UPDATE pcn.Users SET DepartmentKey/.test(call.query));
  assert.ok(update.inputs.stamp);
  assert.equal(update.inputs.signingStep,null);
  assert.ok(first.state.calls.some(call=>/UPDATE pcn.Sessions/.test(call.query)));
  const missing = fixture([{recordsets:[[],[]]}]);
  await assert.rejects(missing.repo.setUserRoles('missing', ['supplier']), error => error.statusCode === 404);
  await assert.rejects(first.repo.setUserRoles('user', ['invalid']), error => error.statusCode === 400);
});

test('deactivating a user routes through versioned edit and revokes sessions atomically',async()=>{
  const user={Id:'user',IdentityProvider:'employee-code',IsActive:true,DepartmentKey:'qaTet',AccessVersion:Buffer.from('0011223344556677','hex')};
  const hydrated={recordsets:[[user],[{Name:'qa'}]]};
  const {repo,state}=fixture([hydrated,{},hydrated,{rowsAffected:[1]},{},{rowsAffected:[1]},{},{},{},{},hydrated]);
  await repo.deactivateUser('user');
  const update=state.calls.find(call=>/UPDATE pcn.Users SET DepartmentKey/.test(call.query));
  assert.equal(update.inputs.active,false);assert.equal(state.committed,true);
  assert.ok(state.calls.some(call=>/UPDATE pcn.Sessions/.test(call.query)));
});

for (const change of [ { IsActive:false }, { SecurityStamp:'revoked' }, { AccessVersion:Buffer.from('8899aabbccddeeff','hex') } ]) {
  test(`maintenance user creation rejects a stale actor before INSERT (${Object.keys(change)[0]})`,async()=>{
    const principal={id:'12345678-1234-1234-1234-123456789012',version:'0011223344556677',roles:['admin']};
    Object.defineProperty(principal,'sessionSecurityStamp',{value:'stamp'});
    const current={IsActive:true,SecurityStamp:'stamp',AccessVersion:Buffer.from(principal.version,'hex'),...change};
    const {repo,state}=fixture([{recordset:[{LockResult:0}]},{recordset:[current]}]);
    await assert.rejects(repo.createUser({username:'new-developer',email:null,passwordHash:'fixture-hash',roles:['developer'],department:'developer',signingStep:null,mustChangePassword:true},'user:administrator',principal),error=>error.statusCode===401);
    assert.equal(state.rolledBack,true);
    assert.equal(state.calls.some(call=>/INSERT pcn\.(?:Users|UserRoles)/.test(call.query)),false);
  });
}

test('maintenance user creation holds the shared assignment lock and reauthorizes the original principal before writing',async()=>{
  const principal={id:'12345678-1234-1234-1234-123456789012',version:'0011223344556677',roles:['admin']};
  Object.defineProperty(principal,'sessionSecurityStamp',{value:'stamp'});
  const {repo,state}=fixture([{recordset:[{LockResult:0}]},{recordset:[{IsActive:true,SecurityStamp:'stamp',AccessVersion:Buffer.from(principal.version,'hex')}]},{},{},{recordsets:[[{Id:'new-user',Username:'new-developer',DepartmentKey:'developer'}],[{Name:'developer'}]]}]);
  await repo.createUser({username:'new-developer',email:null,passwordHash:'fixture-hash',roles:['developer'],department:'developer',signingStep:null,mustChangePassword:true},'user:administrator',principal);
  assert.match(state.calls[0].query,/sp_getapplock/);
  assert.equal(state.calls[0].inputs.mode,'Shared');
  assert.match(state.calls[1].query,/SELECT IsActive,SecurityStamp,AccessVersion/);
  assert.equal(state.calls[1].inputs.id,principal.id);
  assert.match(state.calls[2].query,/INSERT pcn.Users/);
  assert.equal(state.committed,true);
});

test('identity linking rechecks current Developer grant under the assignment lock before transferring an account',async()=>{
  const {repo,state}=fixture([{recordset:[{LockResult:0}]},{recordset:[{Id:'target',IdentityProvider:'password',EmployeeCode:null,IsActive:true,HasDeveloperRole:1}]}]);
  await assert.rejects(repo.linkEmployeeIdentity('target',{employeeCode:'7654321',displayName:'Chosen Employee',isActive:true}),error=>error.statusCode===409&&/Remove Developer access/.test(error.message));
  assert.equal(state.rolledBack,true);
  assert.equal(state.committed,false);
  assert.match(state.calls[0].query,/sp_getapplock/);
  assert.equal(state.calls[0].inputs.mode,'Exclusive');
  assert.match(state.calls[1].query,/pcn.UserRoles/);
  assert.equal(state.calls.some(call=>/UPDATE pcn\.(?:Users|Sessions)|INSERT pcn\./.test(call.query)),false);
});
