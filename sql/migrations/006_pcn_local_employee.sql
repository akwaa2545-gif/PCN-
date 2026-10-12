SET XACT_ABORT ON;
-- Preserve existing users, ownership, grants and provider-neutral identity indexes.
ALTER TABLE pcn.Users DROP CONSTRAINT CK_Users_IdentityProvider;
ALTER TABLE pcn.Users DROP CONSTRAINT CK_Users_EmployeeCodeAuthentication;
ALTER TABLE pcn.Users DROP CONSTRAINT CK_Users_VerifiedSigningMail;

ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_IdentityProvider
  CHECK (IdentityProvider IN (N'password',N'employee-code',N'retired-windows',N'pcn-local'));
ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_EmployeeCodeAuthentication
  CHECK (IdentityProvider NOT IN (N'employee-code',N'pcn-local') OR
    (EmployeeCode IS NOT NULL AND NormalizedEmployeeCode IS NOT NULL
      AND PasswordHash IS NULL AND AdObjectGuid IS NULL AND AdSid IS NULL));
ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_LocalEmployeeIdentity
  CHECK (IdentityProvider<>N'pcn-local' OR
    (LEN(EmployeeCode)=7 AND DATALENGTH(EmployeeCode)=14
      AND EmployeeCode COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^0-9]%'
      AND NormalizedEmployeeCode=EmployeeCode AND Username=EmployeeCode AND NormalizedUsername=EmployeeCode
      AND DisplayName IS NOT NULL AND LEN(LTRIM(RTRIM(DisplayName))) BETWEEN 1 AND 200));
ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_VerifiedSigningMail
  CHECK (SigningStep IS NULL OR (IdentityProvider IN (N'employee-code',N'pcn-local') AND Email IS NOT NULL
    AND MailDirectoryId IS NOT NULL AND MailVerifiedAt IS NOT NULL AND MailProfileJson IS NOT NULL));
