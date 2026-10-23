# Works from a downloaded file or Invoke-RestMethod ... | Invoke-Expression.
param([string]$Domain = "", [string]$AdminEmail = "", [string]$InstallDir = "$HOME\emperorclaw", [switch]$NoBrowser, [switch]$NoPrompt)
$ErrorActionPreference = "Stop"
$domainPattern = '^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z0-9.-]+$'
if ($Domain -and $Domain -notmatch $domainPattern) { throw "Use a domain such as claw.example.com, without https:// or a path." }
# Ask for a domain only when someone can answer; blank keeps the local setup.
if (-not $Domain -and -not $NoPrompt -and $env:EMPEROR_INSTALL_NONINTERACTIVE -ne '1' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    while ($true) {
        try { $answer = "$(Read-Host 'Domain for HTTPS (leave blank for local only)')".Trim() } catch { $answer = '' }
        if (-not $answer -or $answer -match $domainPattern) { $Domain = $answer; break }
        Write-Host 'Use a domain such as claw.example.com, without https:// or a path.' -ForegroundColor Yellow
    }
}
if ($AdminEmail -and $AdminEmail -notmatch '^[^\s=]+@[^\s=]+\.[^\s=]+$') { throw "Use the email address you will register with." }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host 'Installing Docker Desktop. Complete any installer prompts, then start Docker Desktop.'
        & winget install --exact --id Docker.DockerDesktop --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw "Docker Desktop installation did not finish. Complete setup and retry." }
        $env:Path += ";$env:ProgramFiles\Docker\Docker\resources\bin"
    } else {
        Start-Process 'https://docs.docker.com/desktop/setup/install/windows-install/'
        throw "Install Docker Desktop from the page that opened, start it, then rerun. No Git, Node.js or PostgreSQL is needed."
    }
}

