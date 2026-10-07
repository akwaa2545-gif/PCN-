const { connectSql, applyMigrations } = require('../src/sqlDatabase');
const { loadRuntimeEnv } = require('../src/runtimeEnv');
const { SqlPcnRepository, emptySettings } = require('../src/sqlPcnRepository');
const { AuthService } = require('../src/authService');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');
const { formDefinitions,commonDocuments,workflowBase,statusDefinitions,adminItems } = require('../src/masterData');
async function main() {
  await loadRuntimeEnv();
  const pool = await connectSql();
  try {
    await applyMigrations(pool);
    const repository = new SqlPcnRepository(pool);
    const routing = await pool.request().query('SELECT Id FROM pcn.NotificationSettings WHERE Id=1');
    if (!routing.recordset.length) await repository.saveNotificationSettings(emptySettings, 'migration');
    const version = await repository.seedMasterData({formDefinitions,commonDocuments,workflowBase,statusDefinitions,adminItems});
    const authRepository = new SqlAuthRepository(pool);
    let bootstrap = 'not_requested';
    const bootstrapEmployeeId = process.env.PCN_BOOTSTRAP_EMPLOYEE_ID || null;
    const bootstrapUsername = process.env.PCN_BOOTSTRAP_USERNAME || bootstrapEmployeeId;
    if (bootstrapUsername && (bootstrapEmployeeId || process.env.PCN_BOOTSTRAP_PASSWORD)) {
      const exists = await authRepository.getUserByLogin(bootstrapUsername.toLowerCase());
      if (exists) bootstrap = 'already_exists';
      else {
        await new AuthService(authRepository).createUser({username:bootstrapUsername,employeeId:bootstrapEmployeeId,email:process.env.PCN_BOOTSTRAP_EMAIL || null,password:process.env.PCN_BOOTSTRAP_PASSWORD,roles:['admin'],mustChangePassword:!bootstrapEmployeeId,bootstrap:true});
        bootstrap = bootstrapEmployeeId ? 'created_employee_id' : 'created_force_password_change';
      }
    }
    await repository.readiness();
    console.log(JSON.stringify({migration:'ok',masterDataVersion:version,bootstrap,emailRouting:'unchanged_or_empty_defaults'}));
  } finally { await pool.close(); }
}
main().catch(error=>{console.error(JSON.stringify({migration:'failed',code:error.code || 'UNKNOWN',message:'Database migration failed; inspect schema permissions and configuration'}));process.exitCode=1;});
