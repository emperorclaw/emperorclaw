# Test installer outcomes without changing Docker, installing packages, or networking.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$global:installerFixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$target = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force "$global:installerFixtureRoot/scripts" | Out-Null
foreach ($file in @('install.ps1', 'install.sh', '.env.example', 'docker-compose.yml', 'Caddyfile', 'scripts/update.sh', 'scripts/update.ps1', 'scripts/backup-db.sh', 'scripts/backup-db.ps1')) {
    Copy-Item (Join-Path $repoRoot $file) (Join-Path $global:installerFixtureRoot $file)
}
function global:docker {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'run') { '123' }
}
function global:Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec)
    if ($OutFile) { $relative = ($Uri -split '/main/')[1]; Copy-Item (Join-Path $global:installerFixtureRoot $relative) $OutFile }
    else { @{StatusCode=200} }
}
try {
    & (Join-Path $global:installerFixtureRoot 'install.ps1') -InstallDir $target -NoBrowser
    $before = Get-Content (Join-Path $target '.env') -Raw
    foreach ($name in @('NEXTAUTH_SECRET', 'EMPEROR_CLAW_MASTER_KEY', 'POSTGRES_PASSWORD')) {
        if ($before -notmatch "(?m)^$name=[a-f0-9]{64}\r?$" ) { throw "Missing $name" }
    }
    if ($before -notmatch '(?m)^DOCKER_GID=123\r?$') { throw 'Socket group not recorded' }
    Add-Content (Join-Path $target '.env') 'COMPOSE_PROFILES=drive'
    & (Join-Path $global:installerFixtureRoot 'install.ps1') -InstallDir $target -NoBrowser -Domain claw.example.com
    $after = Get-Content (Join-Path $target '.env') -Raw
    if ($after -notmatch 'COMPOSE_PROFILES=drive,https') { throw 'Existing profiles not retained' }
    foreach ($name in @('NEXTAUTH_SECRET', 'EMPEROR_CLAW_MASTER_KEY', 'POSTGRES_PASSWORD')) {
        $oldValue = $before -split "`n" | Where-Object { $_ -like "$name=*" }
        $newValue = $after -split "`n" | Where-Object { $_ -like "$name=*" }
        if ($oldValue -ne $newValue) { throw "$name changed on rerun" }
    }
    Write-Output 'PowerShell fresh install, rerun, and HTTPS configuration checks passed.'
} finally {
    Set-Location $repoRoot
    Remove-Item -Recurse -Force $global:installerFixtureRoot, $target
    Remove-Item Function:\docker, Function:\Invoke-WebRequest
}
