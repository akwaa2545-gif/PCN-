#requires -Version 5.1
[CmdletBinding()]
param([switch]$ValidateOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Base = 'C:\SupplierPCN'
$script:Deployment = Join-Path $script:Base 'deployment'
$script:Repository = 'akwaa2545-gif/PCN-'
$script:ServiceName = 'SupplierPCNTest'
$script:MaximumArchive = 200MB
$script:MaximumExpanded = 500MB
$script:RuntimeFiles = @(
    'server.js', 'package.json', 'package-lock.json',
    'admin.html', 'form.html', 'index.html', 'login.html',
    'app.js', 'admin.js', 'login.js', 'session-client.js', 'master-data.js',
    'auth.css', 'styles.css', 'tokin-header-logo.png',
    'compic20220308153715_T3zHf.png', 'CairoliClassic-Bold.otf',
    'scripts/read-sql-credential.ps1', 'admin-users.js'
)

function Assert-ManagedPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($script:Base + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Path is outside the deployment directory.'
    }
    $ancestor = $full
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Deployment paths must not contain reparse points.'
            }
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    return $full
}

function Set-DeploymentAcl([string]$Path, [switch]$ServiceRead) {
    $full = Assert-ManagedPath $Path
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rights = @{'S-1-5-18' = 'FullControl'; 'S-1-5-32-544' = 'FullControl'}
    if ($ServiceRead) {
        $sid = ([Security.Principal.NTAccount]('NT SERVICE\' + $script:ServiceName)).Translate([Security.Principal.SecurityIdentifier]).Value
        $rights[$sid] = 'ReadAndExecute'
    }
    foreach ($entry in $rights.GetEnumerator()) {
        $sid = New-Object Security.Principal.SecurityIdentifier($entry.Key)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, $entry.Value, 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $full -AclObject $acl
}

function Write-DeploymentLog([string]$Event, [string]$Release = '') {
    # Messages deliberately exclude response bodies, configuration and exception text.
    $line = [ordered]@{time = [DateTime]::UtcNow.ToString('o'); event = $Event; release = $Release} | ConvertTo-Json -Compress
    Add-Content -LiteralPath (Join-Path $script:Deployment 'deployment.log') -Value $line -Encoding UTF8
    Write-Output $line
}

function Get-BoundedHttpsFile([string]$Url, [string]$Destination, [long]$Limit) {
    $allowedHosts = @('api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')
    $current = [Uri]$Url
    for ($redirect = 0; $redirect -le 5; $redirect++) {
        if ($current.Scheme -ne 'https' -or $current.Host -notin $allowedHosts -or $current.UserInfo -or -not $current.IsDefaultPort) {
            throw 'Unexpected release download endpoint.'
        }
        $request = [Net.HttpWebRequest]::Create($current)
        $request.UserAgent = 'SupplierPCNTest-Deployment'
        $request.Accept = 'application/vnd.github+json'
        $request.AllowAutoRedirect = $false
        $request.Timeout = 30000
        $request.ReadWriteTimeout = 30000
        $response = $null
        try {
            $response = $request.GetResponse()
            $status = [int]$response.StatusCode
            if ($status -in @(301, 302, 303, 307, 308)) {
                $current = New-Object Uri($current, $response.Headers['Location'])
                continue
            }
            if ($status -ne 200 -or $response.ContentLength -gt $Limit) { throw 'Release download rejected.' }
            $inputStream = $response.GetResponseStream()
            $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            try {
                $buffer = New-Object byte[] 65536
                $total = 0L
                while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $read
                    if ($total -gt $Limit) { throw 'Release download exceeds its size limit.' }
                    $outputStream.Write($buffer, 0, $read)
                }
            } finally { $outputStream.Dispose(); $inputStream.Dispose() }
            return
        } finally { if ($response) { $response.Dispose() } }
    }
    throw 'Too many release download redirects.'
}

function Get-ReleaseVersion([string]$Tag) {
    if ($Tag -cnotmatch '^pcn-test-([1-9][0-9]{0,8})-([1-9][0-9]{0,5})$') { return $null }
    return [pscustomobject]@{number = [long]$Matches[1]; attempt = [long]$Matches[2]}
}

function Test-NewerVersion($Candidate, $Deployed) {
    if (-not $Deployed) { return $true }
    return $Candidate.number -gt $Deployed.number -or ($Candidate.number -eq $Deployed.number -and $Candidate.attempt -gt $Deployed.attempt)
}

function Get-PcnReleaseAsset($Candidate, [string]$AssetName, [string]$Stage) {
    $assets = @($Candidate.assets | Where-Object { $_.name -ceq $AssetName })
    if ($assets.Count -ne 1) { throw 'Release must have exactly one of each required asset.' }
    $expected = 'https://github.com/' + $script:Repository + '/releases/download/' + $Candidate.tag_name + '/' + $AssetName
    if ($assets[0].browser_download_url -cne $expected) { throw 'Release asset URL is unexpected.' }
    $limit = if ($AssetName -eq 'pcn.zip') { $script:MaximumArchive } else { 64KB }
    Get-BoundedHttpsFile $expected (Join-Path $Stage $AssetName) $limit
}

function Assert-ZipEntry([IO.Compression.ZipArchiveEntry]$Entry, $Seen) {
    $name = $Entry.FullName
    if (-not $name -or $name.Contains('\') -or $name.StartsWith('/') -or $name.Contains(':') -or $name -match '[\x00-\x1f\x7f]') {
        throw 'Unsafe archive entry name.'
    }
    $directory = $name.EndsWith('/')
    $clean = $name.TrimEnd('/')
    if (-not $Seen.Add($clean)) { throw 'Duplicate archive entry.' }
    foreach ($part in $clean.Split('/')) {
        if (-not $part -or $part -in @('.', '..') -or $part.EndsWith('.') -or $part.EndsWith(' ') -or
            $part -match '^(?i:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)' -or $part -match '[<>"|?*]') {
            throw 'Unsafe Windows archive path.'
        }
    }
    $attributes = [long]$Entry.ExternalAttributes -band 0xffffffffL
    $unixType = ($attributes -shr 16) -band 0xf000
    if ($unixType -notin @(0, 0x8000, 0x4000) -or ($attributes -band 0x400)) {
        throw 'Archive links and special files are forbidden.'
    }
    if (($directory -and $Entry.Length -ne 0) -or (-not $directory -and $unixType -eq 0x4000)) {
        throw 'Archive entry type is inconsistent.'
    }
    $allowed = $clean.StartsWith('node_modules/', [StringComparison]::Ordinal) -or
        $clean -cmatch '^src/[A-Za-z][A-Za-z0-9]*\.js$' -or $clean -cin $script:RuntimeFiles
    if ($directory) { $allowed = $clean -cin @('src', 'scripts', 'node_modules') -or $clean.StartsWith('node_modules/', [StringComparison]::Ordinal) }
    if (-not $allowed) { throw 'Archive contains a file outside the runtime allowlist.' }
    return [pscustomobject]@{name = $clean; directory = $directory; entry = $Entry}
}

function Expand-VerifiedArchive([string]$ArchivePath, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $full = Assert-ManagedPath $Destination
    if (Test-Path -LiteralPath $full) { throw 'Extraction destination already exists.' }
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        if ($archive.Entries.Count -gt 40000) { throw 'Archive has too many entries.' }
        $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $fileNames = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $entries = New-Object 'Collections.Generic.List[object]'
        $expanded = 0L
        foreach ($entry in $archive.Entries) {
            $validated = Assert-ZipEntry $entry $seen
            if (-not $validated.directory) { $fileNames.Add($validated.name) | Out-Null }
            $expanded += $entry.Length
            if ($expanded -gt $script:MaximumExpanded -or $entry.Length -gt 100MB) { throw 'Archive expansion exceeds its size limit.' }
            $entries.Add($validated)
        }
        foreach ($required in @('server.js', 'package.json', 'package-lock.json', 'src/runtimeEnv.js', 'src/httpServer.js', 'login.html')) {
            if (-not $seen.Contains($required)) { throw 'Archive is missing a required runtime file.' }
        }
        foreach ($entry in $entries) {
            $parent = [IO.Path]::GetDirectoryName($entry.name.Replace('/', '\'))
            while ($parent) {
                $normalized = $parent.Replace('\', '/')
                if ($fileNames.Contains($normalized)) { throw 'Archive contains conflicting directory and file entries.' }
                $parent = [IO.Path]::GetDirectoryName($parent)
            }
        }
        New-Item -ItemType Directory -Path $full | Out-Null
        $actualExpanded = 0L
        foreach ($entry in $entries) {
            $target = [IO.Path]::GetFullPath((Join-Path $full $entry.name.Replace('/', '\')))
            if (-not $target.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes its destination.' }
            if ($entry.directory) { New-Item -ItemType Directory -Path $target -Force | Out-Null; continue }
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
            $sourceStream = $entry.entry.Open()
            $targetStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            try {
                $buffer = New-Object byte[] 65536
                $fileBytes = 0L
                while (($read = $sourceStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $fileBytes += $read; $actualExpanded += $read
                    if ($fileBytes -gt $entry.entry.Length -or $actualExpanded -gt $script:MaximumExpanded) { throw 'Archive stream exceeds declared size.' }
                    $targetStream.Write($buffer, 0, $read)
                }
                if ($fileBytes -ne $entry.entry.Length) { throw 'Archive stream length does not match its directory.' }
            } finally { $sourceStream.Dispose(); $targetStream.Dispose() }
        }
    } finally { $archive.Dispose() }
}

function Wait-PcnReady {
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        try {
            $response = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/ready' -Headers @{'X-PCN-Client-IP' = '127.0.0.1'} -TimeoutSec 3
            if ($response.success -eq $true -and $response.data.status -eq 'ready' -and (Get-Service $script:ServiceName).Status -eq 'Running') { return }
        } catch { }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'PCN SQL readiness did not pass.'
}

function Assert-PcnBackend([string]$ReleaseDirectory) {
    $listeners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction Stop)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') { throw 'Unexpected backend listener.' }
    $service = Get-CimInstance Win32_Service -Filter "Name='SupplierPCNTest'"
    if ($service.StartName -ine 'NT AUTHORITY\NetworkService' -or $service.State -ne 'Running') { throw 'Unexpected backend service identity.' }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listeners[0].OwningProcess)
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner
    $server = [Regex]::Escape((Join-Path $ReleaseDirectory 'server.js'))
    if ($process.ParentProcessId -ne $service.ProcessId -or $process.ExecutablePath -ine 'C:\Program Files\nodejs\node.exe' -or
        $process.CommandLine -notmatch ('(?:^|\s)"?' + $server + '"?\s*$') -or
        $owner.ReturnValue -ne 0 -or $owner.Domain -ine 'NT AUTHORITY' -or $owner.User -ine 'NETWORK SERVICE') {
        throw 'Backend listener does not belong to the intended release and service.'
    }
}

function Set-ReleaseAcl([string]$ReleaseDirectory) {
    $full = Assert-ManagedPath $ReleaseDirectory
    Set-DeploymentAcl $full -ServiceRead
    # Reset children after a same-volume move: inherited staging ACLs can survive rename.
    $null = & "$env:SystemRoot\System32\icacls.exe" ($full + '\*') /reset /T /Q
    if ($LASTEXITCODE -ne 0) { throw 'Release child ACL reset failed.' }
    $serviceSid = ([Security.Principal.NTAccount]('NT SERVICE\' + $script:ServiceName)).Translate([Security.Principal.SecurityIdentifier]).Value
    foreach ($relative in @('server.js', 'src\runtimeEnv.js', 'node_modules')) {
        $path = Join-Path $full $relative
        if (-not (Test-Path -LiteralPath $path)) { throw 'Required release ACL target is missing.' }
        $rules = (Get-Acl -LiteralPath $path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
        $readRule = @($rules | Where-Object { $_.IdentityReference.Value -eq $serviceSid -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq [Security.AccessControl.FileSystemRights]::ReadAndExecute })
        if ($readRule.Count -eq 0) { throw 'Service cannot read the protected release.' }
        foreach ($rule in $rules) {
            if ($rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544', $serviceSid)) { throw 'Release ACL contains an unexpected principal.' }
            if ($rule.IdentityReference.Value -eq $serviceSid -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write)) { throw 'Application service can modify its release.' }
        }
    }
}

function Stop-PcnService {
    Stop-Service -Name $script:ServiceName
    (Get-Service $script:ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(40))
    if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { throw 'The old backend listener is still active.' }
}

function Write-AtomicFile([string]$Path, [byte[]]$Bytes) {
    $full = Assert-ManagedPath $Path
    $temporary = $full + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllBytes($temporary, $Bytes)
    try {
        if (Test-Path -LiteralPath $full) { [IO.File]::Replace($temporary, $full, [Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $full) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Invoke-PcnCutover($Manifest, [string]$ReleaseDirectory, [string]$StatePath) {
    $xmlPath = Assert-ManagedPath (Join-Path $script:Base 'service\SupplierPCNTest.xml')
    $oldBytes = [IO.File]::ReadAllBytes($xmlPath)
    $document = New-Object Xml.XmlDocument
    $document.XmlResolver = $null
    $readerSettings = New-Object Xml.XmlReaderSettings
    $readerSettings.DtdProcessing = 'Prohibit'
    $reader = [Xml.XmlReader]::Create($xmlPath, $readerSettings)
    try { $document.Load($reader) } finally { $reader.Dispose() }
    if ($document.service.id -ne $script:ServiceName -or -not $document.service.arguments -or -not $document.service.workingdirectory) {
        throw 'The installed service XML is unexpected.'
    }
    $oldDirectory = [string]$document.service.workingdirectory
    $document.SelectSingleNode('/service/arguments').InnerText = '"' + (Join-Path $ReleaseDirectory 'server.js') + '"'
    $document.SelectSingleNode('/service/workingdirectory').InnerText = $ReleaseDirectory
    $utf8 = New-Object Text.UTF8Encoding($false)
    $changed = $false
    try {
        $changed = $true
        Stop-PcnService
        Write-AtomicFile $xmlPath ($utf8.GetBytes($document.OuterXml))
        Start-Service -Name $script:ServiceName
        Wait-PcnReady
        Assert-PcnBackend $ReleaseDirectory
        $state = [ordered]@{schemaVersion = 1; repository = $script:Repository; releaseId = $Manifest.releaseId; runNumber = $Manifest.runNumber; runAttempt = $Manifest.runAttempt; commit = $Manifest.commit; deployedAt = [DateTime]::UtcNow.ToString('o')}
        Write-AtomicFile $StatePath ($utf8.GetBytes(($state | ConvertTo-Json)))
    } catch {
        try { Write-DeploymentLog 'deployment_failed' $Manifest.releaseId } catch { }
        if ($changed) {
            try {
                Stop-Service -Name $script:ServiceName -ErrorAction SilentlyContinue
                (Get-Service $script:ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(40))
                Write-AtomicFile $xmlPath $oldBytes
                Start-Service -Name $script:ServiceName
                Wait-PcnReady
                Assert-PcnBackend $oldDirectory
                Write-DeploymentLog 'rollback_ready' $Manifest.releaseId
            } catch { Write-DeploymentLog 'rollback_failed_operator_required' $Manifest.releaseId }
        }
        throw 'Deployment failed; inspect the deployment event log and service status.'
    }
    Write-DeploymentLog 'deployed' $Manifest.releaseId
}

function Invoke-PcnDeployment {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $deployment = Assert-ManagedPath $script:Deployment
    foreach ($required in @('verify-release.js', 'release-signing-public.pem')) {
        if (-not (Test-Path -LiteralPath (Join-Path $deployment $required) -PathType Leaf)) { throw 'Pinned release verification files are missing.' }
        Assert-ManagedPath (Join-Path $deployment $required) | Out-Null
    }
    Set-DeploymentAcl $deployment
    $stagingParent = Assert-ManagedPath (Join-Path $script:Base 'staging')
    New-Item -ItemType Directory -Path $stagingParent -Force | Out-Null
    Set-DeploymentAcl $stagingParent
    $stage = Join-Path $stagingParent ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $apiPath = Join-Path $stage 'releases.json'
        Get-BoundedHttpsFile ('https://api.github.com/repos/' + $script:Repository + '/releases?per_page=20') $apiPath 2MB
        $releases = Get-Content -LiteralPath $apiPath -Raw | ConvertFrom-Json
        $candidate = $releases | Where-Object { -not $_.draft -and $_.prerelease -and (Get-ReleaseVersion $_.tag_name) } |
            Sort-Object @{Expression = {(Get-ReleaseVersion $_.tag_name).number}; Descending = $true}, @{Expression = {(Get-ReleaseVersion $_.tag_name).attempt}; Descending = $true} | Select-Object -First 1
        if (-not $candidate) { Write-DeploymentLog 'no_release'; return }
        $version = Get-ReleaseVersion $candidate.tag_name
        $statePath = Join-Path $deployment 'last-deployed.json'
        $previous = $null
        if (Test-Path -LiteralPath $statePath) {
            $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            if ($state.schemaVersion -ne 1 -or $state.repository -ne $script:Repository) { throw 'Deployment state is invalid.' }
            $previous = Get-ReleaseVersion $state.releaseId
            if (-not $previous -or $previous.number -ne $state.runNumber -or $previous.attempt -ne $state.runAttempt) { throw 'Deployment state version is invalid.' }
        }
        if (-not (Test-NewerVersion $version $previous)) { Write-DeploymentLog 'already_current' $candidate.tag_name; return }
        $attemptPath = Join-Path $deployment 'last-attempt.json'
        if (Test-Path -LiteralPath $attemptPath) {
            $attempt = Get-Content -LiteralPath $attemptPath -Raw | ConvertFrom-Json
            $attemptVersion = Get-ReleaseVersion $attempt.releaseId
            if ($attempt.schemaVersion -ne 1 -or $attempt.repository -ne $script:Repository -or -not $attemptVersion -or
                $attemptVersion.number -ne $attempt.runNumber -or $attemptVersion.attempt -ne $attempt.runAttempt) {
                throw 'Deployment attempt record is invalid.'
            }
            if (-not (Test-NewerVersion $version $attemptVersion)) { Write-DeploymentLog 'previous_attempt_requires_new_release' $candidate.tag_name; return }
        }
        foreach ($assetName in @('manifest.json', 'manifest.sig')) { Get-PcnReleaseAsset $candidate $assetName $stage }
        $node = 'C:\Program Files\nodejs\node.exe'
        $authenticated = & $node (Join-Path $deployment 'verify-release.js') --manifest-only --manifest (Join-Path $stage 'manifest.json') --signature (Join-Path $stage 'manifest.sig') --public-key (Join-Path $deployment 'release-signing-public.pem') 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Release manifest signature verification failed.' }
        $authenticatedManifest = $authenticated | ConvertFrom-Json
        if ($authenticatedManifest.releaseId -cne $candidate.tag_name -or $authenticatedManifest.runNumber -ne $version.number -or $authenticatedManifest.runAttempt -ne $version.attempt) { throw 'Signed version does not match the release tag.' }
        Get-PcnReleaseAsset $candidate 'pcn.zip' $stage
        $verified = & $node (Join-Path $deployment 'verify-release.js') --manifest (Join-Path $stage 'manifest.json') --signature (Join-Path $stage 'manifest.sig') --archive (Join-Path $stage 'pcn.zip') --public-key (Join-Path $deployment 'release-signing-public.pem') 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Release signature, manifest or archive hash verification failed.' }
        $manifest = $verified | ConvertFrom-Json
        if ($manifest.releaseId -cne $candidate.tag_name -or $manifest.runNumber -ne $version.number -or $manifest.runAttempt -ne $version.attempt) { throw 'Signed version does not match the release tag.' }
        $runtime = Join-Path $stage 'runtime'
        Expand-VerifiedArchive (Join-Path $stage 'pcn.zip') $runtime
        if ($ValidateOnly) { Write-DeploymentLog 'validated_only' $manifest.releaseId; return }
        $releaseDirectory = Assert-ManagedPath (Join-Path $script:Base ('releases\' + $manifest.releaseId))
        if (Test-Path -LiteralPath $releaseDirectory) { throw 'Release directory already exists; operator inspection required.' }
        Move-Item -LiteralPath $runtime -Destination $releaseDirectory
        Set-ReleaseAcl $releaseDirectory
        $attemptRecord = [ordered]@{schemaVersion = 1; repository = $script:Repository; releaseId = $manifest.releaseId; runNumber = $manifest.runNumber; runAttempt = $manifest.runAttempt; commit = $manifest.commit; attemptedAt = [DateTime]::UtcNow.ToString('o')}
        $utf8 = New-Object Text.UTF8Encoding($false)
        Write-AtomicFile $attemptPath ($utf8.GetBytes(($attemptRecord | ConvertTo-Json)))
        Invoke-PcnCutover $manifest $releaseDirectory $statePath
    } finally {
        # Staging is private to this invocation; its contents are downloads or checked ZIP entries.
        $checked = Assert-ManagedPath $stage
        if (-not $checked.StartsWith($stagingParent + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Staging cleanup path is invalid.' }
        if (Test-Path -LiteralPath $checked) { Remove-Item -LiteralPath $checked -Recurse -Force }
    }
}

# Dot-source only for isolated function fixtures; no production operation occurs.
if ($MyInvocation.InvocationName -eq '.') { return }
$mutex = New-Object Threading.Mutex($false, 'Global\SupplierPCNTestDeployment')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { exit 0 }
    Invoke-PcnDeployment
} catch {
    try { Write-DeploymentLog 'poll_failed_operator_inspection' } catch { }
    Write-Error 'PCN release deployment failed. Inspect the protected deployment log.'
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
