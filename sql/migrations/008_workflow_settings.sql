SET XACT_ABORT ON;
-- The singleton keeps SQL 2014-compatible JSON separate from PCNs and mail routing.
IF OBJECT_ID(N'pcn.WorkflowSettings', N'U') IS NULL
CREATE TABLE pcn.WorkflowSettings (
 Id int NOT NULL CONSTRAINT PK_WorkflowSettings PRIMARY KEY CONSTRAINT CK_WorkflowSettings_Singleton CHECK (Id=1),
 SettingsJson nvarchar(max) NOT NULL,
 Version bigint NOT NULL CONSTRAINT CK_WorkflowSettings_Version CHECK (Version>=0),
 UpdatedAt datetime2(3) NULL,
 UpdatedBy nvarchar(256) NULL
);
IF NOT EXISTS(SELECT 1 FROM pcn.WorkflowSettings WITH (UPDLOCK,HOLDLOCK) WHERE Id=1)
INSERT pcn.WorkflowSettings(Id,SettingsJson,Version,UpdatedAt,UpdatedBy)
VALUES(1,N'{"schemaVersion":1,"pendingDays":{"gscTet":null,"prodEngTet":3,"qaTet":3,"gscTapbu":null,"qaTapbu":null,"qaFinal":null}}',0,NULL,NULL);
