const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');
const { migrationManifest } = require('../src/sqlDatabase');
const identity = Object.freeze({ employeeCode: '001Employe', department: 'qaTet', displayName: 'Employee Name', email: null, roles: ['qa'] });

function fixture(results = []) {
  const state = { calls: [], committed: false, rolledBack: false, began: false };
  function request() {
    let inputs = {};
    return {
      input(name, type, value) { inputs = { ...inputs, [name]: value }; return this; },
      async query(query) {
        const result = results[state.calls.length];
        state.calls = [...state.calls, { query, inputs }];
        if (result instanceof Error) throw result;
        return { rowsAffected: [1], recordset: [], ...result };
      }
    };
  }
  const pool = { request, transaction: () => ({ request, async begin() { state.began = true; },
    async commit() { state.committed = true; }, async rollback() { state.rolledBack = true; } }) };
  return { repo: new SqlAuthRepository(pool), state };
}

function hydrated() {
  return { recordsets: [[{ Id: 'account-id', Username: identity.employeeCode, EmployeeCode: identity.employeeCode,
    NormalizedEmployeeCode: identity.employeeCode.toLowerCase(), DepartmentKey: identity.department,
    DisplayName: identity.displayName, Email: null, IdentityProvider: 'employee-code', IsActive: true,
    PasswordHash: null, SecurityStamp: 'stamp' }], [{ Name: 'qa' }]] };
}

