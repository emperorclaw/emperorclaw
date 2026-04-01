#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-/home/jose/.npm-global/bin/openclaw}"
PLUGIN_SRC="${PLUGIN_SRC:-/home/jose/external-repos/emperorclaw/clawhub/plugin/emperor-claw-os}"
API_URL="${EMPEROR_API_URL:-https://emperorclaw.malecu.eu}"
OWNER_NAME="${OWNER_NAME:-Jose}"
OWNER_TZ="${OWNER_TZ:-UTC}"
TEST_AGENT_ID="${TEST_AGENT_ID:-plugin-validation-agent}"
TEST_AGENT_NAME="${TEST_AGENT_NAME:-Plugin Validation Agent}"
TOKEN="${EMPEROR_API_TOKEN:-}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-/home/jose/.openclaw/openclaw.json}"

strip_stale_plugin_entry() {
  python - <<'PY'
import json
from pathlib import Path
p = Path('/home/jose/.openclaw/openclaw.json')
if not p.exists():
    raise SystemExit(0)
data = json.loads(p.read_text())
plugins = data.get('plugins') or {}
entries = plugins.get('entries') or {}
if 'emperor-claw-os' in entries:
    del entries['emperor-claw-os']
    plugins['entries'] = entries
    data['plugins'] = plugins
    p.write_text(json.dumps(data, indent=2) + '\n')
    print('[cleanup] removed stale plugins.entries.emperor-claw-os')
PY
}

cleanup() {
  set +e
  "$OPENCLAW_BIN" emperor remove-agent --local-brain-agent-id "$TEST_AGENT_ID" --remove-companion-dir >/dev/null 2>&1 || true
  strip_stale_plugin_entry >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo '[0/8] pre-clean config state'
strip_stale_plugin_entry || true

echo '[1/8] reinstall plugin'
rm -rf /home/jose/.openclaw/extensions/emperor-claw-os
"$OPENCLAW_BIN" plugins install "$PLUGIN_SRC" >/dev/null

echo '[1.5/8] normalize config after install'
strip_stale_plugin_entry || true

echo '[2/8] status'
"$OPENCLAW_BIN" emperor status

echo '[3/8] install config'
"$OPENCLAW_BIN" emperor install --api-url "$API_URL" --owner-name "$OWNER_NAME" --owner-timezone "$OWNER_TZ" >/dev/null

echo '[4/8] doctor'
"$OPENCLAW_BIN" emperor doctor

if [[ -z "$TOKEN" ]]; then
  echo '[5/8] skipping add-agent/repair/rebind/remove because EMPEROR_API_TOKEN is not set'
  exit 0
fi

echo '[5/8] add-agent'
"$OPENCLAW_BIN" emperor add-agent \
  --agent-name "$TEST_AGENT_NAME" \
  --local-brain-agent-id "$TEST_AGENT_ID" \
  --token "$TOKEN" \
  --api-url "$API_URL" \
  --owner-name "$OWNER_NAME" \
  --owner-timezone "$OWNER_TZ" \
  --thinking medium

echo '[6/8] repair + doctor'
"$OPENCLAW_BIN" emperor repair >/dev/null
"$OPENCLAW_BIN" emperor doctor

echo '[7/8] rebind-threads'
"$OPENCLAW_BIN" emperor rebind-threads --token "$TOKEN" --api-url "$API_URL"

echo '[8/8] remove-agent'
"$OPENCLAW_BIN" emperor remove-agent --local-brain-agent-id "$TEST_AGENT_ID" --remove-companion-dir
strip_stale_plugin_entry || true
"$OPENCLAW_BIN" emperor list-agents
