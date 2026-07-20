# EmperorClaw — Standard update script (Windows PowerShell)
# Usage:
#   .\scripts\update.ps1              # Update from git, rebuild, restart
#   .\scripts\update.ps1 -Docker      # Update via Docker (pull image, recreate)
#   .\scripts\update.ps1 -Check       # Only check if update is available

param([switch]$Docker, [switch]$Check)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent $ScriptDir
Set-Location $RepoDir

# ── Check mode ───────────────────────────────────────────────────
if ($Check) {
    git fetch origin 2>$null
    $behind = (git rev-list HEAD..origin/main --count 2>$null) -as [int]
    if ($behind -gt 0) {
        Write-Host "Update available: $behind commit(s) behind origin/main" -ForegroundColor Yellow
        exit 1
    } else {
        Write-Host "Already up to date." -ForegroundColor Green
        exit 0
    }
}

Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "  EmperorClaw — Update" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

# ── Docker mode ──────────────────────────────────────────────────
if ($Docker) {
    Write-Host "Pulling latest Docker image..." -ForegroundColor Yellow
    docker compose pull app
    Write-Host "Recreating containers..." -ForegroundColor Yellow
    docker compose up -d --remove-orphans
    Write-Host "✓ EmperorClaw updated via Docker" -ForegroundColor Green
    Write-Host "  Check logs: docker compose logs -f app"
    exit 0
}

# ── Git mode (source build) ──────────────────────────────────────

# 1. Backup
Write-Host "[1/5] Backing up database..." -ForegroundColor Yellow
if (Test-Path "$RepoDir\scripts\backup-db.ps1") {
    & "$RepoDir\scripts\backup-db.ps1"
} else {
    Write-Host "  backup-db.ps1 not found — skipping backup" -ForegroundColor Red
}

# 2. Pull
Write-Host "[2/5] Pulling latest code..." -ForegroundColor Yellow
git fetch origin 2>$null
$behind = (git rev-list HEAD..origin/main --count 2>$null) -as [int]
if ($behind -eq 0) {
    Write-Host "  Already up to date. Nothing to do." -ForegroundColor Green
    exit 0
}
Write-Host "  $behind commit(s) behind — pulling..."
git pull --ff-only origin main

# 3. Install
Write-Host "[3/5] Installing dependencies..." -ForegroundColor Yellow
npm install --no-audit --no-fund

# 4. Build
Write-Host "[4/5] Building..." -ForegroundColor Yellow
npm run build

# Copy static files for standalone mode
if (Test-Path ".next\standalone") {
    Copy-Item -Recurse -Force ".next\static" ".next\standalone\.next\static" -ErrorAction SilentlyContinue
    Copy-Item -Recurse -Force "public" ".next\standalone\public" -ErrorAction SilentlyContinue
}

# 5. Migrate + restart
Write-Host "[5/5] Running migrations + restarting..." -ForegroundColor Yellow
npm run db:migrate

$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if ($pm2) {
    $list = pm2 list 2>$null
    if ($list -match "emperorclaw") {
        pm2 restart emperorclaw
        Write-Host "✓ EmperorClaw restarted via pm2" -ForegroundColor Green
    }
} elseif (Get-Command docker -ErrorAction SilentlyContinue) {
    $ps = docker compose ps 2>$null
    if ($ps -match "emperorclaw") {
        docker compose up -d --build --remove-orphans
        Write-Host "✓ EmperorClaw restarted via Docker Compose" -ForegroundColor Green
    }
} else {
    Write-Host "⚠ Could not detect process manager. Restart manually." -ForegroundColor Yellow
}

Write-Host ""
$short = git rev-parse --short HEAD
Write-Host "✓ EmperorClaw updated to $short" -ForegroundColor Green
