param(
    [string]$Domain = "gateway.local"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) {
    throw "OpenSSL is not installed or is not available in PATH."
}

if ($Domain -notmatch '^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$') {
    throw "Invalid DNS domain: $Domain"
}

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$PkiRoot = Join-Path $ProjectRoot '.local\pki'
$RootDir = Join-Path $PkiRoot 'root-ca'
$ClientDir = Join-Path $PkiRoot 'client-ca'
$ServerDir = Join-Path $PkiRoot 'server-ca'
$GatewayDir = Join-Path $PkiRoot 'gateway'

$Expected = @(
    (Join-Path $RootDir 'certs\ca.cert.pem'),
    (Join-Path $RootDir 'private\ca.key.pem'),
    (Join-Path $ClientDir 'certs\ca.cert.pem'),
    (Join-Path $ClientDir 'private\ca.key.pem'),
    (Join-Path $ServerDir 'certs\ca.cert.pem'),
    (Join-Path $ServerDir 'private\ca.key.pem'),
    (Join-Path $GatewayDir 'gateway.key')
)
if ($Expected | Where-Object { Test-Path $_ }) {
    throw "A Daniya PKI file already exists. Refusing to overwrite CA identity. Remove .local/pki manually only when you intend to replace the entire local PKI."
}

function Read-SecretText([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Invoke-OpenSSL([string[]]$Arguments, [string]$WorkingDirectory) {
    Push-Location $WorkingDirectory
    try {
        $output = & openssl @Arguments 2>&1
        $exitCode = $LASTEXITCODE
        $output | ForEach-Object { Write-Host $_ }
        if ($exitCode -ne 0) {
            throw "OpenSSL failed with exit code ${exitCode}: openssl $($Arguments -join ' ')"        
        }
    }
    finally { Pop-Location }
}

function Initialize-CaDirectory([string]$Directory, [string]$ConfigSource) {
    New-Item -ItemType Directory -Force -Path `
    (Join-Path $Directory 'certs'), `
    (Join-Path $Directory 'crl'), `
    (Join-Path $Directory 'newcerts'), `
    (Join-Path $Directory 'private') | Out-Null
    Copy-Item $ConfigSource (Join-Path $Directory 'openssl.cnf')
    Write-Utf8NoBom (Join-Path $Directory 'index.txt') ''
    Write-Utf8NoBom (Join-Path $Directory 'serial') '1000' 
    Write-Utf8NoBom (Join-Path $Directory 'crlnumber') '1000'
}

$RootPassphrase = Read-SecretText 'Root CA passphrase (minimum 16 characters)'
$ClientPassphrase = Read-SecretText 'Client Intermediate CA passphrase (minimum 16 characters)'
$ServerPassphrase = Read-SecretText 'Server Intermediate CA passphrase (minimum 16 characters)'

if ($RootPassphrase.Length -lt 16 -or $ClientPassphrase.Length -lt 16 -or $ServerPassphrase.Length -lt 16) {
    throw 'All CA passphrases must contain at least 16 characters.'
}

$configRoot = Join-Path $PSScriptRoot 'config'
New-Item -ItemType Directory -Force -Path $PkiRoot | Out-Null
Initialize-CaDirectory $RootDir (Join-Path $configRoot 'root-ca.cnf')
Initialize-CaDirectory $ClientDir (Join-Path $configRoot 'intermediate-ca.cnf')
Initialize-CaDirectory $ServerDir (Join-Path $configRoot 'intermediate-ca.cnf')
New-Item -ItemType Directory -Force -Path $GatewayDir | Out-Null

$env:ROOT_CA_PASSPHRASE = $RootPassphrase
$env:CLIENT_CA_PASSPHRASE = $ClientPassphrase
$env:SERVER_CA_PASSPHRASE = $ServerPassphrase

try {
    Invoke-OpenSSL @(
        'genpkey', '-algorithm', 'RSA', '-aes-256-cbc', '-pkeyopt', 'rsa_keygen_bits:4096',
        '-pass', 'env:ROOT_CA_PASSPHRASE', '-out', 'private/ca.key.pem'
    ) $RootDir
    Invoke-OpenSSL @(
        'req', '-x509', '-new', '-key', 'private/ca.key.pem', '-passin', 'env:ROOT_CA_PASSPHRASE',
        '-sha256', '-days', '3650', '-config', 'openssl.cnf', '-extensions', 'v3_root_ca',
        '-out', 'certs/ca.cert.pem'
    ) $RootDir

    foreach ($item in @(
            @{ Name = 'Client'; Dir = $ClientDir; Pass = 'CLIENT_CA_PASSPHRASE'; Subject = 'Daniya Client Intermediate CA'; Env = 'CLIENT_CA_PASSPHRASE' },
            @{ Name = 'Server'; Dir = $ServerDir; Pass = 'SERVER_CA_PASSPHRASE'; Subject = 'Daniya Server Intermediate CA'; Env = 'SERVER_CA_PASSPHRASE' }
        )) {
        $csrName = 'private/ca.csr.pem'
        Invoke-OpenSSL @(
            'genpkey', '-algorithm', 'RSA', '-aes-256-cbc', '-pkeyopt', 'rsa_keygen_bits:4096',
            '-pass', "env:$($item.Env)", '-out', 'private/ca.key.pem'
        ) $item.Dir
        Invoke-OpenSSL @(
            'req', '-new', '-key', 'private/ca.key.pem', '-passin', "env:$($item.Env)",
            '-sha256', '-subj', "/CN=$($item.Subject)", '-out', $csrName
        ) $item.Dir
        Invoke-OpenSSL @(
            'ca', '-config', (Join-Path $RootDir 'openssl.cnf'),
            '-in', (Join-Path $item.Dir $csrName),
            '-out', (Join-Path $item.Dir 'certs/ca.cert.pem'),
            '-extensions', 'v3_intermediate_ca', '-days', '1825', '-batch', '-notext', '-md', 'sha256',
            '-rand_serial', '-passin', 'env:ROOT_CA_PASSPHRASE'
        ) $RootDir
        Remove-Item (Join-Path $item.Dir $csrName) -Force
    }

    Invoke-OpenSSL @(
        'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', 'gateway.key'
    ) $GatewayDir
    Invoke-OpenSSL @(
        'req', '-new', '-key', 'gateway.key', '-sha256', '-subj', "/CN=$Domain", '-out', 'gateway.csr'
    ) $GatewayDir

    $gatewayExtensions = @"
[server_cert]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer

[alt_names]
DNS.1 = $Domain
DNS.2 = localhost
IP.1 = 127.0.0.1
"@
    Write-Utf8NoBom (Join-Path $GatewayDir 'gateway-extensions.cnf') $gatewayExtensions

    Invoke-OpenSSL @(
        'ca', '-config', (Join-Path $ServerDir 'openssl.cnf'),
        '-in', (Join-Path $GatewayDir 'gateway.csr'),
        '-out', (Join-Path $GatewayDir 'gateway-leaf.crt'),
        '-extfile', (Join-Path $GatewayDir 'gateway-extensions.cnf'),
        '-extensions', 'server_cert', '-days', '365', '-batch', '-notext', '-md', 'sha256',
        '-rand_serial', '-passin', 'env:SERVER_CA_PASSPHRASE'
    ) $ServerDir

    $leaf = [IO.File]::ReadAllText((Join-Path $GatewayDir 'gateway-leaf.crt')).Trim()
    $intermediate = [IO.File]::ReadAllText((Join-Path $ServerDir 'certs/ca.cert.pem')).Trim()
    Write-Utf8NoBom (Join-Path $GatewayDir 'gateway.fullchain.pem') ($leaf + "`n" + $intermediate + "`n")
    Remove-Item (Join-Path $GatewayDir 'gateway.csr'), (Join-Path $GatewayDir 'gateway-extensions.cnf') -Force

    Invoke-OpenSSL @(
        'verify', '-CAfile', (Join-Path $RootDir 'certs/ca.cert.pem'),
        '-untrusted', (Join-Path $ServerDir 'certs/ca.cert.pem'),
        (Join-Path $GatewayDir 'gateway-leaf.crt')
    ) $ProjectRoot
    Invoke-OpenSSL @(
        'verify', '-CAfile', (Join-Path $RootDir 'certs/ca.cert.pem'),
        (Join-Path $ClientDir 'certs/ca.cert.pem')
    ) $ProjectRoot

    Write-Host ''
    Write-Host 'Local Daniya PKI generated successfully.' -ForegroundColor Green
    Write-Host "PKI directory: $PkiRoot"
    Write-Host "Gateway URL: https://$Domain"
    Write-Host "Enrollment URL: https://${Domain}:8444/oauth/enroll"
    Write-Host 'Do not commit .local/pki or CA passphrases.' -ForegroundColor Yellow
}
finally {
    Remove-Item Env:ROOT_CA_PASSPHRASE -ErrorAction SilentlyContinue
    Remove-Item Env:CLIENT_CA_PASSPHRASE -ErrorAction SilentlyContinue
    Remove-Item Env:SERVER_CA_PASSPHRASE -ErrorAction SilentlyContinue
    $RootPassphrase = $null
    $ClientPassphrase = $null
    $ServerPassphrase = $null
}
