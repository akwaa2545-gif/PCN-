SET XACT_ABORT ON;

IF COL_LENGTH(N'pcn.Users', N'EmployeeId') IS NULL
  ALTER TABLE pcn.Users ADD EmployeeId nvarchar(7) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name=N'CK_Users_EmployeeId' AND parent_object_id=OBJECT_ID(N'pcn.Users'))
  ALTER TABLE pcn.Users ADD CONSTRAINT CK_Users_EmployeeId CHECK (EmployeeId IS NULL OR EmployeeId COLLATE Latin1_General_BIN2 LIKE N'[0-9][0-9][0-9][0-9][0-9][0-9][0-9]');

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'pcn.Users') AND name=N'UX_Users_EmployeeId')
  CREATE UNIQUE INDEX UX_Users_EmployeeId ON pcn.Users(EmployeeId) WHERE EmployeeId IS NOT NULL;
