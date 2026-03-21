#!/usr/bin/env bash
set -euo pipefail

export EMPEROR_CLAW_API_URL="${EMPEROR_CLAW_API_URL:-http://localhost:3000}"
export EMPEROR_CLAW_API_TOKEN="${EMPEROR_CLAW_API_TOKEN:-}"
export EMPEROR_AGENT_NAME="${EMPEROR_AGENT_NAME:-emperor-doctor}"
export EMPEROR_RUNTIME_ID="${EMPEROR_RUNTIME_ID:-emperor-doctor-desktop-7juse67}"

if [[ -z "${EMPEROR_CLAW_API_TOKEN}" ]]; then
  echo "EMPEROR_CLAW_API_TOKEN is required." >&2
  exit 1
fi

node "c:\Users\JZ\Documents\w\emperorclaw\clawhub\emperor-claw-os\examples\bridge.js"
