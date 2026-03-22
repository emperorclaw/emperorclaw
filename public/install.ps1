$ErrorActionPreference = "Stop"

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required but was not found in PATH."
    }
}

Require-Command "node"
Require-Command "npm"

if (-not (Get-Command Invoke-WebRequest -ErrorAction SilentlyContinue)) {
    throw "Invoke-WebRequest is required but was not found."
}

Write-Host "Emperor Control Plane installer"
Write-Host "This will run the local companion bootstrap and optionally doctor."
Write-Host ""

function Download-WithRetry {
    param(
        [string]$Uri,
        [string]$OutFile,
        [int]$MaxAttempts = 3
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            Invoke-WebRequest $Uri -OutFile $OutFile -ErrorAction Stop
            return
        } catch {
            Write-Warning "Download failed for $Uri (attempt $attempt/$MaxAttempts)."
            if ($attempt -eq $MaxAttempts) {
                throw
            }
            Start-Sleep -Seconds $attempt
        }
    }
}

$installBaseUrl = if ($env:INSTALL_BASE_URL) { $env:INSTALL_BASE_URL } else { "https://emperorclaw.malecu.eu" }
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

$companionDir = Join-Path $HOME ".openclaw\emperor-control-plane"
$runtimeDir = Join-Path $companionDir "runtime"
$stateDir = Join-Path $companionDir "state"
$bridgeStatePath = Join-Path $stateDir "bridge-state.json"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

$env:EMPEROR_CLAW_COMPANION_DIR = $companionDir
$env:EMPEROR_CLAW_STATE_DIR = $stateDir
$env:EMPEROR_CLAW_BRIDGE_STATE_PATH = $bridgeStatePath

Write-Host "[setup] Downloading companion runtime files..."
Download-WithRetry "$installBaseUrl/downloads/control-plane.js" (Join-Path $runtimeDir "control-plane.js")
Download-WithRetry "$installBaseUrl/downloads/bridge.js" (Join-Path $runtimeDir "bridge.js")

Write-Host ""
Write-Host "[1/2] Running bootstrap..."
node (Join-Path $runtimeDir "control-plane.js") bootstrap --openclaw-home (Join-Path $HOME ".openclaw") --api-base-url $apiUrl --token $token

$runDoctor = Read-Host "Run doctor now? [Y/n]"
if ([string]::IsNullOrWhiteSpace($runDoctor) -or $runDoctor -match '^[Yy]$') {
    Write-Host "[2/2] Running doctor..."
    node (Join-Path $runtimeDir "control-plane.js") doctor --config (Join-Path $companionDir "bridge.config.json") --token $token
} else {
    Write-Host "[2/2] Doctor skipped."
}

Write-Host ""
Write-Host "Install complete."
Write-Host "Companion directory: $companionDir"
Write-Host "State journal: $bridgeStatePath"
Write-Host "Bridge launcher: $(Join-Path $companionDir 'run-bridge.cmd')"
Write-Host "Diagnostics: $(Join-Path $companionDir 'doctor.cmd')"
