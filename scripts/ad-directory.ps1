$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Escape-LdapValue([string]$Value) {
    return $Value.Replace('\', '\5c').Replace('*', '\2a').Replace('(', '\28').Replace(')', '\29').Replace([string][char]0, '\00')
}

function New-AuthenticatedDirectoryEntry([string]$Path, [System.DirectoryServices.AuthenticationTypes]$Authentication) {
    # PowerShell coerces null string constructor arguments to empty credentials, causing anonymous LDAP binds.
    $entry = [System.DirectoryServices.DirectoryEntry]::new($Path)
    $entry.psbase.AuthenticationType = $Authentication
    return $entry
}

try {
    $requestText = [Console]::In.ReadToEnd()
    if ($requestText.Length -gt 2048) { throw 'Request too large' }
    $request = $requestText | ConvertFrom-Json
    if ($request.domain -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$') { throw 'Invalid domain' }
    $value = [string]$request.value
    $limit = if ($request.operation -eq 'search') { 20 } else { 2 }
    $expirationNow = [DateTime]::UtcNow.ToFileTimeUtc()
    $active = '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(|(accountExpires=0)(accountExpires=9223372036854775807)(accountExpires>=' + $expirationNow + '))'
    switch ($request.operation) {
        'search' {
            if ($value.Length -lt 2 -or $value.Length -gt 100) { throw 'Invalid search' }
            $escaped = Escape-LdapValue $value
            $filter = $active + "(|(sAMAccountName=*$escaped*)(displayName=*$escaped*)(mail=*$escaped*)))"
        }
        'sam' {
            if ($value -notmatch '^[A-Za-z0-9._-]{1,20}$') { throw 'Invalid account' }
            $filter = $active + '(sAMAccountName=' + (Escape-LdapValue $value) + '))'
        }
        'id' {
            $guid = [Guid]::Parse($value)
            $escapedGuid = ($guid.ToByteArray() | ForEach-Object { '\' + $_.ToString('x2') }) -join ''
            $filter = $active + '(objectGUID=' + $escapedGuid + '))'
        }
        default { throw 'Unsupported directory operation' }
    }
    $secureAuthentication = [System.DirectoryServices.AuthenticationTypes]::Secure -bor [System.DirectoryServices.AuthenticationTypes]::Signing -bor [System.DirectoryServices.AuthenticationTypes]::Sealing
    $root = New-AuthenticatedDirectoryEntry -Path ('LDAP://' + $request.domain + '/RootDSE') -Authentication $secureAuthentication
    $base = New-AuthenticatedDirectoryEntry -Path ('LDAP://' + $request.domain + '/' + [string]$root.Properties['defaultNamingContext'][0]) -Authentication $secureAuthentication
    $searcher = [System.DirectoryServices.DirectorySearcher]::new($base)
    $searcher.Filter = $filter
    $searcher.SizeLimit = $limit
    $searcher.ClientTimeout = [TimeSpan]::FromSeconds(10)
    $searcher.ServerTimeLimit = [TimeSpan]::FromSeconds(10)
    $searcher.ReferralChasing = [System.DirectoryServices.ReferralChasingOption]::None
    foreach ($property in @('objectGUID', 'objectSid', 'sAMAccountName', 'displayName', 'mail', 'department')) { [void]$searcher.PropertiesToLoad.Add($property) }
    $found = $searcher.FindAll()
    $employees = @($found | ForEach-Object {
        $properties = $_.Properties
        [ordered]@{
            directoryId = [Guid]::new([byte[]]$properties['objectguid'][0]).ToString()
            adSid = [System.Security.Principal.SecurityIdentifier]::new([byte[]]$properties['objectsid'][0], 0).Value
            samAccountName = [string]$properties['samaccountname'][0]
            displayName = [string]$properties['displayname'][0]
            email = [string]$properties['mail'][0]
            adDepartment = [string]$properties['department'][0]
            isActive = $true
        }
    })
    [Console]::Out.Write((ConvertTo-Json -InputObject $employees -Compress -Depth 3))
} catch {
    [Console]::Error.Write('Directory query failed')
    exit 1
} finally {
    if ($found) { $found.Dispose() }
    if ($searcher) { $searcher.Dispose() }
    if ($base) { $base.psbase.Dispose() }
    if ($root) { $root.psbase.Dispose() }
}
