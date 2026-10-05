const { connectSql } = require('../src/sqlDatabase');
const { loadRuntimeEnv } = require('../src/runtimeEnv');
async function main() {
  await loadRuntimeEnv();
  const pool = await connectSql();
  try {
    const result = await pool.request().query("SELECT DB_NAME() AS databaseName,CONVERT(varchar(30),SERVERPROPERTY('ProductVersion')) AS serverVersion,compatibility_level AS compatibilityLevel FROM sys.databases WHERE database_id=DB_ID(); SELECT name FROM sys.tables WHERE schema_id=SCHEMA_ID('pcn') ORDER BY name;");
    console.log(JSON.stringify({connection:'ok',...result.recordsets[0][0],applicationTables:result.recordsets[1].map(row=>row.name)}));
  } finally { await pool.close(); }
}
main().catch(error=>{console.error(JSON.stringify({connection:'failed',code:error.code || 'UNKNOWN',message:'SQL connection or database inspection failed'}));process.exitCode=1;});
