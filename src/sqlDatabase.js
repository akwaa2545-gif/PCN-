const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sql = require('mssql');
const { getSqlConfig } = require('./sqlConfig');

const migrationManifest = ['001_core.sql', '002_employee_identity.sql', '003_employee_code_auth.sql', '004_user_signing_permissions.sql', '005_document_control.sql'];
const migrationLock = "DECLARE @result int; EXEC @result = sys.sp_getapplock @Resource=N'pcn:schema-migrations', @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=15000; IF @result < 0 THROW 51000, 'Could not acquire migration lock', 1;";
async function connectSql(env = process.env) { return new sql.ConnectionPool(getSqlConfig(env)).connect(); }

async function applyMigrations(pool) {
  // Migration administration is deliberately explicit; ordinary server startup never creates tables.
  const bootstrap = pool.transaction();
  await bootstrap.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    await bootstrap.request().query(migrationLock);
    await bootstrap.request().query("IF SCHEMA_ID(N'pcn') IS NULL EXEC(N'CREATE SCHEMA [pcn]'); IF OBJECT_ID(N'pcn.SchemaMigrations', N'U') IS NULL CREATE TABLE pcn.SchemaMigrations (MigrationId nvarchar(120) NOT NULL PRIMARY KEY, Checksum char(64) NOT NULL, AppliedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME());");
    await bootstrap.commit();
  } catch (error) { try { await bootstrap.rollback(); } catch { /* XACT_ABORT may already have rolled back; preserve the SQL error. */ } throw error; }
  for (const name of migrationManifest) {
    const content = await fs.readFile(path.join(__dirname, '..', 'sql', 'migrations', name), 'utf8');
    const checksum = crypto.createHash('sha256').update(content).digest('hex');
    const tx = pool.transaction();
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      await tx.request().query(migrationLock);
      const existing = await tx.request().input('id', sql.NVarChar(120), name).query('SELECT Checksum FROM pcn.SchemaMigrations WHERE MigrationId=@id');
      if (existing.recordset.length) {
        if (existing.recordset[0].Checksum !== checksum) throw new Error(`Migration checksum changed: ${name}`);
      } else {
        await tx.request().query(content);
        await tx.request().input('id', sql.NVarChar(120), name).input('checksum', sql.Char(64), checksum)
          .query('INSERT pcn.SchemaMigrations(MigrationId,Checksum) VALUES(@id,@checksum)');
      }
      await tx.commit();
    } catch (error) { try { await tx.rollback(); } catch { /* Preserve the original error after automatic SQL rollback. */ } throw error; }
  }
}

module.exports = { connectSql, applyMigrations, migrationManifest };
