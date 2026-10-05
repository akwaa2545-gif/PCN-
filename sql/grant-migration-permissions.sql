-- Run as an authorized database administrator. No server login/password is changed.
USE [Scn_DB];
IF DATABASE_PRINCIPAL_ID(N'scndb') IS NULL
  CREATE USER [scndb] FOR LOGIN [scndb];
IF SCHEMA_ID(N'pcn') IS NULL
  EXEC(N'CREATE SCHEMA [pcn] AUTHORIZATION [dbo]');
GRANT CREATE TABLE TO [scndb];
GRANT ALTER, REFERENCES, VIEW DEFINITION ON SCHEMA::[pcn] TO [scndb];
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::[pcn] TO [scndb];
-- After migration succeeds, DBA may remove schema administration from the runtime login:
-- REVOKE CREATE TABLE FROM [scndb];
-- REVOKE ALTER, REFERENCES ON SCHEMA::[pcn] FROM [scndb];
