// Explicit integration verification. All test writes are rolled back, including sessions and counters.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sql = require('mssql');
const {loadRuntimeEnv} = require('../src/runtimeEnv');
const {connectSql} = require('../src/sqlDatabase');
const {SqlPcnRepository} = require('../src/sqlPcnRepository');
const {SqlAuthRepository} = require('../src/sqlAuthRepository');
const {AuthService} = require('../src/authService');
const {PcnService} = require('../src/pcnService');
const {SqlDocuments} = require('../src/sqlDocuments');
const {validPayload} = require('../test/helpers/apiHarness');

async function main() {
  await loadRuntimeEnv();
  const pool = await connectSql();
  try {
    const repository = new SqlPcnRepository(pool);
    await repository.readiness();
    const settings = await repository.getNotificationSettings();
    assert(settings.groups.every(group => !group.emails && !group.recipients.length));
    const admin = await new SqlAuthRepository(pool).getUserByLogin('itadmin');
    assert(admin?.mustChangePassword && admin.email === null);
    assert(admin.passwordHash.startsWith('$argon2id$'));
    const tx = pool.transaction();
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    // Every repository transaction shares this outer test transaction. Only the outer layer commits/rolls back.
    const scoped = {request:()=>tx.request(),transaction:()=>({begin:async()=>{},commit:async()=>{},rollback:async()=>{},request:()=>tx.request()})};
    try {
      const auth = new AuthService(new SqlAuthRepository(scoped), { authMode: 'password' });
      const login = await auth.login({username:'itadmin',password:process.env.PCN_SMOKE_BOOTSTRAP_PASSWORD});
      assert(login.user.mustChangePassword);
      const changedPassword = crypto.randomBytes(24).toString('hex');
      await auth.changePassword(login.token,{currentPassword:process.env.PCN_SMOKE_BOOTSTRAP_PASSWORD,newPassword:changedPassword});
      assert.equal(await auth.session(login.token),null);
      const fresh = await auth.login({username:'itadmin',password:changedPassword});
      assert.equal(fresh.user.mustChangePassword,false);
      const repo = new SqlPcnRepository(scoped);
      const service = new PcnService(repo);
      const created = await service.create({...validPayload,status:'draft',supplierName:'SQL verification ไทย',internalReview:{}},`user:${admin.id}`,fresh.user);
      assert.equal((await service.getById(created.id,fresh.user)).supplierName,'SQL verification ไทย');
      const updated = await service.update(created.id,{version:created.version,reason:'Round-trip verification',internalReview:{materialCodeDescription:'Workbook data ไทย'}},`user:${admin.id}`,fresh.user);
      assert.equal(updated.internalReview.materialCodeDescription,'Workbook data ไทย');
      await assert.rejects(service.update(created.id,{version:created.version,reason:'stale'},'test',fresh.user),{statusCode:409});
      const documents = new SqlDocuments(scoped);
      const document = await documents.save(created.id,{fileName:'verification.txt',contentType:'text/plain',base64:Buffer.from('verification').toString('base64')},{user:fresh.user,version:updated.version});
      await assert.rejects(documents.get(created.id,document.id),{statusCode:423});
      const deletedDocument = await documents.delete(created.id,document.id,{user:fresh.user,version:document.version});
      await service.remove(created.id,`user:${admin.id}`,deletedDocument.version);
      assert.equal(await repo.findById(created.id),null);
    } finally { await tx.rollback(); }
    console.log(JSON.stringify({liveSql:'passed',checks:['schema','empty-routing','hashed-bootstrap','password-change-and-session-revocation','pcn-and-workbook-round-trip','stale-write','document-quarantine-and-audit','soft-delete'],testWrites:'rolled_back'}));
  } finally { await pool.close(); }
}
main().catch(error=>{console.error(JSON.stringify({liveSql:'failed',code:error.code,number:error.number,message:error.name==='AssertionError' ? error.message : error.name==='ApiError' ? error.message : 'SQL verification failed'}));process.exitCode=1;});
