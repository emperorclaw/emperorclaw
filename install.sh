#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH." >&2
  exit 1
fi

# Check if we're in a git repository and suggest updates
if command -v git >/dev/null 2>&1 && [ -d "$ROOT_DIR/.git" ]; then
  echo "✓ Git repository detected"
  echo "  Consider running 'git pull' to get latest bridge fixes"
  echo "  Recent bridge fixes include:"
  echo "  - Force-shared resource injection (isShared=true)"
  echo "  - JSON parsing for agent profiles in configText"
  echo "  - Proper scope filtering (agent/customer/project/company)"
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

echo "Emperor Control Plane installer"
echo "This will run the local companion bootstrap and optionally doctor."
echo

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
echo "Install complete."
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
