const sql = require('mssql');
const crypto = require('node:crypto');
const { ApiError } = require('./apiError');

function mapUser(row, roles) {
  if (!row) return null;
  return { id: row.Id, username: row.Username, email: row.Email, passwordHash: row.PasswordHash, isActive: row.IsActive, mustChangePassword: row.MustChangePassword, securityStamp: row.SecurityStamp, failedLoginCount: row.FailedLoginCount, lockoutUntil: row.LockoutUntil, roles };
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
    const result = await this.pool.request().query('SELECT u.Id,u.Username,u.Email,u.IsActive,u.MustChangePassword,r.Name AS Role FROM pcn.Users u LEFT JOIN pcn.UserRoles ur ON ur.UserId=u.Id LEFT JOIN pcn.Roles r ON r.Id=ur.RoleId ORDER BY u.Username');
    const grouped = new Map();
    for (const row of result.recordset) {
      const prior = grouped.get(row.Id);
      grouped.set(row.Id, prior ? { ...prior, roles: [...prior.roles, ...(row.Role ? [row.Role] : [])] } : { id: row.Id, username: row.Username, email: row.Email, isActive: row.IsActive, mustChangePassword: row.MustChangePassword, roles: row.Role ? [row.Role] : [] });
    }
    return [...grouped.values()];
  }

  async deactivateUser(id) {
    await this.pool.request().input('id', sql.UniqueIdentifier, id).input('stamp', sql.UniqueIdentifier, crypto.randomUUID())
      .query('UPDATE pcn.Users SET IsActive=0,SecurityStamp=@stamp,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id');
  }

  async setUserRoles(id, roles) {
    if (!Array.isArray(roles) || !roles.length || roles.some(role => !['admin', 'reviewer', 'supplier', 'gsc', 'productionengineering', 'qa', 'tapbu'].includes(role))) throw new ApiError(400, 'Invalid user roles');
    const transaction = this.pool.transaction();
    await transaction.begin();
    try {
      const result = await transaction.request().input('id', sql.UniqueIdentifier, id).input('stamp', sql.UniqueIdentifier, crypto.randomUUID())
        .query('UPDATE pcn.Users SET SecurityStamp=@stamp,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id; DELETE FROM pcn.UserRoles WHERE UserId=@id;');
      if (result.rowsAffected[0] !== 1) throw new ApiError(404, 'User not found');
      for (const role of new Set(roles)) {
        const inserted = await transaction.request().input('id', sql.UniqueIdentifier, id).input('role', sql.NVarChar(40), role)
          .query('INSERT pcn.UserRoles (UserId,RoleId) SELECT @id,Id FROM pcn.Roles WHERE Name=@role');
        if (inserted.rowsAffected[0] !== 1) throw new ApiError(400, 'Invalid user role');
      }
      await transaction.commit();
    } catch (error) { try { await transaction.rollback(); } catch { /* Preserve the original SQL error after automatic rollback. */ } throw error; }
  }
}

module.exports = { SqlAuthRepository };
