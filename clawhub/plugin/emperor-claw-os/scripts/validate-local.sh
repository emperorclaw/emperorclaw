#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/.npm-global/bin/openclaw}"
PLUGIN_SRC="${PLUGIN_SRC:-$PLUGIN_ROOT}"
API_URL="${EMPEROR_API_URL:-https://emperorclaw.malecu.eu}"
OWNER_NAME="${OWNER_NAME:-Jose}"
OWNER_TZ="${OWNER_TZ:-UTC}"
TEST_AGENT_ID="${TEST_AGENT_ID:-plugin-validation-agent}"
TEST_AGENT_NAME="${TEST_AGENT_NAME:-Plugin Validation Agent}"
TOKEN="${EMPEROR_API_TOKEN:-}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$OPENCLAW_HOME/openclaw.json}"
PLUGIN_INSTALL_DIR="${PLUGIN_INSTALL_DIR:-$OPENCLAW_HOME/extensions/emperor-claw-os}"
TEST_WORKSPACE_DIR="${TEST_WORKSPACE_DIR:-$OPENCLAW_HOME/workspace-$TEST_AGENT_ID}"

strip_stale_plugin_entry() {
  OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG" python - <<'PY'
import json
import os
from pathlib import Path

p = Path(os.environ["OPENCLAW_CONFIG_PATH"])
if not p.exists():
    raise SystemExit(0)

data = json.loads(p.read_text())
plugins = data.get("plugins") or {}
entries = plugins.get("entries") or {}
if "emperor-claw-os" in entries:
    del entries["emperor-claw-os"]
    plugins["entries"] = entries
    data["plugins"] = plugins
    p.write_text(json.dumps(data, indent=2) + "\n")
    print("[cleanup] removed stale plugins.entries.emperor-claw-os")
PY
}

cleanup() {
  set +e
  "$OPENCLAW_BIN" emperor remove-agent --local-brain-agent-id "$TEST_AGENT_ID" --remove-companion-dir --remove-workspace --remove-local-brain-agent >/dev/null 2>&1 || true
  rm -rf "$TEST_WORKSPACE_DIR" >/dev/null 2>&1 || true
  strip_stale_plugin_entry >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo '[0/9] pre-clean config state'
strip_stale_plugin_entry || true

echo '[1/9] reinstall plugin'
rm -rf "$PLUGIN_INSTALL_DIR"
"$OPENCLAW_BIN" plugins install "$PLUGIN_SRC" >/dev/null

echo '[2/9] normalize config after install'
strip_stale_plugin_entry || true

echo '[3/9] status'
"$OPENCLAW_BIN" emperor status

echo '[4/9] install config'
"$OPENCLAW_BIN" emperor install --api-url "$API_URL" --owner-name "$OWNER_NAME" --owner-timezone "$OWNER_TZ" >/dev/null

echo '[5/9] doctor'
"$OPENCLAW_BIN" emperor doctor

if [[ -z "$TOKEN" ]]; then
  echo '[6/9] skipping add-agent/verify/repair/rebind/remove because EMPEROR_API_TOKEN is not set'
  exit 0
fi

echo '[6/9] add-agent'
"$OPENCLAW_BIN" emperor add-agent \
  --agent-name "$TEST_AGENT_NAME" \
  --local-brain-agent-id "$TEST_AGENT_ID" \
  --token "$TOKEN" \
  --api-url "$API_URL" \
  --owner-name "$OWNER_NAME" \
  --owner-timezone "$OWNER_TZ" \
  --thinking medium

echo '[7/9] verify manifest contract'
SHOW_OUTPUT="$("$OPENCLAW_BIN" emperor show-agent --local-brain-agent-id "$TEST_AGENT_ID")"
printf '%s\n' "$SHOW_OUTPUT"
printf '%s\n' "$SHOW_OUTPUT" | grep -q "Bridge contract version:"
printf '%s\n' "$SHOW_OUTPUT" | grep -q "delegation=explicit-mention"

echo '[8/9] upgrade-manifests + repair + doctor'
"$OPENCLAW_BIN" emperor upgrade-manifests >/dev/null
"$OPENCLAW_BIN" emperor repair >/dev/null
"$OPENCLAW_BIN" emperor doctor

echo '[9/9] rebind-threads + remove-agent'
"$OPENCLAW_BIN" emperor rebind-threads --token "$TOKEN" --api-url "$API_URL"
REMOVE_OUTPUT="$("$OPENCLAW_BIN" emperor remove-agent --local-brain-agent-id "$TEST_AGENT_ID" --remove-companion-dir --remove-workspace --remove-local-brain-agent)"
printf '%s\n' "$REMOVE_OUTPUT"
printf '%s\n' "$REMOVE_OUTPUT" | grep -q "Workspace removed:"
test ! -d "$TEST_WORKSPACE_DIR"
strip_stale_plugin_entry || true
"$OPENCLAW_BIN" emperor list-agents