# Windows PowerShell turns a native command's redirected stderr into a
# terminating error under "Stop"; probes judge success by exit code only.
function Test-DockerCommand([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 1
    try { & docker @Arguments *> $null } catch { $global:LASTEXITCODE = 1 } finally { $ErrorActionPreference = $previous }
    return ($LASTEXITCODE -eq 0)
}
# Docker Desktop takes a while to start its engine; wait instead of failing.
if (-not (Test-DockerCommand @('info'))) {
    $dockerDesktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if ((Test-Path $dockerDesktop) -and -not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) { Start-Process $dockerDesktop }
    $waitSeconds = 180
    if ($env:EMPEROR_INSTALL_DOCKER_WAIT -match '^\d+$') { $waitSeconds = [int]$env:EMPEROR_INSTALL_DOCKER_WAIT }
    $waited = 0
    while ($waited -lt $waitSeconds) {
        Write-Host -NoNewline "`rWaiting for Docker to start... ${waited}s "
        Start-Sleep -Seconds 3
        $waited += 3
        if (Test-DockerCommand @('info')) { break }
    }
    if ($waited -gt 0) { Write-Host '' }
    if (-not (Test-DockerCommand @('info'))) { throw "Docker is not ready. Start Docker Desktop, wait for Engine running, then retry. Use Linux containers." }
}
if (-not (Test-DockerCommand @('compose', 'version'))) { throw "Update Docker Desktop to include Docker Compose v2." }
if (-not $PSBoundParameters.ContainsKey("InstallDir") -and $PSScriptRoot -and (Test-Path "$PSScriptRoot\docker-compose.yml") -and (Test-Path "$PSScriptRoot\package.json")) { $InstallDir = $PSScriptRoot }
New-Item -ItemType Directory -Force "$InstallDir\scripts" | Out-Null
Set-Location $InstallDir
if (-not (Test-Path '.git')) {
    $baseUrl = 'https://raw.githubusercontent.com/emperorclaw/emperorclaw/main'
    foreach ($file in @('docker-compose.yml', 'Caddyfile', '.env.example', 'install.sh', 'install.ps1', 'scripts/update.sh', 'scripts/update.ps1', 'scripts/backup-db.sh', 'scripts/backup-db.ps1')) {
        Invoke-WebRequest "$baseUrl/$file" -OutFile "$file.download" -UseBasicParsing
        Move-Item -Force "$file.download" $file
    }
}
function Set-EnvValue([string]$Name, [string]$Value) {
    $lines = @(Get-Content '.env' | Where-Object { -not $_.StartsWith("$Name=") })
    $lines += "$Name=$Value"
    [IO.File]::WriteAllLines((Join-Path $InstallDir '.env'), $lines, (New-Object Text.UTF8Encoding($false)))
}
function New-Secret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}
$newEnv = -not (Test-Path '.env')
if ($newEnv) { Copy-Item '.env.example' '.env' }
foreach ($name in @('NEXTAUTH_SECRET', 'EMPEROR_CLAW_MASTER_KEY', 'POSTGRES_PASSWORD')) {
    if (-not (Get-Content '.env' | Where-Object { $_ -match "^$name=.+" })) {
        if ($name -eq 'POSTGRES_PASSWORD' -and -not $newEnv) { Set-EnvValue $name 'emperor' }
        else { Set-EnvValue $name (New-Secret) }
    }
}
if ($AdminEmail) { Set-EnvValue 'EMPEROR_PLATFORM_ADMIN_EMAILS' $AdminEmail }
if ($Domain) {
    Set-EnvValue 'EMPEROR_DOMAIN' $Domain
    Set-EnvValue 'APP_URL' "https://$Domain"
    Set-EnvValue 'NEXTAUTH_URL' "https://$Domain"
    $profiles = ((Get-Content '.env' | Where-Object { $_.StartsWith('COMPOSE_PROFILES=') }) -replace '^COMPOSE_PROFILES=', '')
    $profileList = @($profiles -split ',' | Where-Object { $_ })
    if ($profileList -notcontains 'https') { Set-EnvValue 'COMPOSE_PROFILES' (($profileList + 'https') -join ',') }
    Write-Host "Point DNS for $Domain to this server and allow inbound ports 80/443. HTTPS is automatic."
}
Write-Host 'Checking local agent provisioning...'
$socketGid = & docker run --rm --entrypoint stat -v /var/run/docker.sock:/socket postgres:16-alpine -c '%g' /socket
if ($LASTEXITCODE -ne 0 -or "$socketGid" -notmatch '^\d+$') { throw "Cannot mount Docker's socket. Use Docker Desktop's default Linux container engine." }
Set-EnvValue 'DOCKER_GID' "$socketGid"
# A port held by another program makes compose fail with a cryptic bind error.
# A rerun is fine: the ports then belong to this installation's containers.
function Test-PortInUse([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try { $attempt = $client.BeginConnect('127.0.0.1', $Port, $null, $null); return ($attempt.AsyncWaitHandle.WaitOne(500) -and $client.Connected) }
    catch { return $false }
    finally { $client.Close() }
}
$ErrorActionPreference = 'Continue'
$running = & docker compose ps -q 2>$null
$ErrorActionPreference = 'Stop'
if (-not $running) {
    $ports = @(3000)
    if (Get-Content '.env' | Where-Object { $_ -match '^EMPEROR_DOMAIN=.+' }) { $ports += 80, 443 }
    foreach ($port in $ports) {
        if (Test-PortInUse $port) { Write-Host "Warning: port $port is already in use by another program. Stop it, or EmperorClaw may fail to start." -ForegroundColor Yellow }
    }
}
Write-Host 'Starting app and database. First startup can take a few minutes...'
& docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "Startup failed. Check docker compose logs --tail=100 app postgres. Files and data are preserved." }
$ready = $false
for ($attempt = 0; $attempt -lt 90; $attempt++) {
    if (Test-DockerCommand @('compose', 'exec', '-T', 'app', 'wget', '-qO-', 'http://127.0.0.1:3000/api/health')) { $ready = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $ready) { & docker compose ps; throw "Startup did not become ready. Run docker compose logs --tail=100 app postgres. Your data is preserved." }
$probe = 'const http=require("http");const r=http.get({socketPath:"/var/run/docker.sock",path:"/_ping",timeout:5000},s=>{s.resume();s.on("end",()=>process.exit(s.statusCode===200?0:1))});r.on("error",()=>process.exit(1));r.on("timeout",()=>{r.destroy();process.exit(1)})'
$probe | & docker compose exec -T app node
if ($LASTEXITCODE -ne 0) { throw "App is ready but cannot create Hermes workers. Check DOCKER_GID and recreate the app." }
$publicUrl = ((Get-Content '.env' | Where-Object { $_.StartsWith('APP_URL=') }) -replace '^APP_URL=', '')
if (-not $publicUrl) { $publicUrl = 'http://localhost:3000' }
if ($publicUrl -ne 'http://localhost:3000') {
    $publicReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try { Invoke-WebRequest "$publicUrl/api/health" -UseBasicParsing -TimeoutSec 5 | Out-Null; $publicReady = $true; break }
        catch { Start-Sleep -Seconds 2 }
    }
    if (-not $publicReady) { throw "App is ready locally but public URL is not ready. Check DNS, ports 80/443 and docker compose logs --tail=50 caddy. Open $publicUrl/signup after DNS is ready." }
}
Write-Host "Ready! Open $publicUrl/signup and create your admin account." -ForegroundColor Green
Write-Host 'Emperor setup then walks you through your company, your AI model key, and your first team.'
Write-Host 'Agent runtimes are downloaded and connected automatically.'
Write-Host "Install folder: $InstallDir. Update: .\scripts\update.ps1 -Docker"
if (-not $NoBrowser) { Start-Process "$publicUrl/signup" }
