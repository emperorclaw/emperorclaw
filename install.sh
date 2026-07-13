#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─────────────────────────────────────────────────────────────
# Upgrade mode: --upgrade
#   git pull → npm ci → db:migrate → build → pm2 reload
# ─────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--upgrade" ]]; then
  echo "╔══════════════════════════════════════════╗"
  echo "║   Emperor Claw — Upgrade                 ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""

  # 1. Git pull
  if command -v git >/dev/null 2>&1 && [ -d "$ROOT_DIR/.git" ]; then
    echo "[1/5] git pull..."
    cd "$ROOT_DIR"
    git pull --ff-only origin main || {
      echo "  ⚠️  git pull failed. If you have local changes, stash them first:"
      echo "     git stash && ./install.sh --upgrade"
      exit 1
    }
  else
    echo "[1/5] Skipped (not a git repository)"
  fi

  # 2. Install dependencies
  echo "[2/5] npm ci..."
  cd "$ROOT_DIR"
  npm ci --production=false

  # 3. Run database migrations
  echo "[3/5] db:migrate..."
  if command -v npx >/dev/null 2>&1; then
    npx tsx src/db/migrate.ts || {
      echo "  ⚠️  Migration step failed. Check your DATABASE_URL and try again."
      exit 1
    }
  else
    echo "  ⚠️  npx not found — skipping migrations"
  fi

  # 4. Build
  echo "[4/5] npm run build..."
  npm run build

  # 5. Reload PM2 or restart Docker
  if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q emperorclaw; then
    echo "[5/5] pm2 reload emperorclaw..."
    pm2 reload emperorclaw
  elif command -v docker >/dev/null 2>&1 && docker compose ps 2>/dev/null | grep -q emperor; then
    echo "[5/5] docker compose up -d --build..."
    docker compose up -d --build
  else
    echo "[5/5] ⚠️  No running process detected. Start manually:"
    echo "     npm start   (or)   docker compose up -d"
  fi

  # Show new version
  NEW_VERSION="$(node -e "try{console.log(require('./package.json').version)}catch(e){console.log('unknown')}")"
  echo ""
  echo "✅ Upgrade complete — now running v${NEW_VERSION}"
  echo "   Verify: curl -s http://localhost:3000/api/version | jq"
  exit 0
fi

# ─────────────────────────────────────────────────────────────
# Fresh install mode (default)
# ─────────────────────────────────────────────────────────────

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH." >&2
  exit 1
fi

VERSION="$(node -e "try{console.log(require('./package.json').version)}catch(e){console.log('unknown')}")"
echo "Emperor Claw v${VERSION} — Installer"
echo "This will run the local companion bootstrap and optionally doctor."
echo ""

# Check if we're in a git repository and suggest updates
if command -v git >/dev/null 2>&1 && [ -d "$ROOT_DIR/.git" ]; then
  echo "✓ Git repository detected — use ./install.sh --upgrade to update later"
  echo
fi

DEFAULT_API_URL="${EMPEROR_CLAW_API_URL:-http://localhost:3000}"

prompt_default() {
  local prompt="$1"
  local default_value="$2"
  local value
  read -r -p "$prompt [$default_value]: " value
  if [[ -z "$value" ]]; then
    value="$default_value"
  fi
  printf '%s' "$value"
}

prompt_secret() {
  local prompt="$1"
  local value
  read -r -s -p "$prompt: " value
  echo
  printf '%s' "$value"
}

API_URL="${EMPEROR_CLAW_API_URL:-}"
if [[ -z "$API_URL" ]]; then
  API_URL="$(prompt_default "Emperor API URL" "$DEFAULT_API_URL")"
fi

TOKEN="${EMPEROR_CLAW_API_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(prompt_secret "Company MCP token")"
fi

if [[ -z "$TOKEN" ]]; then
  echo "A company MCP token is required." >&2
  exit 1
fi

export EMPEROR_CLAW_API_URL="$API_URL"
export EMPEROR_CLAW_API_TOKEN="$TOKEN"

echo
echo "[1/2] Running bootstrap..."
(cd "$ROOT_DIR" && node scripts/control-plane.js bootstrap)

read -r -p "Run doctor now? [Y/n]: " RUN_DOCTOR
RUN_DOCTOR="${RUN_DOCTOR:-Y}"

if [[ "$RUN_DOCTOR" =~ ^[Yy]$ ]]; then
  echo "[2/2] Running doctor..."
  (cd "$ROOT_DIR" && node scripts/control-plane.js doctor)
else
  echo "[2/2] Doctor skipped."
fi

OPENCLAW_HOME="${HOME}/.openclaw"
COMPANION_DIR="${OPENCLAW_HOME}/emperor-control-plane"

echo
echo "Install complete — Emperor Claw v${VERSION}"
echo "Companion directory: $COMPANION_DIR"
echo "Bridge launcher: $COMPANION_DIR/run-bridge.sh"
echo "Diagnostics: $COMPANION_DIR/doctor.sh"
echo
echo "=== Bridge Features ==="
echo "✓ Force-sharing: Resources with isShared=true auto-inject"
echo "✓ Scope filtering: agent/customer/project/company scopes work correctly"
echo "✓ JSON parsing: Agent profiles in JSON configText parsed correctly"
echo "✓ Resource injection: Shows parsed content, not raw JSON"
echo
echo "=== Usage Notes ==="
echo "Shared mailboxes, identities, and templates belong in Emperor Resources."
echo "Use agent Runtime Integrations only for machine-local payloads."
echo "Agent-scoped resources only inject to that specific agent."
echo "Company-scoped resources inject to all agents."
echo
echo "=== To upgrade later ==="
echo "  ./install.sh --upgrade"
