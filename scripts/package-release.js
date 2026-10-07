const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validateManifest } = require('./verify-release');
const { windowsPowerShellEnvironment: runtimePowerShellEnvironment } = require('../src/runtimeEnv');
const run = promisify(execFile);

const ROOT_FILES = new Set([
  'server.js', 'package.json', 'package-lock.json', 'admin.html', 'form.html', 'index.html', 'login.html',
  'app.js', 'admin.js', 'admin-users.js', 'login.js', 'session-client.js', 'auth.css', 'admin.css', 'styles.css',
  'tokin-header-logo.png', 'compic20220308153715_T3zHf.png', 'CairoliClassic-Bold.otf',
  'scripts/read-sql-credential.ps1',
]);

function selectRuntimeFiles(tracked) {
  return [...new Set(tracked.filter(file => {
    if (file.includes('\\') || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Unsafe tracked file path');
    }
    return ROOT_FILES.has(file) || /^src\/[A-Za-z][A-Za-z0-9]*\.js$/.test(file);
  }))].sort();
}

function createManifest({ archive, commit, runNumber, runAttempt }) {
  return validateManifest({
    schemaVersion: 1, repository: 'akwaa2545-gif/PCN-', runNumber, runAttempt, commit,
    releaseId: `pcn-test-${runNumber}-${runAttempt}`, archive: 'pcn.zip',
    sha256: crypto.createHash('sha256').update(archive).digest('hex'),
  });
}

function signManifest(bytes, privateKey) {
  const key = privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Signing requires an Ed25519 private key');
  return crypto.sign(null, bytes, key).toString('base64');
}

async function copyRegularTree(source, target) {
  const info = await fs.lstat(source);
  if (info.isSymbolicLink()) throw new Error('Release files cannot be symbolic links');
  if (info.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const child of await fs.readdir(source)) await copyRegularTree(path.join(source, child), path.join(target, child));
  } else if (info.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  } else throw new Error('Unsupported release file type');
}

function windowsPowerShellEnvironment(env, extras = {}) {
  // Node cannot remove pwsh's Core-only module directories from PSModulePath.
  // Omitting this variable lets Windows PowerShell rebuild its own module defaults.
  return runtimePowerShellEnvironment({ ...env, ...extras });
}

async function packageRelease({ root, output, commit, runNumber, runAttempt, signingKey, env = process.env }) {
  if (process.platform !== 'win32') throw new Error('Release must be built on Windows');
  // Validate metadata and key before packaging; never write the signing key to disk.
  createManifest({ archive: Buffer.alloc(0), commit, runNumber, runAttempt });
  signManifest(Buffer.alloc(0), signingKey);
  const sourceRoot = path.resolve(root);
  const outputRoot = path.resolve(output);
  if (outputRoot === sourceRoot || outputRoot.startsWith(sourceRoot + path.sep)) throw new Error('Release output must be outside the checkout');
  await fs.mkdir(outputRoot, { recursive: true });
  const stage = path.join(outputRoot, 'runtime');
  await fs.mkdir(stage); // A reused output directory fails rather than mixing artifacts.
  const { stdout } = await run('git', ['ls-files', '-z'], { cwd: sourceRoot, windowsHide: true, maxBuffer: 1024 * 1024 });
  const selected = selectRuntimeFiles(stdout.split('\0').filter(Boolean));
  if (['server.js', 'package.json', 'package-lock.json', 'src/httpServer.js'].some(required => !selected.includes(required))) {
    throw new Error('Runtime source files missing');
  }
  for (const file of selected) await copyRegularTree(path.join(sourceRoot, file), path.join(stage, file));
  await copyRegularTree(path.join(sourceRoot, 'node_modules'), path.join(stage, 'node_modules'));
  const archivePath = path.join(outputRoot, 'pcn.zip');
  // PS5 Compress-Archive uses backslash entry names, which the strict consumer rejects.
  // Explicit ZIP entries use forward slashes on every supported Windows version.
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
$stageRoot = [IO.Path]::GetFullPath($env:PCN_PACKAGE_STAGE)
$archiveStream = [IO.File]::Open($env:PCN_PACKAGE_ARCHIVE, [IO.FileMode]::CreateNew)
$zip = New-Object IO.Compression.ZipArchive($archiveStream, [IO.Compression.ZipArchiveMode]::Create, $false)
try {
  foreach ($file in Get-ChildItem -LiteralPath $stageRoot -Recurse -File -Force) {
    $name = $file.FullName.Substring($stageRoot.Length + 1).Replace('\\', '/')
    $entry = $zip.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
    $sourceStream = [IO.File]::OpenRead($file.FullName)
    $targetStream = $entry.Open()
    try { $sourceStream.CopyTo($targetStream) }
    finally { $targetStream.Dispose(); $sourceStream.Dispose() }
  }
} finally { $zip.Dispose(); $archiveStream.Dispose() }
`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, env: windowsPowerShellEnvironment(env, { PCN_PACKAGE_STAGE: stage, PCN_PACKAGE_ARCHIVE: archivePath }),
    timeout: 300000, maxBuffer: 1024 * 1024,
  });
  const archive = await fs.readFile(archivePath);
  const manifest = createManifest({ archive, commit, runNumber, runAttempt });
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
  await fs.writeFile(path.join(outputRoot, 'manifest.json'), bytes, { flag: 'wx' });
  await fs.writeFile(path.join(outputRoot, 'manifest.sig'), signManifest(bytes, signingKey) + '\n', { flag: 'wx' });
  return manifest;
}

async function main() {
  const manifest = await packageRelease({
    root: process.cwd(), output: process.env.PCN_RELEASE_OUTPUT,
    commit: process.env.GITHUB_SHA, runNumber: Number(process.env.GITHUB_RUN_NUMBER),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), signingKey: process.env.PCN_RELEASE_SIGNING_KEY,
  });
  process.stdout.write(JSON.stringify(manifest) + '\n');
}

if (require.main === module) main().catch(() => { console.error('Release packaging failed'); process.exitCode = 1; });
module.exports = { createManifest, signManifest, selectRuntimeFiles, copyRegularTree, windowsPowerShellEnvironment, packageRelease };
