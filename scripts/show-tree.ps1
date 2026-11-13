
param(
    [string]$Path = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputFile
)

$ErrorActionPreference = 'Stop'

$IgnoredNames = @(
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    'coverage',
    '.turbo',
    'vendor',
    '.local'
)

$Root = (Resolve-Path -LiteralPath $Path).Path
$RootItem = Get-Item -LiteralPath $Root

$Lines = [System.Collections.Generic.List[string]]::new()
$Lines.Add($RootItem.Name)

function Add-TreeLines {
    param(
        [string]$CurrentPath,
        [string]$Prefix,
        [System.Collections.Generic.List[string]]$Lines
    )

    $Items = @(
        Get-ChildItem -LiteralPath $CurrentPath -Force |
        Where-Object { $IgnoredNames -notcontains $_.Name } |
        Sort-Object @{
            Expression = {
                if ($_.PSIsContainer) { 0 } else { 1 }
            }
        }, Name
    )

    for ($i = 0; $i -lt $Items.Count; $i++) {
        $Item = $Items[$i]
        $IsLast = ($i -eq $Items.Count - 1)

        if ($IsLast) {
            $Connector = '+-- '
            $NextPrefix = "$Prefix    "
        }
        else {
            $Connector = '|-- '
            $NextPrefix = "$Prefix|   "
        }

        $Lines.Add("$Prefix$Connector$($Item.Name)")

        if ($Item.PSIsContainer) {
            Add-TreeLines `
                -CurrentPath $Item.FullName `
                -Prefix $NextPrefix `
                -Lines $Lines
        }
    }
}

Add-TreeLines -CurrentPath $Root -Prefix '' -Lines $Lines

if ($OutputFile) {
    $Target = if ([IO.Path]::IsPathRooted($OutputFile)) {
        $OutputFile
    }
    else {
        Join-Path $Root $OutputFile
    }

    [IO.File]::WriteAllLines(
        $Target,
        $Lines.ToArray(),
        [Text.UTF8Encoding]::new($false)
    )

    Write-Host "Tree saved to: $Target" -ForegroundColor Green
}
else {
    $Lines
}
