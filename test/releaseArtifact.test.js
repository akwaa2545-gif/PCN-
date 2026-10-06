const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createManifest, signManifest, selectRuntimeFiles, packageRelease, copyRegularTree } = require('../scripts/package-release');
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
    'login.html', 'auth.css', 'tokin-header-logo.png', 'CairoliClassic-Bold.otf', 'scripts/read-sql-credential.ps1',
    '.env', '.env.production', '.github/workflows/deploy.yml', 'test/foo.js', 'plans/foo.md',
    'sql/migrations/001_core.sql', 'scripts/db-migrate.js', 'data/pcn.json', 'firebase-client.js',
    'src/.env', 'src/key.pem', 'src/nested/file.js', 'src/not-supported.js', 'workbook.xlsx', 'node_modules/evil.js',
  ]);
  assert.deepEqual(selected, [
    'CairoliClassic-Bold.otf', 'auth.css', 'login.html', 'package-lock.json', 'package.json',
    'scripts/read-sql-credential.ps1', 'server.js', 'src/authService.js', 'src/clientAddress.js', 'tokin-header-logo.png',
  ]);
  for (const unsafe of ['src/../.env', 'src\\evil.js', '/src/evil.js', 'src//evil.js']) {
    assert.throws(() => selectRuntimeFiles([unsafe]), /path/i);
  }
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

test('Windows packaging and verifier CLI round trip excludes untracked private config', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pcn-artifact-test-'));
  t.after(async () => {
    const resolved = path.resolve(temporary);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'pcn-artifact-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const root = path.join(temporary, 'source');
  const output = path.join(temporary, 'output');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'fixture'), { recursive: true });
  for (const [file, content] of Object.entries({
    'server.js': '// isolated fixture', 'package.json': '{}', 'package-lock.json': '{}',
    'src/httpServer.js': '// isolated fixture', 'src/runtimeEnv.js': '// isolated fixture',
    'login.html': '<!doctype html>', '.env': 'NOT_A_REAL_SECRET=excluded',
    'node_modules/fixture/index.js': 'module.exports = {};',
  })) await fs.writeFile(path.join(root, file), content);
  await run('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  await run('git', ['add', 'server.js', 'package.json', 'package-lock.json', 'src/httpServer.js', 'src/runtimeEnv.js', 'login.html'], { cwd: root, windowsHide: true });
  const manifest = await packageRelease({ root, output, commit: 'a'.repeat(40), runNumber: 42, runAttempt: 1, signingKey: keys.privateKey });
  assert.equal(manifest.releaseId, 'pcn-test-42-1');
  assert.deepEqual((await fs.readdir(path.join(output, 'runtime'))).sort(), ['login.html', 'node_modules', 'package-lock.json', 'package.json', 'server.js', 'src']);
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
. $env:PCN_FIXTURE_EXTRACTOR
$script:Base = [IO.Path]::GetFullPath($env:PCN_FIXTURE_BASE)
Expand-VerifiedArchive $env:PCN_FIXTURE_ARCHIVE (Join-Path $script:Base 'extracted')
`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', extractScript], {
    windowsHide: true, env: { ...process.env, PCN_FIXTURE_EXTRACTOR: path.resolve(__dirname, '../scripts/deploy-pcn-release.ps1'),
      PCN_FIXTURE_BASE: temporary, PCN_FIXTURE_ARCHIVE: path.join(output, 'pcn.zip'), PSExecutionPolicyPreference: 'Restricted' },
  });
  assert.equal(await fs.readFile(path.join(temporary, 'extracted/src/runtimeEnv.js'), 'utf8'), '// isolated fixture');
  assert.equal(await fs.readFile(path.join(temporary, 'extracted/node_modules/fixture/index.js'), 'utf8'), 'module.exports = {};');
  await fs.appendFile(path.join(output, 'pcn.zip'), 'tampered');
  await assert.rejects(run(process.execPath, args, { windowsHide: true }), error => error.code === 1 && error.stderr.trim() === 'Release verification failed');
  await assert.rejects(packageRelease({ root, output: root, commit: 'a'.repeat(40), runNumber: 42, runAttempt: 1, signingKey: keys.privateKey }), /outside/);
  await assert.rejects(copyRegularTree(path.join(root, 'missing'), path.join(temporary, 'missing')), /ENOENT/);
});
