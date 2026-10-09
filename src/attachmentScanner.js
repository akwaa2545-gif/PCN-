const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { ApiError } = require('./apiError');

const windowsPath = path.win32;
const limits = Object.freeze({ shell: false, windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL', encoding: 'utf8' });
const aclCommand = `$ErrorActionPreference = 'Stop'
try {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl = Get-Acl -LiteralPath $env:PCN_SCAN_ACL_PATH
  $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $safe = $allowed -contains $owner
  if ($env:PCN_SCAN_ACL_ROOT -eq '1' -and -not $acl.AreAccessRulesProtected) { $safe = $false }
  $inheritable = $false
  $flags = [int][System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [int][System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $full = [int][System.Security.AccessControl.FileSystemRights]::FullControl
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
      if ($allowed -notcontains $rule.IdentityReference.Value) { $safe = $false }
      if ($rule.IdentityReference.Value -eq $sid -and ([int]$rule.InheritanceFlags -band $flags) -eq $flags -and
        ([int]$rule.FileSystemRights -band $full) -eq $full -and $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None) {
        $inheritable = $true
      }
    }
  }
  [Console]::Out.Write((@{ safe = [bool]($safe -and $inheritable) } | ConvertTo-Json -Compress))
} catch { [Console]::Out.Write('{"safe":false}'); exit 1 }`;
const localAbsolute = value => typeof value === 'string' && /^[a-z]:\\/i.test(value)
  && !/[\x00-\x1f]/.test(value) && !value.split(/[\\/]/).includes('..');
const samePath = (left, right) => windowsPath.resolve(left).toLowerCase() === windowsPath.resolve(right).toLowerCase();

function allowedExecutable(value, env) {
  if (!localAbsolute(value) || windowsPath.basename(value).toLowerCase() !== 'mpcmdrun.exe') return false;
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programData = env.ProgramData || 'C:\\ProgramData';
  if (!localAbsolute(programFiles) || !localAbsolute(programData)) return false;
  if (samePath(value, windowsPath.join(programFiles, 'Windows Defender', 'MpCmdRun.exe'))) return true;
  const platform = windowsPath.join(programData, 'Microsoft', 'Windows Defender', 'Platform');
  const relative = windowsPath.relative(platform, value);
  return /^[0-9][0-9.\-]*\\MpCmdRun\.exe$/i.test(relative);
}

function readScannerConfiguration(env = process.env, platform = process.platform) {
  const provider = env.PCN_ATTACHMENT_SCANNER;
  if (!provider) return null;
  if (provider !== 'windows-defender' || platform !== 'win32'
    || !allowedExecutable(env.PCN_ATTACHMENT_SCANNER_PATH, env)
    || !localAbsolute(env.PCN_ATTACHMENT_SCAN_ROOT)
    || samePath(env.PCN_ATTACHMENT_SCAN_ROOT, windowsPath.parse(env.PCN_ATTACHMENT_SCAN_ROOT).root)
    || !localAbsolute(env.SystemRoot || 'C:\\Windows')) {
    throw new Error('Invalid attachment scanner configuration; use Windows Defender and a service-private local scan directory');
  }
  return Object.freeze({ executable: windowsPath.normalize(env.PCN_ATTACHMENT_SCANNER_PATH),
    scanRoot: windowsPath.normalize(env.PCN_ATTACHMENT_SCAN_ROOT),
    powershell: windowsPath.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    officialRoots: Object.freeze({ ProgramFiles: env.ProgramFiles, ProgramData: env.ProgramData }) });
}

function executeFile(program, args, options) {
  return new Promise((resolve, reject) => execFile(program, args, options, (error, stdout) => {
    if (error) reject(error);
    else resolve({ exitCode: 0, stdout });
  }));
}

function containedDirectory(directory, root) {
  return samePath(windowsPath.dirname(directory), root)
    && /^pcn-attachment-[a-z0-9_-]+$/i.test(windowsPath.basename(directory));
}

async function assertPrivateDirectory(fileSystem, directory, root) {
  if (!containedDirectory(directory, root)) throw new Error('Invalid scan directory');
  const info = await fileSystem.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fileSystem.realpath(directory), directory)) {
    throw new Error('Unsafe scan directory');
  }
}

