SET XACT_ABORT ON;
IF OBJECT_ID(N'pcn.PcnRevisions', N'U') IS NULL
CREATE TABLE pcn.PcnRevisions (
 PcnCode nvarchar(32) NOT NULL REFERENCES pcn.PcnRequests(PcnCode),
 Revision int NOT NULL CHECK(Revision>0), ContentRevision int NOT NULL CHECK(ContentRevision>0),
 Actor nvarchar(256) NOT NULL, CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 Status nvarchar(40) NOT NULL, ChangesJson nvarchar(max) NOT NULL,
 SnapshotJson nvarchar(max) NOT NULL, IsBaseline bit NOT NULL DEFAULT 0,
 CONSTRAINT PK_PcnRevisions PRIMARY KEY(PcnCode,Revision)
);
IF COL_LENGTH(N'pcn.PcnDocumentFiles',N'RequirementName') IS NULL ALTER TABLE pcn.PcnDocumentFiles ADD RequirementName nvarchar(max) NULL;
IF COL_LENGTH(N'pcn.PcnDocumentFiles',N'UploadedBy') IS NULL ALTER TABLE pcn.PcnDocumentFiles ADD UploadedBy nvarchar(256) NULL;
IF COL_LENGTH(N'pcn.PcnDocumentFiles',N'UploadedAt') IS NULL ALTER TABLE pcn.PcnDocumentFiles ADD UploadedAt datetime2(3) NULL CONSTRAINT DF_PcnDocumentFiles_UploadedAt DEFAULT SYSUTCDATETIME();
IF COL_LENGTH(N'pcn.PcnDocumentFiles',N'ContentRevision') IS NULL ALTER TABLE pcn.PcnDocumentFiles ADD ContentRevision int NOT NULL CONSTRAINT DF_PcnDocumentFiles_ContentRevision DEFAULT 1;
IF COL_LENGTH(N'pcn.PcnDocumentFiles',N'DeletedAt') IS NULL ALTER TABLE pcn.PcnDocumentFiles ADD DeletedAt datetime2(3) NULL;
