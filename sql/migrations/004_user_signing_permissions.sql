-- Existing accounts receive no signing grant. Assign one step explicitly in Users.
ALTER TABLE pcn.Users ADD SigningStep nvarchar(16) NULL;
ALTER TABLE pcn.Users ADD MailDirectoryId nvarchar(200) NULL;
ALTER TABLE pcn.Users ADD MailVerifiedAt datetime2(3) NULL;
ALTER TABLE pcn.Users ADD MailProfileJson nvarchar(max) NULL;
ALTER TABLE pcn.Users ADD AccessVersion rowversion NOT NULL;
-- Defer binding of newly added columns for SQL Server 2014.
EXEC(N'ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_SigningStep
  CHECK (SigningStep IS NULL OR SigningStep IN (N''approved'',N''checked'',N''prepared''));');
EXEC(N'ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_SigningDepartment
  CHECK (SigningStep IS NULL OR (DepartmentKey IS NOT NULL AND DepartmentKey IN
    (N''gscTet'',N''prodEngTet'',N''qaTet'',N''gscTapbu'',N''qaTapbu'')));');
EXEC(N'ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_VerifiedSigningMail
  CHECK (SigningStep IS NULL OR (IdentityProvider=N''employee-code'' AND Email IS NOT NULL
    AND MailDirectoryId IS NOT NULL AND MailVerifiedAt IS NOT NULL AND MailProfileJson IS NOT NULL));');
