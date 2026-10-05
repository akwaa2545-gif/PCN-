param([Parameter(Mandatory=$true)][string]$CredentialPath)
$ErrorActionPreference = 'Stop'
$config = Import-Clixml -LiteralPath $CredentialPath
if ($config -is [System.Management.Automation.PSCredential]) { $credential=$config; $trust=$false }
else { $credential=$config.Credential; $trust=[bool]$config.TrustServerCertificate }
if ($credential -isnot [System.Management.Automation.PSCredential]) { throw 'Invalid protected SQL credential.' }
@{ username=$credential.UserName; password=$credential.GetNetworkCredential().Password; trustServerCertificate=$trust } | ConvertTo-Json -Compress
