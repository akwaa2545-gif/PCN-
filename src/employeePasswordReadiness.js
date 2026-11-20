const sql = require('mssql');
const { ApiError } = require('./apiError');

const migration = '010_employee_password_auth.sql';
// Runtime archives omit migration SQL; tests bind this value to the reviewed source file.
const migrationChecksum = 'eb4c9a16e37257c3157927a1c9959ccde113011b2ee830f4189f329793fba677';

async function assertEmployeePasswordReadiness(pool) {
  const result = await pool.request().input('migration',sql.NVarChar(120),migration).query(`
    SELECT Checksum FROM pcn.SchemaMigrations WHERE MigrationId=@migration;
    SELECT OBJECT_NAME(c.object_id) AS TableName,c.name AS ColumnName,t.name AS TypeName,
      c.scale AS Scale,c.max_length AS MaxLength,c.is_nullable AS Nullable
      FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id
      WHERE (c.object_id=OBJECT_ID(N'pcn.Users') AND c.name=N'PasswordSetAt')
        OR (c.object_id=OBJECT_ID(N'pcn.Sessions') AND c.name=N'AuthenticationMethod');
    SELECT name,definition,is_disabled,is_not_trusted FROM sys.check_constraints
      WHERE (parent_object_id=OBJECT_ID(N'pcn.Users') AND name=N'CK_Users_EmployeeCodeAuthentication')
        OR (parent_object_id=OBJECT_ID(N'pcn.Sessions') AND name=N'CK_Sessions_AuthenticationMethod');`);
  const columns=result.recordsets[1] || [],constraints=result.recordsets[2] || [];
  const enrollment=columns.find(row=>row.TableName==='Users' && row.ColumnName==='PasswordSetAt');
  const method=columns.find(row=>row.TableName==='Sessions' && row.ColumnName==='AuthenticationMethod');
  const guard=constraints.find(row=>row.name==='CK_Users_EmployeeCodeAuthentication');
  const methods=constraints.find(row=>row.name==='CK_Sessions_AuthenticationMethod');
  const contains=(constraint,tokens)=>constraint && !constraint.is_disabled && !constraint.is_not_trusted
    && tokens.every(token=>String(constraint.definition).toLowerCase().includes(token.toLowerCase()));
  const valid=result.recordsets[0]?.[0]?.Checksum===migrationChecksum
    && enrollment?.TypeName==='datetime2' && enrollment.Scale===3 && enrollment.Nullable===true
    && method?.TypeName==='nvarchar' && method.MaxLength===60 && method.Nullable===true
    && contains(guard,['IdentityProvider','EmployeeCode','NormalizedEmployeeCode','AdObjectGuid','AdSid','PasswordHash','PasswordSetAt','employee-code','pcn-local'])
    && contains(methods,['AuthenticationMethod',"'password'","'employee-code'","'employee-password'","'password-setup'"]);
  if (!valid) throw new ApiError(503,'Employee password schema is not initialized; apply migration 010');
  return {ready:true,migration};
}

module.exports = { assertEmployeePasswordReadiness, migrationChecksum };
