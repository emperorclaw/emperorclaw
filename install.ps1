$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required but was not found in PATH."
    }
}

Require-Command "node"
Require-Command "npm"

Write-Host "Emperor Control Plane installer"
Write-Host "This will run the local companion bootstrap and optionally doctor."
Write-Host ""

$defaultApiUrl = if ($env:EMPEROR_CLAW_API_URL) { $env:EMPEROR_CLAW_API_URL } else { "http://localhost:3000" }
$apiUrl = if ($env:EMPEROR_CLAW_API_URL) {
    $env:EMPEROR_CLAW_API_URL
} else {
    $inputApi = Read-Host "Emperor API URL [$defaultApiUrl]"
    if ([string]::IsNullOrWhiteSpace($inputApi)) { $defaultApiUrl } else { $inputApi.Trim() }
}

$token = if ($env:EMPEROR_CLAW_API_TOKEN) {
    $env:EMPEROR_CLAW_API_TOKEN
} else {
    $secure = Read-Host "Company MCP token" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

if ([string]::IsNullOrWhiteSpace($token)) {
    throw "A company MCP token is required."
}

$env:EMPEROR_CLAW_API_URL = $apiUrl
$env:EMPEROR_CLAW_API_TOKEN = $token

Write-Host ""
Write-Host "[1/2] Running bootstrap..."
Push-Location $RootDir
try {
    node scripts/control-plane.js bootstrap
} finally {
    Pop-Location
}

$runDoctor = Read-Host "Run doctor now? [Y/n]"
if ([string]::IsNullOrWhiteSpace($runDoctor) -or $runDoctor -match '^[Yy]$') {
    Write-Host "[2/2] Running doctor..."
    Push-Location $RootDir
    try {
        node scripts/control-plane.js doctor
    } finally {
        Pop-Location
    }
} else {
    Write-Host "[2/2] Doctor skipped."
}

$companionDir = Join-Path $HOME ".openclaw\emperor-control-plane"
Write-Host ""
Write-Host "Install complete."
Write-Host "Companion directory: $companionDir"
Write-Host "Bridge launcher: $(Join-Path $companionDir 'run-bridge.cmd')"
Write-Host "Diagnostics: $(Join-Path $companionDir 'doctor.cmd')"
