const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createManifest, signManifest, selectRuntimeFiles, packageRelease, copyRegularTree, windowsPowerShellEnvironment } = require('../scripts/package-release');
const { verifyRelease, parseArguments } = require('../scripts/verify-release');
const run = promisify(execFile);

const keys = crypto.generateKeyPairSync('ed25519');
const archive = Buffer.from('isolated ZIP fixture');
function fixture(changes = {}) {
  const manifest = { ...createManifest({ archive, commit: 'a'.repeat(40), runNumber: 42, runAttempt: 1 }), ...changes };
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
  return { manifestBytes: bytes, signature: signManifest(bytes, keys.privateKey), archive, publicKey: keys.publicKey };
}

test('a signed release accepts the pinned Ed25519 public key and archive digest', () => {
  const result = verifyRelease(fixture());
  assert.equal(result.releaseId, 'pcn-test-42-1');
  assert.equal(result.sha256, crypto.createHash('sha256').update(archive).digest('hex'));
});

test('manifest byte tampering, wrong key, malformed and tampered signatures fail', () => {
  const original = fixture();
  assert.throws(() => verifyRelease({ ...original, manifestBytes: Buffer.from('{broken JSON') }), /signature/i);
  assert.throws(() => verifyRelease({ ...original, publicKey: crypto.generateKeyPairSync('ed25519').publicKey }), /signature/i);
  assert.throws(() => verifyRelease({ ...original, signature: 'not base64!' }), /signature/i);
  const signature = Buffer.from(original.signature, 'base64');
  signature[0] ^= 1;
  assert.throws(() => verifyRelease({ ...original, signature: signature.toString('base64') }), /signature/i);
});

test('a signed manifest cannot substitute an archive or repository', () => {
  assert.throws(() => verifyRelease({ ...fixture(), archive: Buffer.from('tampered archive') }), /digest/i);
  assert.throws(() => verifyRelease(fixture({ repository: 'attacker/project' })), /manifest/i);
});

test('unsafe IDs, versions, counters, commits and archive names fail even when signed', () => {
  for (const change of [
    { releaseId: '../evil' }, { releaseId: 'pcn-test-43-1' }, { schemaVersion: 2 },
    { runNumber: 0 }, { runNumber: Number.MAX_SAFE_INTEGER + 1 }, { runAttempt: 1.5 },
    { commit: 'a'.repeat(39) }, { archive: '../pcn.zip' }, { sha256: 'f'.repeat(63) },
    { unexpected: true },
  ]) assert.throws(() => verifyRelease(fixture(change)), /manifest/i);
});

test('only tracked runtime allowlist paths are packaged', () => {
  const selected = selectRuntimeFiles([
    'server.js', 'package.json', 'package-lock.json', 'src/authService.js', 'src/clientAddress.js',
    'login.html', 'records.html', 'records.js', 'records.css', 'auth.css', 'admin-users.js', 'tokin-header-logo.png', 'thailand-login.jpg', 'CairoliClassic-Bold.otf', 'scripts/read-sql-credential.ps1', 'scripts/ad-directory.ps1',
    '.env', '.env.production', '.github/workflows/deploy.yml', 'test/foo.js', 'plans/foo.md',
    'sql/migrations/001_core.sql', 'scripts/db-migrate.js', 'data/pcn.json', 'firebase-client.js',
    'src/.env', 'src/key.pem', 'src/nested/file.js', 'src/not-supported.js', 'workbook.xlsx', 'node_modules/evil.js',
  ]);
  assert.deepEqual(selected, [
    'CairoliClassic-Bold.otf', 'admin-users.js', 'auth.css', 'login.html', 'package-lock.json', 'package.json', 'records.css', 'records.html', 'records.js',
    'scripts/read-sql-credential.ps1', 'server.js', 'src/authService.js', 'src/clientAddress.js', 'thailand-login.jpg', 'tokin-header-logo.png',
  ]);
  for (const unsafe of ['src/../.env', 'src\\evil.js', '/src/evil.js', 'src//evil.js']) {
    assert.throws(() => selectRuntimeFiles([unsafe]), /path/i);
  }
});

