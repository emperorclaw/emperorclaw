#!/usr/bin/env bash
set -euo pipefail

# Works as a downloaded file or with curl ... | bash.
DOMAIN=""
ADMIN_EMAIL=""
INSTALL_DIR="${EMPEROR_INSTALL_DIR:-$HOME/emperorclaw}"
OPEN_BROWSER=1
PROMPT=1
[ "${EMPEROR_INSTALL_NONINTERACTIVE:-}" != 1 ] || PROMPT=0
INSTALL_DIR_EXPLICIT=0
[ -z "${EMPEROR_INSTALL_DIR:-}" ] || INSTALL_DIR_EXPLICIT=1
while [ "$#" -gt 0 ]; do
    case "$1" in
        --domain|--admin-email|--dir)
            [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "Missing value for $1" >&2; exit 1; }
            case "$1" in --domain) DOMAIN="$2";; --admin-email) ADMIN_EMAIL="$2";; --dir) INSTALL_DIR="$2"; INSTALL_DIR_EXPLICIT=1;; esac
            shift 2;;
        --domain=*) DOMAIN="${1#*=}"; shift;;
        --admin-email=*) ADMIN_EMAIL="${1#*=}"; shift;;
        --no-browser) OPEN_BROWSER=0; shift;;
        --no-prompt) PROMPT=0; shift;;
        *) echo "Unknown option: $1" >&2; exit 1;;
    esac
done
valid_domain() { [[ "$1" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && "$1" == *.* ]]; }
if [ -n "$DOMAIN" ] && ! valid_domain "$DOMAIN"; then
    echo "Use a domain name such as claw.example.com, without https:// or a path." >&2; exit 1
fi
# With curl ... | bash, stdin is this script, so ask on the terminal instead.
# No terminal (CI, cloud-init) means no question: blank keeps the local setup.
TTY="${EMPEROR_INSTALL_TTY:-/dev/tty}"
if [ -z "$DOMAIN" ] && [ "$PROMPT" = 1 ] && (: < "$TTY") 2>/dev/null; then
    while :; do
        printf 'Domain for HTTPS (leave blank for local only): ' >&2
        ANSWER=""
        IFS= read -r ANSWER < "$TTY" || true
        ANSWER="$(printf '%s' "$ANSWER" | tr -d '[:space:]')"
        if [ -z "$ANSWER" ] || valid_domain "$ANSWER"; then DOMAIN="$ANSWER"; break; fi
        echo "Use a domain name such as claw.example.com, without https:// or a path." >&2
    done
fi
if [ -n "$ADMIN_EMAIL" ] && ! [[ "$ADMIN_EMAIL" =~ ^[^[:space:]=]+@[^[:space:]=]+\.[^[:space:]=]+$ ]]; then
    echo "Use the email address you will register with." >&2; exit 1
fi
command -v curl >/dev/null || { echo "curl is required to download the installer files." >&2; exit 1; }
DOCKER=(docker)
if ! command -v docker >/dev/null; then
    echo "Docker is required. Setting up the prerequisite..."
    case "$(uname -s)" in
        Darwin)
            if command -v brew >/dev/null; then
                brew install --cask docker
                open -a Docker
            else
                open "https://docs.docker.com/desktop/setup/install/mac-install/" >/dev/null 2>&1 || true
                echo "Install Docker Desktop from the page that opened, start it, then rerun this command. No Git or Node.js is needed." >&2
                exit 1
            fi;;
        Linux)
            DOCKER_SETUP=$(mktemp)
            curl -fsSL https://raw.githubusercontent.com/emperorclaw/emperorclaw/main/scripts/setup-docker.sh -o "$DOCKER_SETUP"
            bash "$DOCKER_SETUP"
            rm -f "$DOCKER_SETUP"
            if [ "$(id -u)" != 0 ]; then DOCKER=(sudo docker); fi;;
        *) echo "Install Docker Desktop first: https://docs.docker.com/desktop/" >&2; exit 1;;
    esac
