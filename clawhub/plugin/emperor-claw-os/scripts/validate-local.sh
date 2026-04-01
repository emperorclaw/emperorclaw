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

cleanup() {
  "$OPENCLAW_BIN" emperor remove-agent --local-brain-agent-id "$TEST_AGENT_ID" --remove-companion-dir >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo '[1/8] reinstall plugin'
rm -rf /home/jose/.openclaw/extensions/emperor-claw-os
"$OPENCLAW_BIN" plugins install "$PLUGIN_SRC" >/dev/null

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
"$OPENCLAW_BIN" emperor list-agents