test('document controls and recovery ship as runtime assets while migrations stay explicit', () => {
  const files=['document-workspace.js','document-workspace.css','document-recovery.js','document-bridge.js'];
  assert.deepEqual(selectRuntimeFiles([...files,'sql/migrations/005_document_control.sql']),[...files].sort());
});

test('signing accepts only Ed25519 keys and safe CI counters', () => {
  assert.throws(() => signManifest(Buffer.from('{}'), crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), /Ed25519/);
  assert.throws(() => createManifest({ archive, commit: 'a'.repeat(40), runNumber: 0, runAttempt: 1 }), /manifest/i);
});

test('manifest-only CLI mode requires exactly metadata paths and rejects archive or duplicate flags', () => {
  const paths = ['--manifest', 'manifest.json', '--signature', 'manifest.sig', '--public-key', 'public.pem'];
  assert.equal(parseArguments(['--manifest-only', ...paths]).manifestOnly, true);
  assert.throws(() => parseArguments(paths), /arguments/);
  assert.throws(() => parseArguments(['--manifest-only', ...paths, '--archive', 'pcn.zip']), /arguments/);
  assert.throws(() => parseArguments(['--manifest-only', '--manifest-only', ...paths]), /arguments/);
  assert.throws(() => parseArguments(['--manifest-only', ...paths, '--manifest', 'evil']), /arguments/);
});

test('Windows PowerShell child environment drops inherited Core module paths without mutating the parent', () => {
  const parent = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\fixture', Path: 'unchanged', PSModulePath: 'Core7/modules', psmodulepath: 'other/Core7' };
  const child = windowsPowerShellEnvironment(parent, { PCN_PACKAGE_STAGE: 'fixture' });
  assert.deepEqual(child, { SystemRoot: parent.SystemRoot, USERPROFILE: parent.USERPROFILE, Path: 'unchanged', PCN_PACKAGE_STAGE: 'fixture' });
  assert.equal(parent.PSModulePath, 'Core7/modules');
  assert.equal(parent.psmodulepath, 'other/Core7');
});

