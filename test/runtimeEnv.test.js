const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const modulePath = path.resolve(__dirname, '../src/runtimeEnv.js');
const childSource = `
  require(${JSON.stringify(modulePath)}).loadRuntimeEnv().then(() => {
    process.stdout.write(JSON.stringify({
      marker: process.env.RUNTIME_ENV_TEST_MARKER,
      passwordPresent: Boolean(process.env.SQL_PASSWORD),
      dpapiPasswordMatches: process.env.SQL_PASSWORD === 'runtime-env-test-only',
      user: process.env.SQL_USER,
      trust: process.env.SQL_TRUST_SERVER_CERTIFICATE
    }));
  }).catch(error => {
    process.stderr.write(error.message);
    process.exitCode = 1;
  });
`;

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcn-runtime-env-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const windowsProfileKeys = new Set([
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH',
  'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'OS',
  'PROGRAMDATA', 'ALLUSERSPROFILE', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS', 'PSMODULEPATH'
]);

function childEnvironment(extra = {}, source = process.env) {
  return {
    ...Object.fromEntries(Object.entries(source).filter(([key]) => windowsProfileKeys.has(key.toUpperCase()))),
    ...extra
  };
}

async function load(cwd, extra = {}) {
  // Keep the real Windows profile for DPAPI, but never inspect its application credential file.
  const environment = childEnvironment({ PCN_SQL_CREDENTIAL_PATH: path.join(cwd, 'absent-test-credential.xml'), ...extra });
  const result = await run(process.execPath, ['-e', childSource], { cwd, env: environment, windowsHide: true, timeout: 20000 });
  return JSON.parse(result.stdout);
}

test('child environment preserves cold Windows profile variables without inherited application configuration', () => {
  const profile = {
    SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\RUNNERADMIN', APPDATA: 'C:\\Users\\RUNNERADMIN\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\RUNNERADMIN\\AppData\\Local', TEMP: 'C:\\Windows\\Temp', TMP: 'C:\\Windows\\Temp',
    HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\RUNNERADMIN', USERNAME: 'RUNNERADMIN', USERDOMAIN: 'host',
    OS: 'Windows_NT', COMSPEC: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE;.CMD',
    SystemDrive: 'C:', PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    SQL_PASSWORD: 'synthetic-inherited-secret', SQL_USER: 'inherited-user',
    PCN_ENV_FILE: 'C:\\private\\service.env', PCN_SQL_CREDENTIAL_PATH: 'C:\\private\\credential.xml',
    PCN_RELEASE_SIGNING_KEY: 'synthetic-private-key', PSExecutionPolicyPreference: 'InheritedPolicy'
  };
  const environment = childEnvironment({ PSExecutionPolicyPreference: 'Restricted' }, profile);
  for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'Path', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'OS', 'COMSPEC', 'PATHEXT', 'PSModulePath']) {
    assert.equal(environment[key], profile[key]);
  }
  assert.equal(environment.SQL_PASSWORD, undefined);
  assert.equal(environment.SQL_USER, undefined);
  assert.equal(environment.PCN_ENV_FILE, undefined);
  assert.equal(environment.PCN_SQL_CREDENTIAL_PATH, undefined);
  assert.equal(environment.PCN_RELEASE_SIGNING_KEY, undefined);
  assert.equal(environment.PSExecutionPolicyPreference, 'Restricted');
});

test('default .env loads from current directory and process environment takes precedence', async t => {
  const directory = await workspace(t);
  await fs.writeFile(path.join(directory, '.env'), 'RUNTIME_ENV_TEST_MARKER=from-file\nSQL_PASSWORD=runtime-env-test-only\n');
  assert.equal((await load(directory)).marker, 'from-file');
  const overridden = await load(directory, { RUNTIME_ENV_TEST_MARKER: 'from-process' });
  assert.equal(overridden.marker, 'from-process');
  assert.equal(overridden.passwordPresent, true);
  const passwordOverride = await load(directory, { SQL_PASSWORD: 'process-test-only' });
  assert.equal(passwordOverride.dpapiPasswordMatches, false);
});

