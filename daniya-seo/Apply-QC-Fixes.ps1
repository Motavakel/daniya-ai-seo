$ErrorActionPreference = 'Stop'

# Run this script from the project root after extracting this patch over the project.
$legacyRepositories = Join-Path (Get-Location) 'src/infrastructure/repositories'
$backupRoot = Join-Path (Get-Location) 'qc-backup'
$backupPath = Join-Path $backupRoot 'legacy-infrastructure-repositories'

if (Test-Path $legacyRepositories) {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

    if (Test-Path $backupPath) {
        throw "Backup already exists: $backupPath. Rename or remove it before running this script."
    }

    Move-Item -Path $legacyRepositories -Destination $backupPath
    Write-Host "Moved obsolete repository folder to: $backupPath"
}
else {
    Write-Host 'No obsolete src/infrastructure/repositories folder found.'
}

Write-Host 'QC patch files are in place.'
Write-Host 'Next run: npm run build'
