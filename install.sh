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
