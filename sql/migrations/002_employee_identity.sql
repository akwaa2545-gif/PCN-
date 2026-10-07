SET XACT_ABORT ON;
-- Existing accounts retain their IDs, ownership, credentials and role grants.
-- AD identities are assigned only by an explicit verified employee account operation.
IF COL_LENGTH(N'pcn.Users', N'EmployeeCode') IS NULL
ALTER TABLE pcn.Users ADD EmployeeCode nvarchar(100) NULL;
IF COL_LENGTH(N'pcn.Users', N'NormalizedEmployeeCode') IS NULL
ALTER TABLE pcn.Users ADD NormalizedEmployeeCode nvarchar(100) NULL;
IF COL_LENGTH(N'pcn.Users', N'DepartmentKey') IS NULL
ALTER TABLE pcn.Users ADD DepartmentKey nvarchar(80) NULL;
IF COL_LENGTH(N'pcn.Users', N'AdObjectGuid') IS NULL
ALTER TABLE pcn.Users ADD AdObjectGuid uniqueidentifier NULL;
IF COL_LENGTH(N'pcn.Users', N'AdSid') IS NULL
ALTER TABLE pcn.Users ADD AdSid nvarchar(184) NULL;
IF COL_LENGTH(N'pcn.Users', N'DisplayName') IS NULL
ALTER TABLE pcn.Users ADD DisplayName nvarchar(200) NULL;
ALTER TABLE pcn.Users ALTER COLUMN PasswordHash nvarchar(512) NULL;
-- Dynamic DDL compiles only after the new columns exist, including on SQL Server 2014.
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'pcn.Users') AND name=N'UX_Users_EmployeeCode')
EXEC(N'CREATE UNIQUE INDEX UX_Users_EmployeeCode ON pcn.Users(NormalizedEmployeeCode) WHERE NormalizedEmployeeCode IS NOT NULL');
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'pcn.Users') AND name=N'UX_Users_AdObjectGuid')
EXEC(N'CREATE UNIQUE INDEX UX_Users_AdObjectGuid ON pcn.Users(AdObjectGuid) WHERE AdObjectGuid IS NOT NULL');
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'pcn.Users') AND name=N'UX_Users_AdSid')
EXEC(N'CREATE UNIQUE INDEX UX_Users_AdSid ON pcn.Users(AdSid) WHERE AdSid IS NOT NULL');
