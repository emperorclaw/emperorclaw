# EmperorClaw — Pre-update database backup
# Usage:
#   .\scripts\backup-db.ps1
#   .\scripts\backup-db.ps1 -Output "C:\backups\emperorclaw-backup.sql"
#
# Requires: pg_dump (PostgreSQL client tools)
# Reads POSTGRES_CONNECTION_STRING from .env if not set in environment.

param([string]$Output = "")

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent $ScriptDir

# ── Resolve connection string ──────────────────────────────────
if (-not $env:POSTGRES_CONNECTION_STRING) {
    $envFile = Join-Path $RepoDir ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^POSTGRES_CONNECTION_STRING=(.+)$') {
                $env:POSTGRES_CONNECTION_STRING = $matches[1]
            }
        }
    }
}

if (-not $env:POSTGRES_CONNECTION_STRING) {
    Write-Host "POSTGRES_CONNECTION_STRING is not set. Set it in .env or export it." -ForegroundColor Red
    exit 1
}

# ── Output path ─────────────────────────────────────────────────
if (-not $Output) {
    $Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $Output = Join-Path $RepoDir "backups\emperorclaw-backup-$Timestamp.sql"
}

$OutputDir = Split-Path -Parent $Output
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

Write-Host "Backing up EmperorClaw database..." -ForegroundColor Yellow
Write-Host "  Output: $Output"

try {
    $env:PGPASSWORD = ""
    & pg_dump $env:POSTGRES_CONNECTION_STRING > $Output 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "pg_dump failed with exit code $LASTEXITCODE"
    }
    $size = (Get-Item $Output).Length
    $sizeStr = if ($size -gt 1MB) { "{0:N1} MB" -f ($size / 1MB) } else { "{0:N1} KB" -f ($size / 1KB) }
    Write-Host "✓ Backup complete ($sizeStr)" -ForegroundColor Green
    Write-Host "  $Output"
} catch {
    Write-Host "✗ Backup failed. Check your connection string and that pg_dump is installed." -ForegroundColor Red
    Write-Host "  $_"
    exit 1
}

# ── Rotation: keep last 7 backups ───────────────────────────────
$BackupDir = Split-Path -Parent $Output
$backups = @(Get-ChildItem -Path $BackupDir -Filter "emperorclaw-backup-*.sql" -File -ErrorAction SilentlyContinue | Sort-Object Name)
if ($backups.Count -gt 7) {
    Write-Host "Rotating old backups (keeping last 7)..." -ForegroundColor Yellow
    $backups[0..($backups.Count - 8)] | Remove-Item -Force
}

Write-Host ""
Write-Host "Ready to upgrade. Run:" -ForegroundColor Green
Write-Host "  cd $RepoDir"
Write-Host "  git pull --ff-only origin main"
Write-Host "  docker compose up -d --build"
