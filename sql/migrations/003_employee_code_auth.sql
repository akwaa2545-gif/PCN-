-- Retain historical identity columns for auditing and rollback. Source employee codes
-- are assigned only by an administrator explicitly selecting KEY_Code_DB employees.
ALTER TABLE pcn.Users ADD IdentityProvider nvarchar(30) NOT NULL
  CONSTRAINT DF_Users_IdentityProvider DEFAULT N'password';
-- Dynamic batches defer column binding until after ALTER on SQL Server 2014.
EXEC(N'UPDATE pcn.Users SET IdentityProvider=N''retired-windows'',SecurityStamp=NEWID(),UpdatedAt=SYSUTCDATETIME()
  WHERE AdObjectGuid IS NOT NULL OR AdSid IS NOT NULL;');
EXEC(N'UPDATE pcn.Sessions SET RevokedAt=SYSUTCDATETIME()
  WHERE RevokedAt IS NULL AND UserId IN (SELECT Id FROM pcn.Users WHERE IdentityProvider=N''retired-windows'');');
EXEC(N'UPDATE pcn.AccountTokens SET UsedAt=SYSUTCDATETIME()
  WHERE UsedAt IS NULL AND UserId IN (SELECT Id FROM pcn.Users WHERE IdentityProvider=N''retired-windows'');');
EXEC(N'ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_IdentityProvider
  CHECK (IdentityProvider IN (N''password'',N''employee-code'',N''retired-windows''));');
EXEC(N'ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_EmployeeCodeAuthentication
  CHECK (IdentityProvider<>N''employee-code'' OR
    (EmployeeCode IS NOT NULL AND NormalizedEmployeeCode IS NOT NULL
      AND PasswordHash IS NULL AND AdObjectGuid IS NULL AND AdSid IS NULL));');
