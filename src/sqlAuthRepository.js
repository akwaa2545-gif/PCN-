const sql = require('mssql');
const crypto = require('node:crypto');
const { ApiError } = require('./apiError');
const { normalizeEmployeeCode, validateEmployeeAccount, validateEmployeeIdentity, validateVerifiedMail } = require('./employeeAccounts');
const {lockUserMailRouting,readUserMailAssignments,applyUserMailRouting,assertCurrentUser}=require('./userMailRouting');
const {normalizeMailRouting}=require('./mailRouting');
function mapProfile(row) {
  if(!row.MailDirectoryId||!row.MailVerifiedAt||!row.MailProfileJson)return null;
  try {
    const profile=JSON.parse(row.MailProfileJson);
    validateVerifiedMail({email:row.Email,mailDirectoryId:row.MailDirectoryId,mailVerifiedAt:row.MailVerifiedAt,mailProfile:profile});
    return {id:profile.id,email:profile.email,displayName:profile.displayName||profile.email,jobTitle:profile.jobTitle||'',department:profile.department||'',photo:profile.photo||''};
  }catch{return null;}
}
function versionOf(row){return Buffer.isBuffer(row.AccessVersion)?row.AccessVersion.toString('hex'):null;}

function mapUser(row, roles) {
  if (!row) return null;
  return { id: row.Id, username: row.Username, employeeCode: row.EmployeeCode || null, normalizedEmployeeCode: row.NormalizedEmployeeCode || null, department: row.DepartmentKey || null,
    displayName: row.DisplayName || null, identityProvider: row.IdentityProvider || 'password',
    signingStep:row.SigningStep || null,mailDirectoryId:row.MailDirectoryId||null,mailVerifiedAt:row.MailVerifiedAt||null,mailProfile:mapProfile(row),version:versionOf(row),
    email: row.Email, passwordHash: row.PasswordHash, isActive: row.IsActive, mustChangePassword: row.MustChangePassword,
    securityStamp: row.SecurityStamp, failedLoginCount: row.FailedLoginCount, lockoutUntil: row.LockoutUntil, roles };
}

class SqlAuthRepository {
  constructor(pool) { this.pool = pool; }

  async userQuery(request, where) {
    const result = await request.query(`SELECT u.* FROM pcn.Users u WHERE ${where}; SELECT r.Name FROM pcn.Roles r JOIN pcn.UserRoles ur ON ur.RoleId=r.Id JOIN pcn.Users u ON u.Id=ur.UserId WHERE ${where};`);
    return mapUser(result.recordsets[0][0], result.recordsets[1].map(row => row.Name));
  }

  async getUserByLogin(login) {
    return this.userQuery(this.pool.request().input('login', sql.NVarChar(320), login), '(u.NormalizedUsername=@login OR u.NormalizedEmail=@login)');
  }

  async getUserById(id) {
    return this.userQuery(this.pool.request().input('id', sql.UniqueIdentifier, id), 'u.Id=@id');
  }

  async getUserByEmployeeCode(employeeCode) {
    const code = normalizeEmployeeCode(employeeCode).toLowerCase();
    return this.userQuery(this.pool.request().input('employeeCode', sql.NVarChar(100), code), "u.NormalizedEmployeeCode=@employeeCode AND u.IdentityProvider='employee-code'");
  }

  async auditAccount(transaction,id,action,actor,account) {
    const metadata={userId:id,...(account.employeeCode?{employeeCode:account.employeeCode}:{}),
      ...(account.roles?{roles:[...account.roles],department:account.department,signingStep:account.signingStep??null,isActive:account.isActive??true}:{}),
      mailSelected:Boolean(account.mailDirectoryId)};
    await transaction.request().input('auditId',sql.NVarChar(128),crypto.randomUUID()).input('code',sql.NVarChar(128),`ACCOUNT:${id}`)
      .input('action',sql.NVarChar(80),action).input('actor',sql.NVarChar(256),actor).input('metadata',sql.NVarChar(sql.MAX),JSON.stringify(metadata))
      .query('INSERT pcn.AuditLogs(Id,PcnCode,Action,Actor,MetadataJson,CreatedAt) VALUES(@auditId,@code,@action,@actor,@metadata,SYSUTCDATETIME())');
  }

  async validateRoutingCapacity(transaction) {
    const result=await transaction.request().query('SELECT SettingsJson FROM pcn.NotificationSettings WHERE Id=1');
    let settings;
    try{settings=result.recordset[0]?JSON.parse(result.recordset[0].SettingsJson):{};}catch{throw new ApiError(503,'Mail routing is unavailable');}
    normalizeMailRouting(applyUserMailRouting(settings,await readUserMailAssignments(transaction)));
  }

