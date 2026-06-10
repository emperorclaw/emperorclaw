#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_SH="$SCRIPT_DIR/install.sh"

echo "[emperor-claw] Skill updated, running upgrade..."

if [[ ! -x "$INSTALL_SH" ]]; then
  echo "  ⚠️  Installer not found at $INSTALL_SH"
  exit 1
fi

# Check if bridge is already installed
COMPANION_DIR="${EMPEROR_CLAW_COMPANION_DIR:-$HOME/.openclaw/emperor-control-plane}"
if [[ ! -d "$COMPANION_DIR" ]]; then
  echo "  ℹ️  No existing installation found. Run $INSTALL_SH manually to install."
  exit 0
fi

# Run installer in upgrade mode
"$INSTALL_SH" --upgrade

echo "[emperor-claw] Upgrade completed."