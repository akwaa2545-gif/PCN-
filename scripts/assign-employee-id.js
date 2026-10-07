const { connectSql } = require('../src/sqlDatabase');
const { loadRuntimeEnv } = require('../src/runtimeEnv');
const { SqlAuthRepository } = require('../src/sqlAuthRepository');
const readline = require('node:readline/promises');

async function main() {
  const [username] = process.argv.slice(2);
  if (!/^[a-zA-Z0-9._-]{3,100}$/.test(username || '')) {
    throw new Error('Usage: npm run user:assign-id -- <username>');
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  let employeeId;
  try {
    employeeId = (await prompt.question('Employee ID (7 digits): ')).trim();
  } finally {
    prompt.close();
  }
  if (!/^[0-9]{7}$/.test(employeeId)) {
    throw new Error('Employee ID must contain exactly 7 digits');
  }
  await loadRuntimeEnv();
  const pool = await connectSql();
  try {
    const user = await new SqlAuthRepository(pool).assignEmployeeId(username, employeeId);
    console.log(JSON.stringify({ username: user.username, employeeIdAssigned: true, roles: user.roles }));
  } finally {
    await pool.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