test('absolute PCN_ENV_FILE loads external file instead of working-directory .env', async t => {
  const directory = await workspace(t);
  const external = path.join(directory, 'protected settings', 'service.env');
  await fs.mkdir(path.dirname(external));
  await fs.writeFile(external, 'RUNTIME_ENV_TEST_MARKER=external\nSQL_PASSWORD=runtime-env-test-only\n');
  await fs.writeFile(path.join(directory, '.env'), 'RUNTIME_ENV_TEST_MARKER=wrong-default\n');
  const result = await load(directory, { PCN_ENV_FILE: external });
  assert.equal(result.marker, 'external');
  assert.equal(result.passwordPresent, true);
  assert.equal((await load(directory, { PCN_ENV_FILE: external, RUNTIME_ENV_TEST_MARKER: 'process' })).marker, 'process');
});

test('explicit relative and missing env paths fail clearly', async t => {
  const directory = await workspace(t);
  await fs.writeFile(path.join(directory, 'relative.env'), 'SQL_PASSWORD=runtime-env-test-only\n');
  await assert.rejects(load(directory, { PCN_ENV_FILE: 'relative.env' }), error => /PCN_ENV_FILE.*absolute/.test(error.stderr));
  await assert.rejects(load(directory, { PCN_ENV_FILE: path.join(directory, 'missing.env') }), error => /PCN_ENV_FILE.*(not found|does not exist)/.test(error.stderr));
  await assert.rejects(load(directory, { PCN_ENV_FILE: directory }), error => /PCN_ENV_FILE.*file/.test(error.stderr));
  if (process.platform === 'win32') {
    await assert.rejects(load(directory, { PCN_ENV_FILE: '\\relative-to-current-drive.env' }), error => /PCN_ENV_FILE.*absolute/.test(error.stderr));
  }
});

test('missing default .env remains optional', async t => {
  const directory = await workspace(t);
  const result = await load(directory, { SQL_PASSWORD: 'runtime-env-test-only' });
  assert.equal(result.passwordPresent, true);
  assert.equal(result.marker, undefined);
  assert.equal((await load(directory)).passwordPresent, false);
});

test('Windows DPAPI credential fallback survives env-file selection and preserves process SQL user', { skip: process.platform !== 'win32' }, async t => {
  const directory = await workspace(t);
  const credential = path.join(directory, 'credential.xml');
  const script = path.join(directory, 'seed-fixture.ps1');
  await fs.writeFile(script, `param([string]$CredentialPath)
$ErrorActionPreference = 'Stop'
$testSecret = ConvertTo-SecureString 'runtime-env-test-only' -AsPlainText -Force
$testCredential = New-Object System.Management.Automation.PSCredential('fixture-user', $testSecret)
@{Credential=$testCredential;TrustServerCertificate=$true} | Export-Clixml -LiteralPath $CredentialPath
`);
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-CredentialPath', credential], { windowsHide: true, timeout: 20000, env: childEnvironment({ PSExecutionPolicyPreference: 'Restricted' }) });
  const external = path.join(directory, 'service.env');
  await fs.writeFile(external, 'RUNTIME_ENV_TEST_MARKER=external\n');
  const result = await load(directory, { PCN_ENV_FILE: external, PCN_SQL_CREDENTIAL_PATH: credential, SQL_USER: 'process-user' });
  assert.equal(result.marker, 'external');
  assert.equal(result.dpapiPasswordMatches, true);
  assert.equal(result.user, 'process-user');
  assert.equal(result.trust, 'true');
  const restricted = await load(directory, {
    PCN_ENV_FILE: external,
    PCN_SQL_CREDENTIAL_PATH: credential,
    PSExecutionPolicyPreference: 'Restricted'
  });
  assert.equal(restricted.dpapiPasswordMatches, true);
  assert.equal(restricted.user, 'fixture-user');
  await fs.writeFile(credential, 'invalid DPAPI fixture');
  const fromProcess = await load(directory, { PCN_ENV_FILE: external, PCN_SQL_CREDENTIAL_PATH: credential, SQL_PASSWORD: 'process-test-only' });
  assert.equal(fromProcess.passwordPresent, true);
  assert.equal(fromProcess.dpapiPasswordMatches, false);
});
