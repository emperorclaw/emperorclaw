#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

EMPEROR_CLAW_AGENT_PROFILE=manager \
EMPEROR_CLAW_AGENT_NAME="${EMPEROR_CLAW_AGENT_NAME:-Manager}" \
EMPEROR_CLAW_AGENT_EMOJI="${EMPEROR_CLAW_AGENT_EMOJI:-📋}" \
EMPEROR_CLAW_BRAIN_AGENT_ID="${EMPEROR_CLAW_BRAIN_AGENT_ID:-manager}" \
EMPEROR_CLAW_SERVICE_NAME="${EMPEROR_CLAW_SERVICE_NAME:-emperor-claw-manager}" \
EMPEROR_CLAW_COMPANION_DIR="${EMPEROR_CLAW_COMPANION_DIR:-$HOME/.openclaw/emperor-control-plane-manager}" \
EMPEROR_CLAW_STATE_DIR="${EMPEROR_CLAW_STATE_DIR:-$HOME/.openclaw/emperor-control-plane-manager/state}" \
EMPEROR_CLAW_BRIDGE_STATE_PATH="${EMPEROR_CLAW_BRIDGE_STATE_PATH:-$HOME/.openclaw/emperor-control-plane-manager/state/bridge-state.json}" \
"$DIR/install.sh"
