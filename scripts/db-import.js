const fs = require('node:fs/promises');
const path = require('node:path');
const { connectSql } = require('../src/sqlDatabase');
const { SqlPcnRepository } = require('../src/sqlPcnRepository');
const { loadRuntimeEnv } = require('../src/runtimeEnv');
async function main() {
  await loadRuntimeEnv();
  const source = process.argv[2];
  if (!source) throw new Error('An explicit source JSON file is required');
  const exported = JSON.parse(await fs.readFile(path.resolve(source),'utf8'));
  // Routing is configured explicitly after cutover; never restore legacy mail recipients or URLs.
  const { notificationSettings: ignoredRouting, ...db } = exported;
  const pool = await connectSql();
  try {
    const result = await new SqlPcnRepository(pool).importDatabase(db,{source:path.basename(source)});
    console.log(JSON.stringify({import:'ok',...result,emailRouting:'not_imported'}));
  } finally { await pool.close(); }
}
main().catch(error=>{console.error(JSON.stringify({import:'failed',code:error.code || 'UNKNOWN',message:error.name==='ApiError' ? error.message : 'Data import failed; source remains unchanged'}));process.exitCode=1;});
