SET XACT_ABORT ON;
-- SQL Server 2014 stores JSON as Unicode text. The application serializes and parses
-- every JSON payload; direct SQL writes must use valid JSON as well.
IF OBJECT_ID(N'pcn.Users', N'U') IS NULL
CREATE TABLE pcn.Users (
 Id uniqueidentifier NOT NULL CONSTRAINT PK_Users PRIMARY KEY,
 Username nvarchar(100) NOT NULL, NormalizedUsername nvarchar(100) NOT NULL CONSTRAINT UQ_Users_Username UNIQUE,
 Email nvarchar(320) NULL, NormalizedEmail nvarchar(320) NULL, PasswordHash nvarchar(512) NOT NULL,
 IsActive bit NOT NULL DEFAULT 1, MustChangePassword bit NOT NULL DEFAULT 1,
 SecurityStamp uniqueidentifier NOT NULL DEFAULT NEWID(), FailedLoginCount int NOT NULL DEFAULT 0,
 LockoutUntil datetime2(3) NULL, CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), UpdatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'pcn.Users') AND name=N'UX_Users_Email')
CREATE UNIQUE INDEX UX_Users_Email ON pcn.Users(NormalizedEmail) WHERE NormalizedEmail IS NOT NULL;
IF OBJECT_ID(N'pcn.Roles', N'U') IS NULL
CREATE TABLE pcn.Roles (Id int IDENTITY PRIMARY KEY, Name nvarchar(40) NOT NULL UNIQUE);
IF OBJECT_ID(N'pcn.UserRoles', N'U') IS NULL
CREATE TABLE pcn.UserRoles (UserId uniqueidentifier NOT NULL REFERENCES pcn.Users(Id), RoleId int NOT NULL REFERENCES pcn.Roles(Id), PRIMARY KEY(UserId,RoleId));
IF OBJECT_ID(N'pcn.Sessions', N'U') IS NULL
CREATE TABLE pcn.Sessions (
 Id uniqueidentifier NOT NULL PRIMARY KEY, UserId uniqueidentifier NOT NULL REFERENCES pcn.Users(Id),
 TokenHash char(64) NOT NULL UNIQUE, CsrfToken char(64) NOT NULL, SecurityStamp uniqueidentifier NOT NULL,
 ExpiresAt datetime2(3) NOT NULL, CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), RevokedAt datetime2(3) NULL
);
IF OBJECT_ID(N'pcn.AccountTokens', N'U') IS NULL
CREATE TABLE pcn.AccountTokens (
 Id uniqueidentifier NOT NULL PRIMARY KEY, UserId uniqueidentifier NOT NULL REFERENCES pcn.Users(Id),
 TokenHash char(64) NOT NULL UNIQUE, Purpose nvarchar(40) NOT NULL, SecurityStamp uniqueidentifier NOT NULL,
 TargetEmail nvarchar(320) NULL, ExpiresAt datetime2(3) NOT NULL, CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), UsedAt datetime2(3) NULL
);
IF NOT EXISTS(SELECT 1 FROM pcn.Roles WHERE Name=N'admin') INSERT pcn.Roles(Name) VALUES(N'admin');
IF NOT EXISTS(SELECT 1 FROM pcn.Roles WHERE Name=N'reviewer') INSERT pcn.Roles(Name) VALUES(N'reviewer');
IF NOT EXISTS(SELECT 1 FROM pcn.Roles WHERE Name=N'supplier') INSERT pcn.Roles(Name) VALUES(N'supplier');
IF NOT EXISTS(SELECT 1 FROM pcn.Roles WHERE Name=N'gsc') INSERT pcn.Roles(Name) VALUES(N'gsc');
IF NOT EXISTS(SELECT 1 FROM pcn.Roles WHERE Name=N'productionengineering') INSERT pcn.Roles(Name) VALUES(N'productionengineering');
IF NOT EXISTS(SELECT 1 FROM pcn.Roles WHERE Name=N'qa') INSERT pcn.Roles(Name) VALUES(N'qa');
IF NOT EXISTS(SELECT 1 FROM pcn.Roles WHERE Name=N'tapbu') INSERT pcn.Roles(Name) VALUES(N'tapbu');

IF OBJECT_ID(N'pcn.MasterDataVersions', N'U') IS NULL
CREATE TABLE pcn.MasterDataVersions (
 Id int IDENTITY PRIMARY KEY, DefinitionHash char(64) NOT NULL UNIQUE,
 DefinitionJson nvarchar(max) NOT NULL, IsActive bit NOT NULL DEFAULT 0,
 CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'pcn.MasterDataVersions') AND name=N'UX_MasterData_Active')
