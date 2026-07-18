# ═══════════════════════════════════════════════════════════════
# EmperorClaw — One-command installer (Windows PowerShell)
# ═══════════════════════════════════════════════════════════════
# This script sets up EmperorClaw with Docker in a single step.
#
# Usage:
#   irm https://emperorclaw.com/install.ps1 | iex
#   .\install.ps1
#   .\install.ps1 -Domain claw.mycompany.com

param(
    [string]$Domain = ""
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║              EmperorClaw — Self-Hosted Installer            ║" -ForegroundColor Cyan
Write-Host "║              https://emperorclaw.com                        ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Prerequisites ────────────────────────────────────────────────
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "git is required. Install it first: https://git-scm.com" -ForegroundColor Red
    exit 1
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "Docker is required. Install it first: https://docs.docker.com/desktop/setup/install/windows-install/" -ForegroundColor Red
    exit 1
}

Write-Host "✓ git found" -ForegroundColor Green
Write-Host "✓ Docker found" -ForegroundColor Green
Write-Host ""

# ── Clone or detect repo ────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ((Test-Path "$ScriptDir\docker-compose.yml") -and (Test-Path "$ScriptDir\package.json")) {
    $RepoDir = $ScriptDir
    Write-Host "Detected existing EmperorClaw installation at $RepoDir" -ForegroundColor Yellow
} else {
    $RepoDir = Join-Path $HOME "emperorclaw"
    if (Test-Path $RepoDir) {
        Write-Host "Directory $RepoDir already exists. Updating..." -ForegroundColor Yellow
        Push-Location $RepoDir
        git pull --ff-only origin main 2>$null
        Pop-Location
    } else {
        Write-Host "Cloning EmperorClaw into $RepoDir ..."
        git clone https://github.com/emperorclaw/emperorclaw.git $RepoDir
    }
    Set-Location $RepoDir
}

# If we detected an existing install, make sure we're in the right directory
if ((Get-Location).Path -ne $RepoDir) {
    Set-Location $RepoDir
}

Write-Host ""

# ── .env setup ───────────────────────────────────────────────────
if (-not (Test-Path ".env")) {
    Write-Host "Creating .env from .env.example ..." -ForegroundColor Yellow

    # Generate secure secrets
    $secretBytes = New-Object byte[](32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($secretBytes)
    $secret = [Convert]::ToBase64String($secretBytes)

    $keyBytes = New-Object byte[](32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($keyBytes)
    $masterKey = -join ($keyBytes | ForEach-Object { $_.ToString("x2") })

    Copy-Item .env.example .env

    $envContent = Get-Content .env -Raw
    $envContent = $envContent -replace '(?m)^NEXTAUTH_SECRET=.*$', "NEXTAUTH_SECRET=$secret"
    $envContent = $envContent -replace '(?m)^EMPEROR_CLAW_MASTER_KEY=.*$', "EMPEROR_CLAW_MASTER_KEY=$masterKey"

    if ($Domain) {
        Write-Host "Configuring for domain: $Domain" -ForegroundColor Green
        $envContent = $envContent -replace '(?m)^APP_URL=.*$', "APP_URL=https://$Domain"
        $envContent = $envContent -replace '(?m)^NEXTAUTH_URL=.*$', "NEXTAUTH_URL=https://$Domain"
    }

    $envContent | Out-File -Encoding ascii .env -NoNewline
    Write-Host "✓ .env created with generated secrets" -ForegroundColor Green
} else {
    Write-Host ".env already exists — skipping" -ForegroundColor Yellow
    $existingEnv = Get-Content .env -Raw
    if ($existingEnv -match '(?m)^NEXTAUTH_SECRET=$') {
        Write-Host "⚠  NEXTAUTH_SECRET is empty in .env. The app will refuse to start without it." -ForegroundColor Red
    }
}

Write-Host ""

# ── Build & start ────────────────────────────────────────────────
Write-Host "Building and starting EmperorClaw ..." -ForegroundColor Cyan
Write-Host "This may take a few minutes on first run."
Write-Host ""

docker compose up -d --build

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  EmperorClaw is starting!                                    ║" -ForegroundColor Green
Write-Host "║                                                              ║" -ForegroundColor Green
if ($Domain) {
    Write-Host "║  Open: https://$Domain                                   " -ForegroundColor Green
} else {
    Write-Host "║  Open: http://localhost:3000                                 " -ForegroundColor Green
}
Write-Host "║                                                              ║" -ForegroundColor Green
Write-Host "║  Create your admin account on first visit.                   ║" -ForegroundColor Green
Write-Host "║                                                              ║" -ForegroundColor Green
Write-Host "║  Docs: https://github.com/emperorclaw/emperorclaw            ║" -ForegroundColor Green
Write-Host "║  Site: https://emperorclaw.com                               ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "To stop:  cd $RepoDir; docker compose down" -ForegroundColor Yellow
Write-Host "To update: cd $RepoDir; git pull; docker compose up -d --build" -ForegroundColor Yellow
Write-Host ""
