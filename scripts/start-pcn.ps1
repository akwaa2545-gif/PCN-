param([string]$CredentialPath = (Join-Path $env:LOCALAPPDATA 'SupplierPCN/sql-credential.xml'), [int]$Port = 3000)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($CredentialPath)) { throw 'CredentialPath must be absolute.' }
$env:PCN_SQL_CREDENTIAL_PATH = $CredentialPath
$env:PORT = [string]$Port
if (-not $env:PUBLIC_ORIGIN) { $env:PUBLIC_ORIGIN = "http://localhost:$Port" }
node (Join-Path $PSScriptRoot '../server.js')
