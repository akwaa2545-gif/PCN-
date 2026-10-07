const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { windowsPowerShellEnvironment } = require('../scripts/package-release');

const run = promisify(execFile);
const deploymentScript = path.resolve(__dirname, '../scripts/deploy-pcn-release.ps1');

// Dot-source production validation only; all operating-system queries are isolated fixtures.
const fixture = `
. $env:PCN_IDENTITY_SCRIPT
$fixture = $env:PCN_IDENTITY_CASE | ConvertFrom-Json
function Get-NetTCPConnection {
    [pscustomobject]@{LocalAddress = $fixture.listener; OwningProcess = 200}
}
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($ClassName -eq 'Win32_Service') {
        if ($Filter -ne "Name='SupplierPCNTest'") { throw 'Unexpected service query' }
        return [pscustomobject]@{StartName = $fixture.service; State = 'Running'; ProcessId = 100}
    }
    if ($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId=200') { throw 'Unexpected process query' }
    [pscustomobject]@{ParentProcessId = $fixture.parent; ExecutablePath = $fixture.executable; CommandLine = $fixture.command}
}
function Invoke-CimMethod {
    param($InputObject, $MethodName)
    if ($MethodName -ne 'GetOwner') { throw 'Unexpected owner query' }
    [pscustomobject]@{ReturnValue = 0; Domain = 'NT AUTHORITY'; User = $fixture.owner}
}
try { Assert-PcnBackend 'C:\\SupplierPCN\\releases\\fixture'; @{accepted = $true} | ConvertTo-Json -Compress }
catch { @{accepted = $false; reason = $_.Exception.Message} | ConvertTo-Json -Compress }
`;

async function validateBackend(changes = {}) {
  const details = {
    service: 'NT AUTHORITY\\NetworkService', owner: 'NETWORK SERVICE',
    parent: 100, listener: '127.0.0.1', executable: 'C:\\Program Files\\nodejs\\node.exe',
    command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\SupplierPCN\\releases\\fixture\\server.js"',
    ...changes,
  };
  const result = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', fixture,
  ], {
    windowsHide: true,
    timeout: 30000,
    env: windowsPowerShellEnvironment(process.env, {
      PCN_IDENTITY_SCRIPT: deploymentScript, PCN_IDENTITY_CASE: JSON.stringify(details),
    }),
  });
  return JSON.parse(result.stdout);
}

test('deployment accepts only the pinned NetworkService service and process owner', { skip: process.platform !== 'win32' }, async () => {
  assert.deepEqual(await validateBackend(), { accepted: true });
  for (const changes of [
    { service: 'NT AUTHORITY\\LocalService', owner: 'LOCAL SERVICE' },
    { service: 'KEMET\\arbitrary-account', owner: 'NETWORK SERVICE' },
    { owner: 'LOCAL SERVICE' },
  ]) assert.equal((await validateBackend(changes)).accepted, false);
});

test('deployment rejects another service process, another release and a public listener', { skip: process.platform !== 'win32' }, async () => {
  for (const changes of [
    { parent: 999 }, { listener: '0.0.0.0' }, { executable: 'C:\\Other\\node.exe' },
    { command: '"C:\\SupplierPCN\\releases\\other\\server.js"' },
  ]) assert.equal((await validateBackend(changes)).accepted, false);
});

test('deployment ACLs continue to grant read access to the unique service SID only', async () => {
  const source = await fs.readFile(deploymentScript, 'utf8');
  assert.match(source, /NT SERVICE\\' \+ \$script:ServiceName/);
  assert.match(source, /\$rights\[\$sid\] = 'ReadAndExecute'/);
  assert.match(source, /-notin @\('S-1-5-18', 'S-1-5-32-544', \$serviceSid\)/);
  assert.match(source, /Application service can modify its release/);
  assert.doesNotMatch(source, /\$rights\['S-1-5-20'\]/);
});
