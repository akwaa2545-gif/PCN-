SET XACT_ABORT ON;
-- Stage employee password enrollment without changing accounts, grants or sessions.
IF COL_LENGTH(N'pcn.Users', N'PasswordSetAt') IS NULL
ALTER TABLE pcn.Users ADD PasswordSetAt datetime2(3) NULL;
IF COL_LENGTH(N'pcn.Sessions', N'AuthenticationMethod') IS NULL
ALTER TABLE pcn.Sessions ADD AuthenticationMethod nvarchar(30) NULL;

IF OBJECT_ID(N'pcn.CK_Users_EmployeeCodeAuthentication', N'C') IS NOT NULL
ALTER TABLE pcn.Users DROP CONSTRAINT CK_Users_EmployeeCodeAuthentication;
-- Defer binding of the newly added columns on SQL Server 2014.
EXEC(N'ALTER TABLE pcn.Users WITH CHECK ADD CONSTRAINT CK_Users_EmployeeCodeAuthentication
  CHECK (IdentityProvider NOT IN (N''employee-code'',N''pcn-local'') OR
    (EmployeeCode IS NOT NULL AND NormalizedEmployeeCode IS NOT NULL
      AND AdObjectGuid IS NULL AND AdSid IS NULL
      AND ((PasswordHash IS NULL AND PasswordSetAt IS NULL)
        OR (PasswordHash IS NOT NULL AND PasswordSetAt IS NOT NULL))));');

IF OBJECT_ID(N'pcn.CK_Sessions_AuthenticationMethod', N'C') IS NULL
EXEC(N'ALTER TABLE pcn.Sessions WITH CHECK ADD CONSTRAINT CK_Sessions_AuthenticationMethod
  CHECK (AuthenticationMethod IS NULL OR AuthenticationMethod IN
    (N''password'',N''employee-code'',N''employee-password'',N''password-setup''));');