function createAttachmentScanner(env = process.env, dependencies = {}) {
  const config = readScannerConfiguration(env, dependencies.platform || process.platform);
  if (!config) return null;
  const fileSystem = dependencies.fileSystem || fs;
  const execute = dependencies.execute || executeFile;
  let activeScans = 0;
  const assertPrivateAcl = async directory => {
    const result = await execute(config.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', aclCommand],
      { ...limits, timeout: 10000, maxBuffer: 8192, env: { ...process.env, PCN_SCAN_ACL_PATH: directory,
        PCN_SCAN_ACL_ROOT: samePath(directory, config.scanRoot) ? '1' : '0' } });
    let report;
    try { report = JSON.parse(String(result?.stdout || '').trim()); } catch { /* Invalid reports fail closed below. */ }
    if (result?.exitCode !== 0 || !report || Array.isArray(report) || Object.keys(report).length !== 1 || report.safe !== true) {
      throw new Error('Attachment scan directory does not have private inheritable access controls (ACL)');
    }
  };
  const ready = async () => {
    const root = await fileSystem.realpath(config.scanRoot);
    if (!samePath(root, config.scanRoot)) throw new Error('Unsafe scan root');
    const rootInfo = await fileSystem.lstat(config.scanRoot);
    const executableInfo = await fileSystem.lstat(config.executable);
    const powershellInfo = await fileSystem.lstat(config.powershell);
    const executable = await fileSystem.realpath(config.executable);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !executableInfo.isFile() || executableInfo.isSymbolicLink()
      || !samePath(executable, config.executable) || !allowedExecutable(executable, config.officialRoots)) throw new Error('Unsafe scan executable or root');
    if (!powershellInfo.isFile() || powershellInfo.isSymbolicLink() || !samePath(await fileSystem.realpath(config.powershell), config.powershell)) {
      throw new Error('Unavailable trusted ACL validator');
    }
    await assertPrivateAcl(root);
    return { root, executable };
  };
  return Object.freeze({ ready, async scan(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 10 * 1024 * 1024) {
      throw new ApiError(400, 'Invalid attachment scan data');
    }
    if (activeScans >= 2) throw new ApiError(503, 'Attachment scanning is busy; retry the upload');
    activeScans += 1;
    let directory;
    let root;
    try {
      const checked = await ready();
      root = checked.root;
      const executable = checked.executable;
      directory = await fileSystem.mkdtemp(windowsPath.join(root, 'pcn-attachment-'));
      await assertPrivateDirectory(fileSystem, directory, root);
      await fileSystem.chmod(directory, 0o700);
      await assertPrivateAcl(directory);
      const filePath = windowsPath.join(directory, `${crypto.randomUUID()}.bin`);
      await fileSystem.writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
      const result = await execute(executable, ['-Scan', '-ScanType', '3', '-File', filePath, '-DisableRemediation'], limits);
      if (result?.exitCode !== 0) throw new Error('Attachment scan did not complete cleanly');
      return 'clean';
    } catch {
      throw new ApiError(503, 'Attachment could not be cleared by malware scanning; upload was rejected');
    } finally {
      try {
        if (directory && containedDirectory(directory, root)) {
          await assertPrivateDirectory(fileSystem, directory, root);
          await fileSystem.rm(directory, { recursive: true, force: true });
        }
      } catch {
        throw new ApiError(503, 'Attachment scan cleanup failed; upload was rejected');
      } finally {
        activeScans -= 1;
      }
    }
  } });
}

module.exports = { createAttachmentScanner, readScannerConfiguration };
