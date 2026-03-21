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
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

Write-Host "[setup] Downloading companion runtime files..."
Invoke-WebRequest "$installBaseUrl/downloads/control-plane.js" -OutFile (Join-Path $runtimeDir "control-plane.js")
Invoke-WebRequest "$installBaseUrl/downloads/bridge.js" -OutFile (Join-Path $runtimeDir "bridge.js")

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
Write-Host "Bridge launcher: $(Join-Path $companionDir 'run-bridge.cmd')"
Write-Host "Diagnostics: $(Join-Path $companionDir 'doctor.cmd')"
