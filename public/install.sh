#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but was not found in PATH." >&2
  exit 1
fi

INSTALL_BASE_URL="${INSTALL_BASE_URL:-https://emperorclaw.malecu.eu}"
DEFAULT_API_URL="${EMPEROR_CLAW_API_URL:-http://localhost:3000}"
OPENCLAW_HOME="${HOME}/.openclaw"
COMPANION_DIR="${OPENCLAW_HOME}/emperor-control-plane"
RUNTIME_DIR="${COMPANION_DIR}/runtime"

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

mkdir -p "$RUNTIME_DIR"
echo "[setup] Downloading companion runtime files..."
curl -fsSL "${INSTALL_BASE_URL}/downloads/control-plane.js" -o "${RUNTIME_DIR}/control-plane.js"
curl -fsSL "${INSTALL_BASE_URL}/downloads/bridge.js" -o "${RUNTIME_DIR}/bridge.js"

echo
echo "[1/2] Running bootstrap..."
node "${RUNTIME_DIR}/control-plane.js" bootstrap --openclaw-home "$OPENCLAW_HOME" --api-base-url "$API_URL" --token "$TOKEN"

read -r -p "Run doctor now? [Y/n]: " RUN_DOCTOR
RUN_DOCTOR="${RUN_DOCTOR:-Y}"

if [[ "$RUN_DOCTOR" =~ ^[Yy]$ ]]; then
  echo "[2/2] Running doctor..."
  node "${RUNTIME_DIR}/control-plane.js" doctor --config "${COMPANION_DIR}/bridge.config.json" --token "$TOKEN"
else
  echo "[2/2] Doctor skipped."
fi

echo
echo "Install complete."
echo "Companion directory: $COMPANION_DIR"
echo "Bridge launcher: $COMPANION_DIR/run-bridge.sh"
echo "Diagnostics: $COMPANION_DIR/doctor.sh"
