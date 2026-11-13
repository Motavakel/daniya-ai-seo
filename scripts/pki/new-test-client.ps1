param(
    [string]$Name = 'wordpress-local'
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) { throw 'OpenSSL is not available in PATH.' }
if ($Name -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw 'Invalid test client name.' }
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$OutputDir = Join-Path $ProjectRoot ".local\pki\test-clients\$Name"
if (Test-Path $OutputDir) { throw "Test client already exists: $OutputDir" }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
& openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out (Join-Path $OutputDir 'client.key')
if ($LASTEXITCODE -ne 0) { throw 'Could not generate test client private key.' }
& openssl req -new -key (Join-Path $OutputDir 'client.key') -sha256 -subj "/CN=$Name" -out (Join-Path $OutputDir 'client.csr')
if ($LASTEXITCODE -ne 0) { throw 'Could not generate test client CSR.' }
Write-Host "Test client key and CSR created at $OutputDir"
Write-Host 'The private key must never be sent to the Gateway.' -ForegroundColor Yellow