fi
docker_ready() {
    "${DOCKER[@]}" info >/dev/null 2>&1 && return 0
    # A new Linux installation may need sudo until account permissions are set.
    if [ "$(uname -s)" = Linux ] && command -v sudo >/dev/null && sudo -n docker info >/dev/null 2>&1; then DOCKER=(sudo docker); return 0; fi
    return 1
}
# Docker Desktop takes a while to start its engine; wait instead of failing.
if ! docker_ready; then
    if [ "$(uname -s)" = Darwin ]; then open -a Docker >/dev/null 2>&1 || true; fi
    DOCKER_WAIT="${EMPEROR_INSTALL_DOCKER_WAIT:-180}"
    WAITED=0
    while [ "$WAITED" -lt "$DOCKER_WAIT" ]; do
        # Waiting cannot fix a permission error on Linux.
        DOCKER_INFO=$("${DOCKER[@]}" info 2>&1 || true)
        case "$DOCKER_INFO" in *[Pp]ermission\ denied*) break;; esac
        printf '\rWaiting for Docker to start... %ss ' "$WAITED"
        sleep 3
        WAITED=$((WAITED + 3))
        if docker_ready; then break; fi
    done
    [ "$WAITED" = 0 ] || echo
fi
if ! docker_ready; then
    echo "Docker is not ready. Start Docker Desktop and wait for 'Engine running', then retry."
    echo "On Linux, start the Docker service and check permission to use docker info (or run this installer with sudo)."
    exit 1
