const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

async function loadRuntimeEnv() {
  if (fs.existsSync(path.resolve('.env'))) process.loadEnvFile('.env');
  if (process.env.SQL_PASSWORD || process.platform !== 'win32') return;
  const file = process.env.PCN_SQL_CREDENTIAL_PATH || path.join(process.env.LOCALAPPDATA || '', 'SupplierPCN','sql-credential.xml');
  if (!path.isAbsolute(file) || !fs.existsSync(file)) return;
  const { stdout } = await run('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'..','scripts','read-sql-credential.ps1'),'-CredentialPath',file],{windowsHide:true,timeout:10000,maxBuffer:16384});
  const credential = JSON.parse(stdout);
  process.env.SQL_USER ||= credential.username;
  process.env.SQL_PASSWORD = credential.password;
  if (credential.trustServerCertificate) process.env.SQL_TRUST_SERVER_CERTIFICATE ||= 'true';
}
module.exports = { loadRuntimeEnv };