test('Windows packaging and deployment extraction accept every producer runtime asset and exclude private config', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pcn-artifact-test-'));
  t.after(async () => {
    const resolved = path.resolve(temporary);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'pcn-artifact-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const root = path.join(temporary, 'source');
  const output = path.join(temporary, 'output');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'fixture'), { recursive: true });
  const tracked = await run('git', ['ls-files', '-z'], { cwd: path.resolve(__dirname, '..'), windowsHide: true });
  const runtimeFiles = selectRuntimeFiles(tracked.stdout.split('\0').filter(Boolean));
  for (const file of runtimeFiles) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), `isolated runtime asset: ${file}`);
  }
  for (const [file, content] of Object.entries({
    'server.js': '// isolated fixture', 'package.json': '{}', 'package-lock.json': '{}',
    'src/httpServer.js': '// isolated fixture', 'src/runtimeEnv.js': '// isolated fixture',
    'admin-users.js': '// employee UI fixture', 'scripts/ad-directory.ps1': '# retired helper excluded',
    'scripts/read-sql-credential.ps1': '# protected SQL credential reader fixture',
    'login.html': '<!doctype html>', '.env': 'NOT_A_REAL_SECRET=excluded',
    'node_modules/fixture/index.js': 'module.exports = {};',
  })) await fs.writeFile(path.join(root, file), content);
  await run('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  await run('git', ['add', ...runtimeFiles, 'scripts/ad-directory.ps1'], { cwd: root, windowsHide: true });
  const inheritedCoreEnvironment = { ...process.env, PSModulePath: path.join(temporary, 'pcn-artifact-bad-core-modules') };
  const manifest = await packageRelease({ root, output, commit: 'a'.repeat(40), runNumber: 42, runAttempt: 1, signingKey: keys.privateKey, env: inheritedCoreEnvironment });
  assert.equal(manifest.releaseId, 'pcn-test-42-1');
  const expectedRootEntries = [...new Set([...runtimeFiles.map(file => file.split('/')[0]), 'node_modules'])].sort();
  assert.deepEqual((await fs.readdir(path.join(output, 'runtime'))).sort(), expectedRootEntries);
  const publicKeyPath = path.join(temporary, 'public.pem');
  await fs.writeFile(publicKeyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const args = [path.resolve(__dirname, '../scripts/verify-release.js'),
    '--manifest', path.join(output, 'manifest.json'), '--signature', path.join(output, 'manifest.sig'),
    '--archive', path.join(output, 'pcn.zip'), '--public-key', publicKeyPath];
  const result = await run(process.execPath, args, { windowsHide: true });
  assert.deepEqual(JSON.parse(result.stdout), manifest);
  const manifestOnlyArgs = [...args.slice(0, 5), ...args.slice(7), '--manifest-only'];
  const manifestOnly = await run(process.execPath, manifestOnlyArgs, { windowsHide: true });
  assert.deepEqual(JSON.parse(manifestOnly.stdout), manifest);
  const extractScript = `
$ErrorActionPreference='Stop'
if ($env:PSModulePath -like '*pcn-artifact-bad-core-modules*') { throw 'Inherited Core modules must not reach Windows PowerShell' }
. $env:PCN_FIXTURE_EXTRACTOR
$script:Base = [IO.Path]::GetFullPath($env:PCN_FIXTURE_BASE)
Expand-VerifiedArchive $env:PCN_FIXTURE_ARCHIVE (Join-Path $script:Base 'extracted')
`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', extractScript], {
    windowsHide: true, env: windowsPowerShellEnvironment(inheritedCoreEnvironment, {
      PCN_FIXTURE_EXTRACTOR: path.resolve(__dirname, '../scripts/deploy-pcn-release.ps1'),
      PCN_FIXTURE_BASE: temporary, PCN_FIXTURE_ARCHIVE: path.join(output, 'pcn.zip'), PSExecutionPolicyPreference: 'Restricted' }),
  });
  for (const file of runtimeFiles) {
    assert.deepEqual(await fs.readFile(path.join(temporary, 'extracted', file)), await fs.readFile(path.join(root, file)), file);
  }
  assert.equal(await fs.readFile(path.join(temporary, 'extracted/src/runtimeEnv.js'), 'utf8'), '// isolated fixture');
  assert.equal(await fs.readFile(path.join(temporary, 'extracted/admin-users.js'), 'utf8'), '// employee UI fixture');
  await assert.rejects(fs.access(path.join(output, 'runtime/scripts/ad-directory.ps1')), /ENOENT/);
  await assert.rejects(fs.access(path.join(temporary, 'extracted/scripts/ad-directory.ps1')), /ENOENT/);
  assert.equal(await fs.readFile(path.join(temporary, 'extracted/scripts/read-sql-credential.ps1'), 'utf8'), '# protected SQL credential reader fixture');
  assert.equal(await fs.readFile(path.join(temporary, 'extracted/node_modules/fixture/index.js'), 'utf8'), 'module.exports = {};');
  await fs.appendFile(path.join(output, 'pcn.zip'), 'tampered');
  await assert.rejects(run(process.execPath, args, { windowsHide: true }), error => error.code === 1 && error.stderr.trim() === 'Release verification failed');
  await assert.rejects(packageRelease({ root, output: root, commit: 'a'.repeat(40), runNumber: 42, runAttempt: 1, signingKey: keys.privateKey }), /outside/);
  await assert.rejects(copyRegularTree(path.join(root, 'missing'), path.join(temporary, 'missing')), /ENOENT/);
});
