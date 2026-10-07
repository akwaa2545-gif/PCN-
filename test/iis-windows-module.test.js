const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { windowsPowerShellEnvironment } = require('../src/runtimeEnv');

const run = promisify(execFile);
const account = 'KEMET\\000123';
const valid = [account, 'NTLM', true, account, '172.30.77.1', true];
const invalid = (index, value) => valid.map((original, current) => current === index ? value : original);

test('IIS Windows module compiles and rejects untrusted identity boundaries', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcn-iis-module-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const assembly = path.join(directory, 'PcnWindowsIdentityModule.dll');
  const scriptPath = path.join(directory, 'validate.ps1');
  const fixturePath = path.join(directory, 'cases.json');
  const framework = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const cases = [
    { name: 'leading-zero employee code', args: valid, allow: true },
    { name: 'Kerberos and IPv6', args: [account, 'Kerberos', true, account, '::1', true], allow: true },
    { name: 'Negotiate and case-insensitive domain', args: [account, 'Negotiate', true, 'kemet\\000123', '127.0.0.1', true], allow: true },
    { name: 'unknown authentication', args: invalid(1, 'Basic'), allow: false },
    { name: 'empty authentication', args: invalid(1, ''), allow: false },
    { name: 'unauthenticated token', args: invalid(2, false), allow: false },
    { name: 'wrong domain', args: ['OTHER\\000123', 'NTLM', true, 'OTHER\\000123', '127.0.0.1', true], allow: false },
    { name: 'logon user mismatch', args: invalid(3, 'KEMET\\000124'), allow: false },
    { name: 'missing logon user', args: invalid(3, ''), allow: false },
    { name: 'comma injection', args: invalid(0, 'KEMET\\000123,OTHER\\123'), allow: false },
    { name: 'whitespace injection', args: invalid(0, 'KEMET\\000 123'), allow: false },
    { name: 'newline injection', args: invalid(0, `${account}\r\nInjected: value`), allow: false },
    { name: 'trailing newline', args: invalid(0, `${account}\n`), allow: false },
    { name: 'oversized employee code', args: invalid(0, `KEMET\\${'1'.repeat(21)}`), allow: false },
    { name: 'machine account', args: invalid(0, 'KEMET\\HOST$'), allow: false },
    { name: 'missing account', args: invalid(0, null), allow: false },
    { name: 'invalid client IP', args: invalid(4, 'client.invalid'), allow: false },
    { name: 'unencrypted request', args: invalid(5, false), allow: false },
  ];
  await fs.writeFile(fixturePath, JSON.stringify(cases));
  await fs.writeFile(scriptPath, `param([string]$AssemblyPath,[string]$FixturePath)
$ErrorActionPreference='Stop'
$type=[Reflection.Assembly]::LoadFile($AssemblyPath).GetType('SupplierPcn.Iis.PcnWindowsIdentityModule')
$method=$type.GetMethod('IsAllowedIdentity',[Reflection.BindingFlags]'Static,NonPublic')
if(-not $method){throw 'Identity validation method unavailable'}
$cases=Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
$results=@($cases | ForEach-Object {
  $actual=[bool]$method.Invoke($null,[object[]]$_.args)
  [ordered]@{name=$_.name;expected=[bool]$_.allow;actual=$actual}
})
[Console]::Out.Write((ConvertTo-Json -InputObject $results -Compress))
`);
  const options = { windowsHide: true, timeout: 30000, maxBuffer: 32768, env: windowsPowerShellEnvironment() };
  const compiled = await run(path.join(framework, 'csc.exe'), [
    '/nologo', '/target:library', '/warnaserror', '/define:TRACE', `/out:${assembly}`,
    `/reference:${path.join(framework, 'System.Web.dll')}`,
    path.resolve(__dirname, '../scripts/iis-windows-auth/PcnWindowsIdentityModule.cs'),
  ], options);
  assert.equal(compiled.stderr, '');
  const result = await run(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-AssemblyPath', assembly, '-FixturePath', fixturePath,
  ], options);
  const results = JSON.parse(result.stdout);
  assert.equal(results.length, cases.length);
  for (const entry of results) assert.equal(entry.actual, entry.expected, entry.name);
});