CREATE UNIQUE INDEX UX_MasterData_Active ON pcn.MasterDataVersions(IsActive) WHERE IsActive=1;
IF OBJECT_ID(N'pcn.PcnCounters', N'U') IS NULL
CREATE TABLE pcn.PcnCounters (Year int NOT NULL PRIMARY KEY, LastSequence int NOT NULL CHECK(LastSequence>=0));
IF OBJECT_ID(N'pcn.PcnRequests', N'U') IS NULL
CREATE TABLE pcn.PcnRequests (
 PcnId bigint IDENTITY NOT NULL PRIMARY KEY, PcnCode nvarchar(32) NOT NULL UNIQUE,
 OwnerUserId uniqueidentifier NULL REFERENCES pcn.Users(Id), MasterDataVersionId int NULL REFERENCES pcn.MasterDataVersions(Id),
 Status nvarchar(40) NULL, ChangeForm nvarchar(40) NULL, RiskLevel nvarchar(10) NULL,
 SelectedChange nvarchar(max) NULL, SupplierName nvarchar(max) NULL, ManufacturerName nvarchar(max) NULL,
 MaterialName nvarchar(max) NULL, DesiredStartText nvarchar(max) NULL, SampleSubmitted nvarchar(20) NULL,
 CurrentCondition nvarchar(max) NULL, NewCondition nvarchar(max) NULL, Reason nvarchar(max) NULL,
 Identification nvarchar(max) NULL, SampleLocation nvarchar(max) NULL, PriceLevel nvarchar(20) NULL,
 SourceTemplate nvarchar(max) NULL, ChangeType nvarchar(max) NULL,
 CreatedAt datetime2(3) NULL, UpdatedAt datetime2(3) NULL, SubmittedAt datetime2(3) NULL,
 LegacyExtrasJson nvarchar(max) NOT NULL,
 PresentFieldsJson nvarchar(max) NOT NULL,
 DeletedAt datetime2(3) NULL, DeletedBy nvarchar(256) NULL, RowVersion rowversion NOT NULL
);
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'pcn.PcnRequests') AND name=N'IX_PcnRequests_List')
CREATE INDEX IX_PcnRequests_List ON pcn.PcnRequests(OwnerUserId,Status,UpdatedAt DESC) WHERE DeletedAt IS NULL;
IF OBJECT_ID(N'pcn.PcnInternalReviews', N'U') IS NULL
CREATE TABLE pcn.PcnInternalReviews (PcnId bigint NOT NULL PRIMARY KEY REFERENCES pcn.PcnRequests(PcnId), ReviewJson nvarchar(max) NOT NULL);
IF OBJECT_ID(N'pcn.PcnChangeRows', N'U') IS NULL
CREATE TABLE pcn.PcnChangeRows (
 PcnId bigint NOT NULL REFERENCES pcn.PcnRequests(PcnId), SortOrder int NOT NULL,
 Risk nvarchar(10) NULL, OptionText nvarchar(max) NULL, Text nvarchar(max) NULL,
 CurrentCondition nvarchar(max) NULL, NewCondition nvarchar(max) NULL,
 PayloadJson nvarchar(max) NOT NULL, PRIMARY KEY(PcnId,SortOrder)
);
IF OBJECT_ID(N'pcn.PcnDocuments', N'U') IS NULL
CREATE TABLE pcn.PcnDocuments (
 PcnId bigint NOT NULL REFERENCES pcn.PcnRequests(PcnId), SortOrder int NOT NULL, Name nvarchar(max) NULL,
 Required bit NULL, Uploaded bit NULL, PayloadJson nvarchar(max) NOT NULL, PRIMARY KEY(PcnId,SortOrder)
);
IF OBJECT_ID(N'pcn.PcnRouteSteps', N'U') IS NULL
CREATE TABLE pcn.PcnRouteSteps (PcnId bigint NOT NULL REFERENCES pcn.PcnRequests(PcnId), SortOrder int NOT NULL, OwnerSnapshot nvarchar(max) NULL, PayloadJson nvarchar(max) NOT NULL, PRIMARY KEY(PcnId,SortOrder));
IF OBJECT_ID(N'pcn.PcnComments', N'U') IS NULL
CREATE TABLE pcn.PcnComments (
 PcnId bigint NOT NULL REFERENCES pcn.PcnRequests(PcnId), SortOrder int NOT NULL, LegacyId nvarchar(128) NULL,
 Role nvarchar(80) NULL, Comment nvarchar(max) NULL, CreatedAt datetime2(3) NULL,
 PayloadJson nvarchar(max) NOT NULL, PRIMARY KEY(PcnId,SortOrder)
);
IF OBJECT_ID(N'pcn.PcnApprovals', N'U') IS NULL
CREATE TABLE pcn.PcnApprovals (
 PcnId bigint NOT NULL REFERENCES pcn.PcnRequests(PcnId), SortOrder int NOT NULL, LegacyId nvarchar(128) NULL,
 Role nvarchar(80) NULL, Decision nvarchar(40) NULL, Comment nvarchar(max) NULL, CreatedAt datetime2(3) NULL,
 PayloadJson nvarchar(max) NOT NULL, PRIMARY KEY(PcnId,SortOrder)
);
IF OBJECT_ID(N'pcn.AuditLogs', N'U') IS NULL
CREATE TABLE pcn.AuditLogs (
 Id nvarchar(128) NOT NULL PRIMARY KEY, PcnCode nvarchar(128) NOT NULL, Action nvarchar(80) NOT NULL,
 Actor nvarchar(256) NOT NULL, MetadataJson nvarchar(max) NOT NULL,
 CreatedAt datetime2(3) NOT NULL, SourceJson nvarchar(max) NULL
);
IF OBJECT_ID(N'pcn.NotificationSettings', N'U') IS NULL
CREATE TABLE pcn.NotificationSettings (Id int NOT NULL PRIMARY KEY CHECK(Id=1), SettingsJson nvarchar(max) NOT NULL, UpdatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME());
IF OBJECT_ID(N'pcn.NotificationGroups', N'U') IS NULL
CREATE TABLE pcn.NotificationGroups (GroupKey nvarchar(80) NOT NULL PRIMARY KEY, SortOrder int NOT NULL, Label nvarchar(120) NOT NULL, Emails nvarchar(1000) NOT NULL);
IF OBJECT_ID(N'pcn.NotificationRecipients', N'U') IS NULL
CREATE TABLE pcn.NotificationRecipients (GroupKey nvarchar(80) NOT NULL REFERENCES pcn.NotificationGroups(GroupKey), SortOrder int NOT NULL, Email nvarchar(320) NOT NULL, ProfileJson nvarchar(max) NOT NULL, PRIMARY KEY(GroupKey,SortOrder));
IF OBJECT_ID(N'pcn.MigrationSourceRecords', N'U') IS NULL
CREATE TABLE pcn.MigrationSourceRecords (SourceKey nvarchar(256) NOT NULL PRIMARY KEY, SourceHash char(64) NOT NULL, SourceJson nvarchar(max) NOT NULL, ImportedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME());
IF OBJECT_ID(N'pcn.NotificationJobs', N'U') IS NULL
CREATE TABLE pcn.NotificationJobs (
 Id uniqueidentifier NOT NULL PRIMARY KEY, EventKey nvarchar(200) NOT NULL UNIQUE, PcnId nvarchar(32) NOT NULL,
 PcnVersion nvarchar(16) NOT NULL, CompletedGroup nvarchar(50) NOT NULL, Action nvarchar(30) NOT NULL,
 Recipient nvarchar(1000) NOT NULL, PayloadJson nvarchar(max) NOT NULL,
 Status nvarchar(20) NOT NULL DEFAULT N'pending', Attempts int NOT NULL DEFAULT 0,
 CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), ClaimedAt datetime2(3) NULL, LeaseExpiresAt datetime2(3) NULL,
 ClaimToken uniqueidentifier NULL, SentAt datetime2(3) NULL, LastError nvarchar(1000) NULL
);
IF OBJECT_ID(N'pcn.PcnDocumentFiles', N'U') IS NULL
CREATE TABLE pcn.PcnDocumentFiles (
 Id uniqueidentifier NOT NULL PRIMARY KEY, PcnCode nvarchar(32) NOT NULL REFERENCES pcn.PcnRequests(PcnCode),
 FileName nvarchar(255) NOT NULL, ContentType nvarchar(100) NOT NULL, Bytes varbinary(max) NOT NULL,
 SizeBytes int NOT NULL CHECK(SizeBytes>=0), ScanStatus nvarchar(20) NOT NULL,
 CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
