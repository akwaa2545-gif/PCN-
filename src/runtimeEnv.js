const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function windowsPowerShellEnvironment(source = process.env) {
  // Windows PowerShell builds its Desktop module path; Core module paths inherited through Node are incompatible.
  return Object.fromEntries(Object.entries(source).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
}

async function loadRuntimeEnv() {
  const configuredPath = process.env.PCN_ENV_FILE;
  const explicitPath = configuredPath !== undefined;
  const filePath = explicitPath ? configuredPath : path.resolve('.env');
  if (explicitPath && (!path.isAbsolute(filePath) || (process.platform === 'win32' && path.parse(filePath).root.length === 1))) {
    throw new Error('PCN_ENV_FILE must be an absolute path with a drive letter or UNC share on Windows');
  }
  if (explicitPath && !fs.existsSync(filePath)) throw new Error('PCN_ENV_FILE does not exist');
  if (fs.existsSync(filePath)) {
    if (!fs.statSync(filePath).isFile()) throw new Error('PCN_ENV_FILE must identify a file');
    process.loadEnvFile(filePath);
  }
  if (process.env.SQL_PASSWORD || process.platform !== 'win32') return;
  const file = process.env.PCN_SQL_CREDENTIAL_PATH || path.join(process.env.LOCALAPPDATA || '', 'SupplierPCN','sql-credential.xml');
  if (!path.isAbsolute(file) || !fs.existsSync(file)) return;
  const { stdout } = await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'..','scripts','read-sql-credential.ps1'),'-CredentialPath',file],{windowsHide:true,timeout:10000,maxBuffer:16384,env:windowsPowerShellEnvironment()});
  const credential = JSON.parse(stdout);
  process.env.SQL_USER ||= credential.username;
  process.env.SQL_PASSWORD = credential.password;
  if (credential.trustServerCertificate) process.env.SQL_TRUST_SERVER_CERTIFICATE ||= 'true';
}
module.exports = { loadRuntimeEnv, windowsPowerShellEnvironment };
