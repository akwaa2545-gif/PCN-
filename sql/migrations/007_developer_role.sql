SET XACT_ABORT ON;
-- Seed the role only. Account grants remain an explicit administrator action.
IF NOT EXISTS (SELECT 1 FROM pcn.Roles WHERE Name=N'developer')
  INSERT pcn.Roles(Name) VALUES(N'developer');
