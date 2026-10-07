const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { runDirectoryRequest } = require('../src/windowsDirectoryService');
const { windowsPowerShellEnvironment } = require('../src/runtimeEnv');

function childFixture() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = value => { child.input = value; };
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = value => { child.encoding = value; };
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  return child;
}

test('AD PowerShell helper explicitly decodes JSON stdin as UTF-8', async () => {
  const source = await fs.readFile(path.resolve(__dirname, '../scripts/ad-directory.ps1'), 'utf8');
  assert.match(source, /\[Console\]::InputEncoding\s*=\s*\[System.Text.UTF8Encoding\]::new\(\$false\)/);
});

test('directory child uses fixed script, UTF-8 streams, JSON stdin and Desktop-compatible environment', async () => {
  const child = childFixture();
  let invocation;
  const request = { domain: 'KEMET.COM', operation: 'search', value: 'พนักงาน', limit: 20 };
  const pending = runDirectoryRequest(request, { platform: 'win32', env: { PATH: 'system-path', PSModulePath: 'Core-only', PSMODULEPATH: 'Core-only' }, spawnProcess(...args) { invocation = args; return child; } });
  assert.equal(invocation[0], 'powershell.exe');
  assert.deepEqual(invocation[1].slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.match(invocation[1].at(-1), /ad-directory\.ps1$/);
  assert.equal(invocation[2].windowsHide, true);
  assert.equal(invocation[2].env.PSModulePath, undefined);
  assert.equal(invocation[2].env.PSMODULEPATH, undefined);
  assert.equal(invocation[2].env.PATH, 'system-path');
  assert.equal(child.encoding, 'utf8');
  assert.deepEqual(JSON.parse(child.input), request);
  child.stdout.emit('data', '\uFEFF[{"displayName":"พนักงาน"}]');
  child.emit('close', 0);
  assert.deepEqual(await pending, [{ displayName: 'พนักงาน' }]);
});

test('directory child rejects timeout, excessive output, invalid JSON, exit failure and stream errors', async () => {
  for (const failure of ['timeout', 'output', 'json', 'exit', 'spawn', 'stdin']) {
    const child = childFixture();
    const pending = runDirectoryRequest({}, { platform: 'win32', timeoutMs: 10, spawnProcess: () => child });
    if (failure === 'output') child.stdout.emit('data', 'x'.repeat(256 * 1024 + 1));
    if (failure === 'json') { child.stdout.emit('data', 'invalid-json'); child.emit('close', 0); }
    if (failure === 'exit') child.emit('close', 1);
    if (failure === 'spawn') child.emit('error', new Error('spawn failed'));
    if (failure === 'stdin') child.stdin.emit('error', new Error('write failed'));
    await assert.rejects(pending);
    assert.equal(child.killed, true);
    child.emit('close', 0);
  }
  await assert.rejects(runDirectoryRequest({}, { platform: 'linux' }), /Windows host/);
});

test('actual Windows PowerShell preserves Thai JSON stdin without contacting AD', { skip: process.platform !== 'win32' }, async t => {
  const source = await fs.readFile(path.resolve(__dirname, '../scripts/ad-directory.ps1'), 'utf8');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcn-ad-utf8-'));
  t.after(() => {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('pcn-ad-utf8-')) throw new Error('Unexpected PowerShell fixture path');
    return fs.rm(target, { recursive: true, force: true });
  });
  const fixturePath = path.join(directory, 'utf8-fixture.ps1');
  const prefix = source.slice(0, source.indexOf('function Escape-LdapValue'));
  await fs.writeFile(fixturePath, prefix + '[Console]::Out.Write([Console]::In.ReadToEnd())\n');
  const result = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixturePath], { windowsHide: true, env: windowsPowerShellEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { child.kill(); reject(new Error('PowerShell UTF-8 test timed out')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('PowerShell UTF-8 test failed')); });
    child.stdin.end(JSON.stringify({ query: 'พนักงาน ทดสอบ' }));
  });
  assert.deepEqual(JSON.parse(result), { query: 'พนักงาน ทดสอบ' });
});

test('AD entry factory retains current Windows credentials and signing/sealing without connecting to LDAP', { skip: process.platform !== 'win32' }, async t => {
  const source = await fs.readFile(path.resolve(__dirname, '../scripts/ad-directory.ps1'), 'utf8');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcn-ad-credentials-'));
  t.after(() => {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('pcn-ad-credentials-')) throw new Error('Unexpected AD credentials fixture path');
    return fs.rm(target, { recursive: true, force: true });
  });
  const fixturePath = path.join(directory, 'credentials-fixture.ps1');
  const prefix = source.slice(0, source.indexOf('\ntry {'));
  await fs.writeFile(fixturePath, prefix + String.raw`
$flags = [System.DirectoryServices.AuthenticationTypes]::Secure -bor [System.DirectoryServices.AuthenticationTypes]::Signing -bor [System.DirectoryServices.AuthenticationTypes]::Sealing
$entry = New-AuthenticatedDirectoryEntry -Path 'LDAP://directory-fixture.invalid/RootDSE' -Authentication $flags
$legacyEntry = [System.DirectoryServices.DirectoryEntry]::new('LDAP://directory-fixture.invalid/RootDSE', $null, $null, $flags)
try {
    [Console]::Out.Write((ConvertTo-Json -InputObject @{ usesCurrentIdentity = ($null -eq $entry.psbase.Username); flags = [int]$entry.psbase.AuthenticationType; legacyConstructorUsesEmptyUsername = ($null -ne $legacyEntry.psbase.Username -and $legacyEntry.psbase.Username -eq '') } -Compress))
} finally { $entry.psbase.Dispose(); $legacyEntry.psbase.Dispose() }
`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixturePath], { windowsHide: true, env: windowsPowerShellEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { child.kill(); reject(new Error('AD credentials fixture timed out')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('AD credentials fixture failed')); });
  });
  assert.deepEqual(JSON.parse(result), { usesCurrentIdentity: true, flags: 193, legacyConstructorUsesEmptyUsername: true });
});