  async updateEmployeeAccount(id,account,actor='administrator',user) {
    validateEmployeeAccount({...account,employeeCode:'valid',department:account.department??'other'});
    validateVerifiedMail(account);
    if(typeof account.isActive!=='boolean'||typeof account.version!=='string'||!/^[a-fA-F0-9]{16}$/.test(account.version))throw new ApiError(400,'The current account version is required');
    const transaction=this.pool.transaction();await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      await lockUserMailRouting(transaction,'Exclusive');
      await assertCurrentUser(transaction,user);
      const prior=await this.userQuery(transaction.request().input('id',sql.UniqueIdentifier,id),'u.Id=@id');
      if(!prior)throw new ApiError(404,'User not found');
      if(prior.version!==account.version.toLowerCase())throw new ApiError(409,'Account changed. Reload and try again');
      if(account.signingStep!=null&&prior.identityProvider!=='employee-code')throw new ApiError(400,'Link an employee before assigning a signing step');
      if(prior.isActive&&prior.identityProvider==='employee-code'&&prior.roles.includes('admin')&&(!account.isActive||!account.roles.includes('admin'))){
        const admins=await transaction.request().query("SELECT COUNT(DISTINCT u.Id) AS Total FROM pcn.Users u WITH (UPDLOCK,HOLDLOCK) JOIN pcn.UserRoles ur ON ur.UserId=u.Id JOIN pcn.Roles r ON r.Id=ur.RoleId WHERE u.IsActive=1 AND u.IdentityProvider='employee-code' AND r.Name='admin'");
        if((admins.recordset[0]?.Total||0)<=1)throw new ApiError(409,'Keep at least one active employee Administrator');
      }
      const update=await transaction.request().input('id',sql.UniqueIdentifier,id).input('version',sql.Binary(8),Buffer.from(account.version,'hex'))
        .input('department',sql.NVarChar(80),account.department).input('signingStep',sql.NVarChar(16),account.signingStep??null)
        .input('email',sql.NVarChar(320),account.email??null).input('normalizedEmail',sql.NVarChar(320),account.email?.toLowerCase()||null)
        .input('mailId',sql.NVarChar(200),account.mailDirectoryId??null).input('mailVerifiedAt',sql.DateTime2,account.mailVerifiedAt?new Date(account.mailVerifiedAt):null)
        .input('mailProfile',sql.NVarChar(sql.MAX),account.mailProfile?JSON.stringify(account.mailProfile):null).input('active',sql.Bit,account.isActive)
        .input('stamp',sql.UniqueIdentifier,crypto.randomUUID())
        .query('UPDATE pcn.Users SET DepartmentKey=@department,SigningStep=@signingStep,Email=@email,NormalizedEmail=@normalizedEmail,MailDirectoryId=@mailId,MailVerifiedAt=@mailVerifiedAt,MailProfileJson=@mailProfile,IsActive=@active,SecurityStamp=@stamp,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id AND AccessVersion=@version');
      if(update.rowsAffected[0]!==1)throw new ApiError(409,'Account changed. Reload and try again');
      await transaction.request().input('id',sql.UniqueIdentifier,id).query('DELETE FROM pcn.UserRoles WHERE UserId=@id');
      for(const role of new Set(account.roles)){
        const inserted=await transaction.request().input('id',sql.UniqueIdentifier,id).input('role',sql.NVarChar(40),role)
          .query('INSERT pcn.UserRoles(UserId,RoleId) SELECT @id,Id FROM pcn.Roles WHERE Name=@role');
        if(inserted.rowsAffected[0]!==1)throw new ApiError(400,'Invalid user role');
      }
      await transaction.request().input('id',sql.UniqueIdentifier,id).query('UPDATE pcn.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@id AND RevokedAt IS NULL; UPDATE pcn.AccountTokens SET UsedAt=SYSUTCDATETIME() WHERE UserId=@id AND UsedAt IS NULL;');
      await this.validateRoutingCapacity(transaction);
      await this.auditAccount(transaction,id,'account-assignments-updated',actor,account);
      await transaction.commit();
    }catch(error){
      try{await transaction.rollback();}catch{/* Preserve original error after SQL automatic rollback. */}
      if([2601,2627].includes(error.number))throw new ApiError(409,'Selected email already belongs to another PCN user');
      throw error;
    }
    return this.getUserById(id);
  }

  async createEmployeeUser(account,actor='administrator',user) {
    validateEmployeeAccount(account);
    validateVerifiedMail(account);
    const employeeCode = normalizeEmployeeCode(account.employeeCode);
    const { department, displayName = null, email = null, roles } = account;
    const transaction = this.pool.transaction();
    await transaction.begin();
    const id = crypto.randomUUID();
    try {
      await lockUserMailRouting(transaction,'Exclusive');
      await assertCurrentUser(transaction,user);
      await transaction.request().input('id', sql.UniqueIdentifier, id)
        .input('username', sql.NVarChar(100), employeeCode).input('normalizedUsername', sql.NVarChar(100), employeeCode.toLowerCase())
        .input('employeeCode', sql.NVarChar(100), employeeCode).input('normalizedEmployeeCode', sql.NVarChar(100), employeeCode.toLowerCase())
        .input('department', sql.NVarChar(80), department).input('displayName', sql.NVarChar(200), displayName)
        .input('email', sql.NVarChar(320), email).input('normalizedEmail', sql.NVarChar(320), email?.toLowerCase() || null)
        .input('signingStep',sql.NVarChar(16),account.signingStep??null).input('mailId',sql.NVarChar(200),account.mailDirectoryId??null)
        .input('mailVerifiedAt',sql.DateTime2,account.mailVerifiedAt?new Date(account.mailVerifiedAt):null).input('mailProfile',sql.NVarChar(sql.MAX),account.mailProfile?JSON.stringify(account.mailProfile):null)
        .input('stamp', sql.UniqueIdentifier, crypto.randomUUID())
        .query("INSERT pcn.Users (Id,Username,NormalizedUsername,EmployeeCode,NormalizedEmployeeCode,DepartmentKey,IdentityProvider,DisplayName,Email,NormalizedEmail,SigningStep,MailDirectoryId,MailVerifiedAt,MailProfileJson,PasswordHash,IsActive,MustChangePassword,SecurityStamp,FailedLoginCount,CreatedAt,UpdatedAt) VALUES (@id,@username,@normalizedUsername,@employeeCode,@normalizedEmployeeCode,@department,'employee-code',@displayName,@email,@normalizedEmail,@signingStep,@mailId,@mailVerifiedAt,@mailProfile,NULL,1,0,@stamp,0,SYSUTCDATETIME(),SYSUTCDATETIME())");
      for (const role of new Set(roles)) {
        const result = await transaction.request().input('id', sql.UniqueIdentifier, id).input('role', sql.NVarChar(40), role)
          .query('INSERT pcn.UserRoles (UserId,RoleId) SELECT @id,Id FROM pcn.Roles WHERE Name=@role');
        if (result.rowsAffected[0] !== 1) throw new ApiError(400, 'Invalid user role');
      }
      await this.validateRoutingCapacity(transaction);
      await this.auditAccount(transaction,id,'account-created',actor,account);
      await transaction.commit();
    } catch (error) {
      try { await transaction.rollback(); } catch { /* Preserve original SQL error after automatic rollback. */ }
      if ([2601, 2627].includes(error.number)) throw new ApiError(409, 'Employee or account already exists. Existing accounts must be linked explicitly');
      throw error;
    }
    return this.getUserById(id);
  }

  async linkEmployeeIdentity(id, profile,actor='administrator',caller) {
    validateEmployeeIdentity(profile);
    const employeeCode = normalizeEmployeeCode(profile.employeeCode);
    const transaction = this.pool.transaction();
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      await lockUserMailRouting(transaction,'Exclusive');
      await assertCurrentUser(transaction,caller);
      const existing = await transaction.request().input('id', sql.UniqueIdentifier, id)
        .query('SELECT Id,IdentityProvider,EmployeeCode,IsActive FROM pcn.Users WITH (UPDLOCK,HOLDLOCK) WHERE Id=@id');
      const user = existing.recordset[0];
      if (!user) throw new ApiError(404, 'User not found');
      if (!user.IsActive) throw new ApiError(400, 'Only active users can be linked to an employee');
      if (user.IdentityProvider === 'employee-code' && user.EmployeeCode?.toLowerCase() !== employeeCode.toLowerCase()) throw new ApiError(409, 'Account is already linked to another employee');
      await transaction.request().input('id', sql.UniqueIdentifier, id)
        .input('employeeCode', sql.NVarChar(100), employeeCode).input('normalizedEmployeeCode', sql.NVarChar(100), employeeCode.toLowerCase())
        .input('displayName', sql.NVarChar(200), profile.displayName ?? null).input('email', sql.NVarChar(320), profile.email ?? null)
        .input('normalizedEmail', sql.NVarChar(320), profile.email?.toLowerCase() || null).input('stamp', sql.UniqueIdentifier, crypto.randomUUID())
        .query("UPDATE pcn.Users SET Username=@employeeCode,NormalizedUsername=@normalizedEmployeeCode,EmployeeCode=@employeeCode,NormalizedEmployeeCode=@normalizedEmployeeCode,IdentityProvider='employee-code',AdObjectGuid=NULL,AdSid=NULL,PasswordHash=NULL,DisplayName=@displayName,Email=CASE WHEN MailVerifiedAt IS NOT NULL THEN Email ELSE @email END,NormalizedEmail=CASE WHEN MailVerifiedAt IS NOT NULL THEN NormalizedEmail ELSE @normalizedEmail END,SecurityStamp=@stamp,MustChangePassword=0,FailedLoginCount=0,LockoutUntil=NULL,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id");
      await transaction.request().input('id', sql.UniqueIdentifier, id)
        .query('UPDATE pcn.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@id AND RevokedAt IS NULL; UPDATE pcn.AccountTokens SET UsedAt=SYSUTCDATETIME() WHERE UserId=@id AND UsedAt IS NULL;');
      await this.validateRoutingCapacity(transaction);
      await this.auditAccount(transaction,id,'employee-linked',actor,{employeeCode});
      await transaction.commit();
    } catch (error) {
      try { await transaction.rollback(); } catch { /* Preserve original SQL error after automatic rollback. */ }
      if ([2601, 2627].includes(error.number)) throw new ApiError(409, 'Employee or account already exists. Existing accounts must be linked explicitly');
      throw error;
    }
    return this.getUserById(id);
  }

  async createUser({ username, email, passwordHash, roles, mustChangePassword }) {
    const transaction = this.pool.transaction();
    await transaction.begin();
    const id = crypto.randomUUID();
    try {
      await transaction.request().input('id', sql.UniqueIdentifier, id)
        .input('username', sql.NVarChar(100), username).input('normalizedUsername', sql.NVarChar(100), username.toLowerCase())
        .input('email', sql.NVarChar(320), email).input('normalizedEmail', sql.NVarChar(320), email?.toLowerCase() || null)
        .input('hash', sql.NVarChar(512), passwordHash).input('change', sql.Bit, mustChangePassword)
        .input('stamp', sql.UniqueIdentifier, crypto.randomUUID())
        .query('INSERT pcn.Users (Id,Username,NormalizedUsername,Email,NormalizedEmail,PasswordHash,IsActive,MustChangePassword,SecurityStamp,FailedLoginCount,CreatedAt,UpdatedAt) VALUES (@id,@username,@normalizedUsername,@email,@normalizedEmail,@hash,1,@change,@stamp,0,SYSUTCDATETIME(),SYSUTCDATETIME())');
      for (const role of roles) {
        const result = await transaction.request().input('id', sql.UniqueIdentifier, id).input('role', sql.NVarChar(40), role)
          .query('INSERT pcn.UserRoles (UserId,RoleId) SELECT @id,Id FROM pcn.Roles WHERE Name=@role');
        if (result.rowsAffected[0] !== 1) throw new ApiError(400, 'Invalid user role');
      }
      await transaction.commit();
    } catch (error) {
      try { await transaction.rollback(); } catch { /* Preserve the original SQL error if SQL Server already aborted the transaction. */ }
      if ([2601, 2627].includes(error.number)) throw new ApiError(409, 'Username or email already exists');
      throw error;
    }
    return this.getUserById(id);
  }

  async saveSession(session) {
    await this.pool.request().input('id', sql.UniqueIdentifier, session.id).input('userId', sql.UniqueIdentifier, session.userId)
      .input('hash', sql.Char(64), session.tokenHash).input('csrf', sql.Char(64), session.csrfToken)
      .input('stamp', sql.UniqueIdentifier, session.securityStamp).input('created', sql.DateTime2, new Date(session.createdAt))
      .input('expires', sql.DateTime2, new Date(session.expiresAt))
      .query('INSERT pcn.Sessions (Id,UserId,TokenHash,CsrfToken,SecurityStamp,CreatedAt,ExpiresAt) VALUES (@id,@userId,@hash,@csrf,@stamp,@created,@expires)');
  }

  async getSession(hash) {
    const result = await this.pool.request().input('hash', sql.Char(64), hash).query('SELECT * FROM pcn.Sessions WHERE TokenHash=@hash AND RevokedAt IS NULL');
    const row = result.recordset[0];
    return row ? { id: row.Id, userId: row.UserId, tokenHash: row.TokenHash, csrfToken: row.CsrfToken, securityStamp: row.SecurityStamp, expiresAt: row.ExpiresAt, revokedAt: row.RevokedAt } : null;
  }

  async revokeSession(hash) {
    await this.pool.request().input('hash', sql.Char(64), hash).query('UPDATE pcn.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE TokenHash=@hash AND RevokedAt IS NULL');
  }

  async recordLoginFailure(id, now) {
    await this.pool.request().input('id', sql.UniqueIdentifier, id).input('now', sql.DateTime2, now)
      .query('UPDATE pcn.Users SET FailedLoginCount=CASE WHEN LockoutUntil <= @now THEN 1 ELSE FailedLoginCount+1 END, LockoutUntil=CASE WHEN LockoutUntil <= @now THEN NULL WHEN FailedLoginCount+1 >= 5 THEN DATEADD(minute,15,@now) ELSE LockoutUntil END, UpdatedAt=@now WHERE Id=@id');
  }

  async resetLoginFailures(id) {
    await this.pool.request().input('id', sql.UniqueIdentifier, id).query('UPDATE pcn.Users SET FailedLoginCount=0,LockoutUntil=NULL WHERE Id=@id');
  }

  async updatePassword(id, passwordHash, securityStamp, expectedStamp) {
    const transaction = this.pool.transaction();
    await transaction.begin();
    try {
      const result = await transaction.request().input('id', sql.UniqueIdentifier, id).input('hash', sql.NVarChar(512), passwordHash)
        .input('stamp', sql.UniqueIdentifier, securityStamp).input('expected', sql.UniqueIdentifier, expectedStamp)
        .query('UPDATE pcn.Users SET PasswordHash=@hash,SecurityStamp=@stamp,MustChangePassword=0,FailedLoginCount=0,LockoutUntil=NULL,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id AND SecurityStamp=@expected');
      if (result.rowsAffected[0] !== 1) throw new ApiError(409, 'Account changed. Sign in again');
      await transaction.request().input('id', sql.UniqueIdentifier, id).query('UPDATE pcn.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@id AND RevokedAt IS NULL; UPDATE pcn.AccountTokens SET UsedAt=SYSUTCDATETIME() WHERE UserId=@id AND UsedAt IS NULL;');
      await transaction.commit();
    } catch (error) { try { await transaction.rollback(); } catch { /* Preserve the original SQL error after automatic rollback. */ } throw error; }
  }

  async listUsers() {
    const result = await this.pool.request().query('SELECT u.Id,u.Username,u.EmployeeCode,u.DepartmentKey,u.DisplayName,u.IdentityProvider,u.SigningStep,u.MailDirectoryId,u.MailVerifiedAt,u.MailProfileJson,u.AccessVersion,u.Email,u.IsActive,u.MustChangePassword,r.Name AS Role FROM pcn.Users u LEFT JOIN pcn.UserRoles ur ON ur.UserId=u.Id LEFT JOIN pcn.Roles r ON r.Id=ur.RoleId ORDER BY u.Username');
    const grouped = new Map();
    for (const row of result.recordset) {
      const prior = grouped.get(row.Id);
      grouped.set(row.Id, prior ? { ...prior, roles: [...prior.roles, ...(row.Role ? [row.Role] : [])] } : { id: row.Id, username: row.Username,
        employeeCode: row.EmployeeCode || null, department: row.DepartmentKey || null, displayName: row.DisplayName || null,
        identityProvider: row.IdentityProvider || 'password',
        signingStep:row.SigningStep||null,mailProfile:mapProfile(row),version:versionOf(row),
        email: row.Email, isActive: row.IsActive, mustChangePassword: row.MustChangePassword, roles: row.Role ? [row.Role] : [] });
    }
    return [...grouped.values()];
  }

  async deactivateUser(id) {
    const prior=await this.getUserById(id);
    if(!prior)throw new ApiError(404,'User not found');
    return this.updateEmployeeAccount(id,{...prior,isActive:false});
  }

  async setUserRoles(id, roles) {
    if (!Array.isArray(roles) || !roles.length || roles.some(role => !['admin', 'reviewer', 'supplier', 'gsc', 'productionengineering', 'qa', 'tapbu'].includes(role))) throw new ApiError(400, 'Invalid user roles');
    const prior=await this.getUserById(id);
    if(!prior)throw new ApiError(404,'User not found');
    return this.updateEmployeeAccount(id,{...prior,roles:[...new Set(roles)],signingStep:null});
  }
}

module.exports = { SqlAuthRepository };