fi
"${DOCKER[@]}" compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required. Update Docker Desktop or install docker-compose-plugin." >&2; exit 1; }

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_PATH" ] && [ "$INSTALL_DIR_EXPLICIT" = 0 ]; then
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
    if [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/package.json" ]; then INSTALL_DIR="$SCRIPT_DIR"; fi
fi
mkdir -p "$INSTALL_DIR/scripts"
cd "$INSTALL_DIR"
# Download only the server bundle; never overwrite the operator's .env or data.
BASE_URL="https://raw.githubusercontent.com/emperorclaw/emperorclaw/main"
if [ ! -d .git ]; then
    echo "Downloading EmperorClaw into $INSTALL_DIR..."
    for file in docker-compose.yml Caddyfile .env.example install.sh install.ps1 scripts/update.sh scripts/update.ps1 scripts/backup-db.sh scripts/backup-db.ps1 scripts/setup-docker.sh; do
        curl -fsSL --retry 3 --connect-timeout 15 "$BASE_URL/$file" -o "$file.download"
        mv "$file.download" "$file"
    done
    chmod +x install.sh scripts/*.sh
fi

set_env() {
    local key="$1" value="$2" temp_file
    temp_file=$(mktemp "$INSTALL_DIR/.env.XXXXXX")
    awk -v key="$key" 'index($0, key "=") != 1 { print }' .env > "$temp_file"
    printf '%s=%s\n' "$key" "$value" >> "$temp_file"
    mv "$temp_file" .env
    chmod 600 .env
}
random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
NEW_ENV=0
if [ ! -f .env ]; then cp .env.example .env; NEW_ENV=1; fi
# Preserve existing secrets; repair only missing/blank ones.
for key in NEXTAUTH_SECRET EMPEROR_CLAW_MASTER_KEY POSTGRES_PASSWORD; do
    if ! awk -v key="$key" 'index($0, key "=") == 1 && length($0) > length(key)+1 { found=1 } END { exit !found }' .env; then
        # A running installation with no POSTGRES_PASSWORD may use the legacy
        # database password. Do not rotate it without changing Postgres itself.
        if [ "$key" = POSTGRES_PASSWORD ] && [ "$NEW_ENV" = 0 ]; then
            set_env POSTGRES_PASSWORD emperor
            continue
        fi
        set_env "$key" "$(random_hex)"
    fi
done
if [ -n "$ADMIN_EMAIL" ]; then set_env EMPEROR_PLATFORM_ADMIN_EMAILS "$ADMIN_EMAIL"; fi
if [ -n "$DOMAIN" ]; then
    set_env EMPEROR_DOMAIN "$DOMAIN"
    set_env APP_URL "https://$DOMAIN"
    set_env NEXTAUTH_URL "https://$DOMAIN"
    # Retain other enabled profiles.
    PROFILES=$(awk -F= '$1 == "COMPOSE_PROFILES" { print $2 }' .env)
    case ",$PROFILES," in *,https,*) ;; *) set_env COMPOSE_PROFILES "${PROFILES:+$PROFILES,}https";; esac
    echo "HTTPS will be configured automatically. Point DNS for $DOMAIN to this server and allow inbound ports 80 and 443."
fi

# Read the socket GID inside Docker's VM, which also works with Docker Desktop.
echo "Checking local agent provisioning..."
SOCKET_GID=$("${DOCKER[@]}" run --rm --entrypoint stat -v /var/run/docker.sock:/socket postgres:16-alpine -c '%g' /socket) || {
    echo "Docker's socket could not be mounted. Use the default Docker context to enable local Hermes workers." >&2; exit 1;
}
[[ "$SOCKET_GID" =~ ^[0-9]+$ ]] || { echo "Cannot determine Docker socket group." >&2; exit 1; }
set_env DOCKER_GID "$SOCKET_GID"
# A port held by another program makes compose fail with a cryptic bind error.
# A rerun is fine: the ports then belong to this installation's containers.
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if [ -z "$("${DOCKER[@]}" compose ps -q 2>/dev/null)" ]; then
    PORTS="3000"
    if awk -F= '$1 == "EMPEROR_DOMAIN" && $2 != "" { found=1 } END { exit !found }' .env; then PORTS="3000 80 443"; fi
    for port in $PORTS; do
        if port_in_use "$port"; then echo "Warning: port $port is already in use by another program. Stop it, or EmperorClaw may fail to start." >&2; fi
    done
fi
echo "Starting the app and database. First startup can take a few minutes..."
"${DOCKER[@]}" compose up -d

READY=0
ATTEMPTS="${EMPEROR_INSTALL_READY_ATTEMPTS:-90}"
for ((attempt=1; attempt<=ATTEMPTS; attempt++)); do
    if "${DOCKER[@]}" compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then READY=1; break; fi
    sleep 2
done
if [ "$READY" != 1 ]; then
    echo "Startup did not become ready. Your files and data are preserved." >&2
    "${DOCKER[@]}" compose ps
    echo "Run: cd '$INSTALL_DIR' && ${DOCKER[*]} compose logs --tail=100 app postgres" >&2
    exit 1
fi
# This probe runs as the app user, not root, and verifies the actual permissions.
if ! "${DOCKER[@]}" compose exec -T app node -e 'const http=require("http");const r=http.get({socketPath:"/var/run/docker.sock",path:"/_ping",timeout:5000},s=>{s.resume();s.on("end",()=>process.exit(s.statusCode===200?0:1))});r.on("error",()=>process.exit(1));r.on("timeout",()=>{r.destroy();process.exit(1)})'; then
    echo "The app is ready, but cannot access Docker for Hermes creation. Check DOCKER_GID in .env and recreate the app." >&2; exit 1
fi
PUBLIC_URL=$(awk -F= '$1 == "APP_URL" { sub(/^[^=]*=/, ""); print }' .env)
PUBLIC_URL="${PUBLIC_URL:-http://localhost:3000}"
if [ "$PUBLIC_URL" != "http://localhost:3000" ]; then
    echo "Checking the public address and HTTPS certificate..."
    PUBLIC_READY=0
    for ((attempt=1; attempt<=${EMPEROR_INSTALL_PUBLIC_ATTEMPTS:-30}; attempt++)); do
        if curl -fsS --connect-timeout 3 --max-time 5 "$PUBLIC_URL/api/health" >/dev/null 2>&1; then PUBLIC_READY=1; break; fi
        sleep 2
    done
    if [ "$PUBLIC_READY" != 1 ]; then
        echo "The app and database are ready locally. The public URL is not reachable yet."
        echo "Check DNS, ports 80/443, and: ${DOCKER[*]} compose logs --tail=50 caddy"
        echo "After fixing DNS, open $PUBLIC_URL/signup. Caddy retries certificates automatically."
        exit 1
    fi
fi
echo "Ready! Open $PUBLIC_URL/signup and create your admin account."
echo "Emperor setup then walks you through your company, your AI model key, and your first team."
echo "Agent runtimes are downloaded and connected automatically."
echo "Install folder: $INSTALL_DIR"
echo "Stop: ${DOCKER[*]} compose down (keeps data). Update: bash scripts/update.sh --docker"
if [ "$OPEN_BROWSER" = 1 ]; then
    if command -v open >/dev/null && [ "$(uname -s)" = Darwin ]; then open "$PUBLIC_URL/signup" || true
    elif [ -n "${DISPLAY:-}" ] && command -v xdg-open >/dev/null; then xdg-open "$PUBLIC_URL/signup" >/dev/null 2>&1 || true; fi
fi