test('migration004 adds nullable scalar assignments and rowversion without granting historical users',()=>{
  assert.equal(migrationManifest.includes('004_user_signing_permissions.sql'),true);
  const migration=fs.readFileSync(path.join(__dirname,'..','sql','migrations','004_user_signing_permissions.sql'),'utf8');
  for(const column of ['SigningStep','MailDirectoryId','MailVerifiedAt','MailProfileJson','AccessVersion'])assert.match(migration,new RegExp('ADD '+column));
  assert.match(migration,/AccessVersion rowversion/);
  assert.match(migration,/EXEC\(N'ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_SigningStep/);
  assert.doesNotMatch(migration,/UPDATE pcn.Users|JSON_VALUE|ISJSON/);
});

test('account assignment update uses routing lock, version guard, revocation and audit in one transaction',async()=>{
  const row={Id:'account-id',IdentityProvider:'employee-code',IsActive:true,DepartmentKey:'qaTet',SigningStep:null,AccessVersion:Buffer.from('0011223344556677','hex')};
  const {repo,state}=fixture([{},{recordsets:[[row],[{Name:'qa'}]]},{rowsAffected:[1]},{},{rowsAffected:[1]},{},{},{},{},hydrated()]);
  const result=await repo.updateEmployeeAccount('account-id',{roles:['qa'],department:'qaTet',signingStep:'checked',isActive:true,version:'0011223344556677',email:'person@example.com',mailDirectoryId:'directory-1',mailVerifiedAt:new Date(),mailProfile:{id:'directory-1',email:'person@example.com'}},'user:admin');
  assert.equal(state.calls[0].inputs.resource,'pcn:user-mail-routing');
  assert.equal(state.calls[0].inputs.mode,'Exclusive');
  const update=state.calls.find(call=>/SigningStep=@signingStep/.test(call.query));
  assert.match(update.query,/AccessVersion=@version/);
  assert.equal(update.inputs.signingStep,'checked');
  assert.ok(Buffer.isBuffer(update.inputs.version));
  assert.ok(state.calls.some(call=>/UPDATE pcn.Sessions/.test(call.query)&&/AccountTokens/.test(call.query)));
  const audit=state.calls.find(call=>/INSERT pcn.AuditLogs/.test(call.query));
  assert.equal(audit.inputs.actor,'user:admin');
  assert.doesNotMatch(audit.inputs.metadata,/mailVerifiedAt|stamp|token|password/i);
  assert.equal(state.committed,true);
  assert.equal(result.id,'account-id');
});

test('stale account edit rolls back before grants and last active administrator cannot be disabled or demoted',async()=>{
  const row={Id:'account-id',IdentityProvider:'employee-code',IsActive:true,AccessVersion:Buffer.from('0011223344556677','hex')};
  const input={roles:['qa'],department:'qaTet',signingStep:null,isActive:true,version:'8899aabbccddeeff',email:null};
  const stale=fixture([{},{recordsets:[[row],[{Name:'qa'}]]}]);
  await assert.rejects(stale.repo.updateEmployeeAccount('account-id',input),{statusCode:409});
  assert.equal(stale.state.rolledBack,true);
  assert.equal(stale.state.calls.length,2);
  for(const change of [{roles:['qa']},{isActive:false}]){
    const last=fixture([{},{recordsets:[[row],[{Name:'admin'}]]},{recordset:[{Total:1}]}]);
    await assert.rejects(last.repo.updateEmployeeAccount('account-id',{...input,version:'0011223344556677',roles:['admin'],...change}),{statusCode:409});
    assert.equal(last.state.rolledBack,true);
    assert.equal(last.state.calls.some(call=>/UPDATE pcn.Users/.test(call.query)),false);
  }
});

test('an assignment exceeding effective recipient capacity rolls back all account writes',async()=>{
  const row={Id:'account-id',IdentityProvider:'employee-code',IsActive:true,AccessVersion:Buffer.from('0011223344556677','hex')};
  const settings={schemaVersion:2,groups:[{key:'department.qaTet.checked',emails:Array.from({length:30},(_,i)=>`u${i}@example.com`).join('; ')}]};
  const profile={id:'directory-1',email:'person@example.com'};
  const assigned={Id:'account-id',IdentityProvider:'employee-code',IsActive:true,DepartmentKey:'qaTet',SigningStep:'checked',Email:profile.email,MailDirectoryId:profile.id,MailVerifiedAt:new Date(),MailProfileJson:JSON.stringify(profile),RoleName:'qa'};
  const {repo,state}=fixture([{},{recordsets:[[row],[{Name:'qa'}]]},{rowsAffected:[1]},{},{rowsAffected:[1]},{},{recordset:[{SettingsJson:JSON.stringify(settings)}]},{recordset:[assigned]}]);
  await assert.rejects(repo.updateEmployeeAccount('account-id',{roles:['qa'],department:'qaTet',signingStep:'checked',isActive:true,version:'0011223344556677',email:profile.email,mailDirectoryId:profile.id,mailVerifiedAt:assigned.MailVerifiedAt,mailProfile:profile}),{statusCode:400});
  assert.equal(state.rolledBack,true);assert.equal(state.committed,false);
});

test('a revoked administrator cannot complete a delayed account change',async()=>{
  const {repo,state}=fixture([{},{recordset:[{IsActive:false,SecurityStamp:'changed',AccessVersion:Buffer.from('0011223344556677','hex')}] }]);
  await assert.rejects(repo.createEmployeeUser(identity,'user:administrator',{id:'administrator',version:'0011223344556677',sessionSecurityStamp:'prior'}),{statusCode:401});
  assert.equal(state.committed,false);
  assert.equal(state.calls.some(call=>/INSERT pcn.Users/.test(call.query)),false);
});

test('employee creation preserves leading zeros and transactionally stores explicit provider and assigned role', async () => {
  const { repo, state } = fixture([{}, { rowsAffected: [1] }, { rowsAffected: [1] }, {}, {}, {}, hydrated()]);
  const account = await repo.createEmployeeUser({ ...identity, roles: ['qa', 'qa'] });
  const insert = state.calls[1];
  assert.equal(insert.inputs.employeeCode, '001Employe');
  assert.equal(insert.inputs.normalizedEmployeeCode, '001employe');
  assert.equal(insert.inputs.username, '001Employe');
  assert.equal(insert.inputs.department, 'qaTet');
  assert.match(insert.query, /IdentityProvider/);
  assert.match(insert.query, /'employee-code'/);
  assert.equal(insert.inputs.adSid, undefined);
  assert.equal(insert.inputs.adObjectGuid, undefined);
  assert.equal(insert.inputs.hash, undefined);
  assert.equal(state.calls.length, 7);
  assert.equal(state.committed, true);
  assert.equal(account.identityProvider, 'employee-code');
  assert.equal(account.passwordHash, null);
});

test('collisions and invalid persisted grants roll back safely', async () => {
  for (const number of [2601, 2627]) {
    const { repo, state } = fixture([{},Object.assign(new Error('private SQL detail'), { number })]);
    await assert.rejects(repo.createEmployeeUser(identity), error => error.statusCode === 409 && !error.message.includes('private'));
    assert.equal(state.rolledBack, true);
    assert.equal(state.committed, false);
  }
  const failed = fixture([{}, { rowsAffected: [1] }, { rowsAffected: [0] }]);
  await assert.rejects(failed.repo.createEmployeeUser(identity), { statusCode: 400 });
  assert.equal(failed.state.rolledBack, true);
});

test('invalid source profile or assignments are rejected before SQL writes', async () => {
  const invalidProfiles = [{ employeeCode: 123 }, { employeeCode: '' }, { employeeCode: 'a'.repeat(11) },
    { employeeCode: 'user\\spoof' }, { roles: [] }, { roles: ['superadmin'] }, { email: 'invalid' },
    { department: 'unknown' }, { displayName: 42 }, { displayName: 'A'.repeat(201) },
    {email:'person@example.com',mailDirectoryId:'id',mailVerifiedAt:null,mailProfile:{id:'id',email:'person@example.com'}}];
  for (const invalid of invalidProfiles) {
    const { repo, state } = fixture();
    await assert.rejects(repo.createEmployeeUser({ ...identity, ...invalid }), { statusCode: 400 });
    assert.equal(state.began, false);
  }
});

test('employee code lookup uses normalized parameter and provider with no SQL interpolation', async () => {
  const { repo, state } = fixture([hydrated()]);
  const user = await repo.getUserByEmployeeCode('001EMPLOYE');
  assert.equal(state.calls[0].inputs.employeeCode, '001employe');
  assert.match(state.calls[0].query, /u\.NormalizedEmployeeCode=@employeeCode/);
  assert.match(state.calls[0].query, /u\.IdentityProvider='employee-code'/);
  assert.equal(state.calls[0].query.includes('001employe'), false);
  assert.equal(user.employeeCode, identity.employeeCode);
  await assert.rejects(repo.getUserByEmployeeCode("' OR 1=1 --"), { statusCode: 400 });
});

test('explicit linking preserves user ownership, assigned department and roles while removing credentials and old AD identity', async () => {
  const { repo, state } = fixture([{}, { recordset: [{ Id: 'old', IdentityProvider: 'retired-windows', EmployeeCode: 'old-sam', IsActive: true }] },
    { rowsAffected: [1] }, { rowsAffected: [2, 1] }, {}, {}, {}, hydrated()]);
  const user = await repo.linkEmployeeIdentity('old', identity);
  const update = state.calls[2];
  assert.equal(update.inputs.employeeCode, '001Employe');
  assert.match(update.query, /IdentityProvider='employee-code'/);
  assert.match(update.query, /AdObjectGuid=NULL,AdSid=NULL/);
  assert.match(update.query, /PasswordHash=NULL/);
  assert.match(update.query, /SecurityStamp=@stamp/);
  assert.doesNotMatch(update.query, /DepartmentKey=|UserRoles|PcnRequests/);
  assert.match(update.query,/Email=CASE WHEN MailVerifiedAt IS NOT NULL THEN Email/);
  assert.match(state.calls[3].query, /UPDATE pcn.Sessions SET RevokedAt/);
  assert.match(state.calls[3].query, /UPDATE pcn.AccountTokens SET UsedAt/);
  assert.equal(state.committed, true);
  assert.equal(user.identityProvider, 'employee-code');
});

test('linking rejects conflicting employee links and missing or disabled accounts with no partial mutation', async () => {
  const cases = [[[], 404], [[{ IdentityProvider: 'employee-code', EmployeeCode: 'other', IsActive: true }], 409],
    [[{ IdentityProvider: 'password', IsActive: false }], 400]];
  for (const [recordset, status] of cases) {
    const { repo, state } = fixture([{}, { recordset }]);
    await assert.rejects(repo.linkEmployeeIdentity('old', identity), { statusCode: status });
    assert.equal(state.rolledBack, true);
    assert.equal(state.calls.length, 2);
  }
  const collision = fixture([{}, { recordset: [{ IdentityProvider: 'password', IsActive: true }] },
    Object.assign(new Error('private constraint'), { number: 2601 })]);
  await assert.rejects(collision.repo.linkEmployeeIdentity('old', identity), error => error.statusCode === 409 && !error.message.includes('private'));
  assert.equal(collision.state.committed, false);
});

test('user lists expose explicit provider but no AD identifiers, credentials or session stamps', async () => {
  const { repo } = fixture([{ recordset: [{ Id: 'one', Username: '001234', EmployeeCode: '001234', IdentityProvider: 'employee-code',
    DepartmentKey: 'qaTet', DisplayName: 'Name', AdObjectGuid: 'private', AdSid: 'private', PasswordHash: 'private', Role: 'qa' },
    { Id: 'old', Username: 'legacy', EmployeeCode: null, IdentityProvider: 'password', Role: 'admin' }] }]);
  const users = await repo.listUsers();
  assert.equal(users[0].identityProvider, 'employee-code');
  for (const name of ['directoryId', 'adSid', 'passwordHash', 'securityStamp']) assert.equal(users[0][name], undefined);
  assert.equal(users[1].employeeCode, null);
  assert.equal(users[1].identityProvider, 'password');
});

test('migration003 explicitly retires old Windows mappings and revokes sessions without assigning source codes', () => {
  assert.equal(migrationManifest.includes('003_employee_code_auth.sql'), true);
  const migration = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '003_employee_code_auth.sql'), 'utf8');
  assert.match(migration, /ADD IdentityProvider/);
  assert.match(migration, /retired-windows/);
  assert.match(migration, /NEWID\(\)/);
  assert.match(migration, /UPDATE pcn.Sessions/);
  assert.match(migration, /UPDATE pcn.AccountTokens/);
  assert.doesNotMatch(migration, /SET[^;]*IdentityProvider='employee-code'/i);
  assert.doesNotMatch(migration, /\b(?:ISJSON|OPENJSON|JSON_VALUE)\s*\(/i);
});

test('migration003 defers statements using newly added provider column until SQL2014 compiles them after ALTER', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '003_employee_code_auth.sql'), 'utf8');
  const statements = ['UPDATE pcn.Users', 'UPDATE pcn.Sessions', 'UPDATE pcn.AccountTokens',
    'ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_IdentityProvider',
    'ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_EmployeeCodeAuthentication'];
  for (const statement of statements) assert.match(migration, new RegExp("EXEC\\(N'" + statement));
});
