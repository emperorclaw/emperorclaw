# EmperorClaw - One-command installer (Windows PowerShell)
param([string]$Domain = "", [string]$AdminEmail = "")
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "  EmperorClaw -- Self-Hosted Installer" -ForegroundColor Cyan
Write-Host "  https://emperorclaw.com" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "git is required. Install: https://git-scm.com" -ForegroundColor Red
    exit 1
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "Docker is required." -ForegroundColor Red
    exit 1
}
Write-Host "[OK] git found" -ForegroundColor Green
Write-Host "[OK] Docker found" -ForegroundColor Green
Write-Host ""

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ((Test-Path "$ScriptDir\docker-compose.yml") -and (Test-Path "$ScriptDir\package.json")) {
    $RepoDir = $ScriptDir
    Write-Host "Detected existing EmperorClaw at $RepoDir" -ForegroundColor Yellow
} else {
    $RepoDir = Join-Path $HOME "emperorclaw"
    if (Test-Path $RepoDir) {
        Write-Host "Updating $RepoDir ..." -ForegroundColor Yellow
        Push-Location $RepoDir; git pull --ff-only origin main 2>$null; Pop-Location
    } else {
        Write-Host "Cloning into $RepoDir ..."
        git clone https://github.com/emperorclaw/emperorclaw.git $RepoDir
    }
    Set-Location $RepoDir
}
if ((Get-Location).Path -ne $RepoDir) { Set-Location $RepoDir }
Write-Host ""

if (-not (Test-Path ".env")) {
    Write-Host "Creating .env ..." -ForegroundColor Yellow
    $sb = New-Object byte[](32); [Security.Cryptography.RandomNumberGenerator]::Fill($sb)
    $secret = [Convert]::ToBase64String($sb)
    $kb = New-Object byte[](32); [Security.Cryptography.RandomNumberGenerator]::Fill($kb)
    $masterKey = -join ($kb | ForEach-Object { $_.ToString("x2") })
    Copy-Item .env.example .env
    $c = Get-Content .env -Raw
    $c = $c -replace '(?m)^NEXTAUTH_SECRET=.*$', "NEXTAUTH_SECRET=$secret"
    $c = $c -replace '(?m)^EMPEROR_CLAW_MASTER_KEY=.*$', "EMPEROR_CLAW_MASTER_KEY=$masterKey"
    if ($Domain) {
        Write-Host "Domain: $Domain" -ForegroundColor Green
        $c = $c -replace '(?m)^APP_URL=.*$', "APP_URL=https://$Domain"
        $c = $c -replace '(?m)^NEXTAUTH_URL=.*$', "NEXTAUTH_URL=https://$Domain"
    }
    if ($AdminEmail) {
        $c = $c -replace '(?m)^EMPEROR_PLATFORM_ADMIN_EMAILS=.*$', "EMPEROR_PLATFORM_ADMIN_EMAILS=$AdminEmail"
        Write-Host "[OK] Platform admin set to $AdminEmail" -ForegroundColor Green
    } else {
        Write-Host "[i] No -AdminEmail given. Set EMPEROR_PLATFORM_ADMIN_EMAILS in .env" -ForegroundColor Yellow
        Write-Host "    (to your admin email) to unlock /ops and the in-app Update button." -ForegroundColor Yellow
    }
    $c | Out-File -Encoding ascii .env -NoNewline
    Write-Host "[OK] .env created" -ForegroundColor Green
} else {
    Write-Host ".env exists -- skipping" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "Starting EmperorClaw (pulling prebuilt image) ..." -ForegroundColor Cyan
# docker-compose.yml uses the prebuilt GHCR image by default, so no --build.
docker compose up -d

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Green
Write-Host "  EmperorClaw is starting!" -ForegroundColor Green
if ($Domain) { Write-Host "  https://$Domain" -ForegroundColor Green }
else { Write-Host "  http://localhost:3000" -ForegroundColor Green }
Write-Host "  Create your admin account on first visit." -ForegroundColor Green
Write-Host "  Docs: https://github.com/emperorclaw/emperorclaw" -ForegroundColor Green
Write-Host "  Site: https://emperorclaw.com" -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Green
Write-Host ""
Write-Host ("To stop:  cd " + $RepoDir + "; docker compose down") -ForegroundColor Yellow
Write-Host ("To update: cd " + $RepoDir + "; .\scripts\update.ps1  (or use the Update button in /ops)") -ForegroundColor Yellow
Write-Host ""