#!/usr/bin/env bash
set -euo pipefail

API_URL="${EMPEROR_CLAW_API_URL:-https://emperorclaw.malecu.eu}"
TOKEN="${EMPEROR_CLAW_API_TOKEN:-}"
AGENT_NAME="${EMPEROR_CLAW_AGENT_NAME:-Viktor}"
RUNTIME_ID="${EMPEROR_CLAW_RUNTIME_ID:-${AGENT_NAME,,}-$(hostname -s 2>/dev/null || hostname)}"
LOCAL_AGENT_ID="${EMPEROR_CLAW_BRAIN_AGENT_ID:-${AGENT_NAME,,}}"
BRAIN_THINKING="${EMPEROR_CLAW_BRAIN_THINKING:-medium}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
COMPANION_DIR="${EMPEROR_CLAW_COMPANION_DIR:-$OPENCLAW_HOME/emperor-control-plane}"
RUNTIME_DIR="$COMPANION_DIR/runtime"
STATE_DIR="${EMPEROR_CLAW_STATE_DIR:-$COMPANION_DIR/state}"
BRIDGE_STATE_PATH="${EMPEROR_CLAW_BRIDGE_STATE_PATH:-$STATE_DIR/bridge-state.json}"
ENV_FILE="$COMPANION_DIR/.env"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/emperor-claw-bridge.service"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE:-$OPENCLAW_HOME/workspace}"
CONTROL_PLANE_JS_URL="${EMPEROR_CLAW_CONTROL_PLANE_JS_URL:-$API_URL/control-plane.js}"
BRIDGE_JS_URL="${EMPEROR_CLAW_BRIDGE_JS_URL:-$API_URL/bridge.js}"
OPENCLAW_CLI_PATH="${OPENCLAW_CLI_PATH:-}"
OWNER_NAME="${EMPEROR_CLAW_OWNER_NAME:-Jose}"
OWNER_TIMEZONE="${EMPEROR_CLAW_OWNER_TIMEZONE:-UTC}"
AGENT_PROFILE="${EMPEROR_CLAW_AGENT_PROFILE:-operator}"
AGENT_EMOJI="${EMPEROR_CLAW_AGENT_EMOJI:-🧠}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd node
need_cmd npm
need_cmd curl
need_cmd python3

case "$AGENT_PROFILE" in
  operator|manager) ;;
  *)
    echo "Unsupported EMPEROR_CLAW_AGENT_PROFILE: $AGENT_PROFILE (expected: operator|manager)" >&2
    exit 1
    ;;
esac

if [[ -z "$OPENCLAW_CLI_PATH" ]]; then
  if command -v openclaw >/dev/null 2>&1; then
    OPENCLAW_CLI_PATH="$(command -v openclaw)"
  elif [[ -x "$HOME/.npm-global/bin/openclaw" ]]; then
    OPENCLAW_CLI_PATH="$HOME/.npm-global/bin/openclaw"
  else
    echo "Could not find openclaw CLI. Install OpenClaw first or export OPENCLAW_CLI_PATH." >&2
    exit 1
  fi
fi

if [[ -z "$TOKEN" ]]; then
  printf 'Enter EMPEROR_CLAW_API_TOKEN: ' >&2
  read -r TOKEN
fi

if [[ "$AGENT_PROFILE" == "manager" && -z "${EMPEROR_CLAW_RUNTIME_ID:-}" ]]; then
  RUNTIME_ID="manager-$(hostname -s 2>/dev/null || hostname)"
fi

mkdir -p "$RUNTIME_DIR" "$STATE_DIR"

curl -fsSL "$CONTROL_PLANE_JS_URL" -o "$RUNTIME_DIR/control-plane.js"
curl -fsSL "$BRIDGE_JS_URL" -o "$RUNTIME_DIR/bridge.js"
chmod 755 "$RUNTIME_DIR/control-plane.js" "$RUNTIME_DIR/bridge.js"

if [[ ! -f "$RUNTIME_DIR/package.json" ]]; then
  cat > "$RUNTIME_DIR/package.json" <<'JSON'
{
  "name": "emperor-control-plane-runtime",
  "private": true,
  "version": "2.0.0",
  "description": "Runtime dependencies for the Emperor Claw OpenClaw bridge",
  "dependencies": {
    "ws": "^8.18.0"
  }
}
JSON
fi

npm --prefix "$RUNTIME_DIR" install --silent

node "$RUNTIME_DIR/control-plane.js" bootstrap \
  --openclaw-home "$OPENCLAW_HOME" \
  --api-base-url "$API_URL" \
  --token "$TOKEN" \
  --agent-name "$AGENT_NAME" \
  --runtime-id "$RUNTIME_ID"

python3 - <<PY
from pathlib import Path
p = Path(r"$ENV_FILE")
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(f'''EMPEROR_CLAW_API_URL={API_URL}\nEMPEROR_CLAW_API_TOKEN={TOKEN}\nEMPEROR_CLAW_AGENT_NAME={AGENT_NAME}\nEMPEROR_CLAW_RUNTIME_ID={RUNTIME_ID}\nEMPEROR_CLAW_COMPANION_DIR={COMPANION_DIR}\nEMPEROR_CLAW_STATE_DIR={STATE_DIR}\nEMPEROR_CLAW_BRIDGE_STATE_PATH={BRIDGE_STATE_PATH}\nEMPEROR_CLAW_BRAIN_AGENT_ID={LOCAL_AGENT_ID}\nEMPEROR_CLAW_BRAIN_THINKING={BRAIN_THINKING}\nOPENCLAW_CLI_PATH={OPENCLAW_CLI_PATH}\nOPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT:-18789}\n''')
PY
chmod 600 "$ENV_FILE"

if ! "$OPENCLAW_CLI_PATH" agents list --json | python3 - "$LOCAL_AGENT_ID" <<'PY'
import json, sys
agent_id = sys.argv[1]
data = json.load(sys.stdin)
for row in data:
    if row.get('id') == agent_id:
        raise SystemExit(0)
raise SystemExit(1)
PY
then
  "$OPENCLAW_CLI_PATH" agents add "$LOCAL_AGENT_ID" \
    --workspace "$WORKSPACE_DIR" \
    --model openai-codex/gpt-5.4 \
    --non-interactive >/dev/null
fi

"$OPENCLAW_CLI_PATH" agents set-identity --agent "$LOCAL_AGENT_ID" --name "$AGENT_NAME" --emoji "$AGENT_EMOJI" >/dev/null || true

AGENT_WORKSPACE_DIR="$OPENCLAW_HOME/workspace-$LOCAL_AGENT_ID"
mkdir -p "$AGENT_WORKSPACE_DIR"

if [[ "$AGENT_PROFILE" == "manager" ]]; then
  cat > "$AGENT_WORKSPACE_DIR/BOOTSTRAP.md" <<EOF
# BOOTSTRAP.md - Manager Bootstrap

You are already configured. Do not ask who you are.

Before replying, read:
1. AGENTS.md
2. SOUL.md
3. USER.md
4. IDENTITY.md

You are the Emperor-facing manager agent for this OpenClaw deployment.
Your job is to monitor work health, summarize what matters, detect blockers or stale work, and recommend next actions without being noisy.
Emperor Claw is your source of truth for customers, projects, tasks, resources, artifacts, and thread state.
Prefer current Emperor state over guesses.
Do not pretend work is complete unless a real executor produced a result.
EOF
  cat > "$AGENT_WORKSPACE_DIR/IDENTITY.md" <<EOF
# IDENTITY.md - Who Am I?

- **Name:** $AGENT_NAME
- **Creature:** Emperor operations lead
- **Vibe:** Calm, structured, concise, reliable
- **Emoji:** $AGENT_EMOJI
- **Avatar:**

## Notes

You are the oversight and delegation agent for this Emperor/OpenClaw deployment.
EOF
  cat > "$AGENT_WORKSPACE_DIR/USER.md" <<EOF
# USER.md - About Your Human

- **Name:** $OWNER_NAME
- **What to call them:** $OWNER_NAME
- **Pronouns:** _(optional)_
- **Timezone:** $OWNER_TIMEZONE
- **Notes:** Owns this Emperor/OpenClaw deployment and wants practical help keeping work moving.

## Context

- Prefer useful summaries over noise.
- Focus on execution health, blockers, backlog, and delegation.
- Be proactive, but not annoying.
EOF
  cat > "$AGENT_WORKSPACE_DIR/SOUL.md" <<EOF
# SOUL.md - Manager

Be useful, calm, and operationally honest.
Prefer evidence over guesswork.
Prefer concise summaries over long essays.
Do not hallucinate Emperor state.
Do not claim work is complete without proof.
Escalate only when action is actually needed.
EOF
  python3 - <<PY
from pathlib import Path
p = Path(r"$AGENT_WORKSPACE_DIR/AGENTS.md")
text = p.read_text() if p.exists() else "# AGENTS.md\n"
addon = """

## Emperor Claw Manager Rules

- Monitor Emperor state for stale tasks, blocked work, idle projects, and missing ownership.
- In team threads, speak when there is genuine signal: blockers, stale work, overload, or a useful summary.
- In direct threads, answer status questions clearly and concisely.
- Do not auto-claim execution tasks unless explicitly configured to do so.
- Prefer summaries, notes, and recommendations over unnecessary intervention.
- Be explicit about whether you observed, recommended, escalated, or actually changed something.
"""
if "## Emperor Claw Manager Rules" not in text:
    p.write_text(text.rstrip()+addon+"\n")
PY
  cat > "$AGENT_WORKSPACE_DIR/HEARTBEAT.md" <<EOF
# HEARTBEAT.md

Check Emperor for:
- tasks stuck in inbox for too long
- tasks stuck in progress without visible updates
- active projects with no recent movement
- backlog growth with no clear ownership

If nothing important changed, reply HEARTBEAT_OK.
If something needs attention, summarize only the actionable items.
EOF
else
  cat > "$AGENT_WORKSPACE_DIR/BOOTSTRAP.md" <<EOF
# BOOTSTRAP.md - Emperor Operator Bootstrap

You are already configured. Do not ask who you are.

Before replying, read:
1. AGENTS.md
2. SOUL.md
3. USER.md
4. IDENTITY.md

Emperor Claw is your control plane and source of truth for customers, projects, tasks, resources, artifacts, and chat state.
If Emperor data is available, prefer it over guesses.
If files and Emperor disagree, surface the mismatch honestly.
EOF
  cat > "$AGENT_WORKSPACE_DIR/IDENTITY.md" <<EOF
# IDENTITY.md - Who Am I?

- **Name:** $AGENT_NAME
- **Creature:** Emperor-connected operator
- **Vibe:** Concise, competent, honest, practical
- **Emoji:** $AGENT_EMOJI
- **Avatar:**

## Notes

You are the Emperor-facing operator agent for this OpenClaw deployment.
EOF
  cat > "$AGENT_WORKSPACE_DIR/USER.md" <<EOF
# USER.md - About Your Human

- **Name:** $OWNER_NAME
- **What to call them:** $OWNER_NAME
- **Pronouns:** _(optional)_
- **Timezone:** $OWNER_TIMEZONE
- **Notes:** Owns this Emperor/OpenClaw deployment and uses it for real work operations.

## Context

- Prefer current Emperor state over guesses when answering about customers, projects, tasks, resources, or artifacts.
- Be useful, clear, and operationally honest.
EOF
  cat > "$AGENT_WORKSPACE_DIR/SOUL.md" <<EOF
# SOUL.md - Emperor Operator

Be direct, useful, and honest.
Do not hallucinate Emperor data when live state should be checked.
Do not report a task as complete unless a real executor produced a result.
Keep human-facing updates concise and natural.
When blocked, say what is missing.
EOF
  python3 - <<PY
from pathlib import Path
p = Path(r"$AGENT_WORKSPACE_DIR/AGENTS.md")
text = p.read_text() if p.exists() else "# AGENTS.md\n"
addon = """

## Emperor Claw Operating Rules

- In direct Emperor threads, reply normally.
- In team Emperor threads, require an explicit mention by default.
- Only claim tasks on explicit instruction unless auto-claim is explicitly enabled.
- If a task is claimed, leave honest notes and do not pretend completion.
- Use Emperor customer/project/task state as the system of record.
- Use artifacts for real deliverables, not logs.
"""
if "## Emperor Claw Operating Rules" not in text:
    p.write_text(text.rstrip()+addon+"\n")
PY
fi

mkdir -p "$SERVICE_DIR"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Emperor Claw bridge for OpenClaw
After=network-online.target openclaw-gateway.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.openclaw/emperor-control-plane/.env
ExecStart=$COMPANION_DIR/run-bridge.sh
WorkingDirectory=$COMPANION_DIR
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

if systemctl --user status >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable --now emperor-claw-bridge.service >/dev/null
fi

EMPEROR_CLAW_API_TOKEN="$TOKEN" "$COMPANION_DIR/doctor.sh" >/dev/null
"$OPENCLAW_CLI_PATH" agent --agent "$LOCAL_AGENT_ID" --message "Reply exactly with: ${AGENT_NAME} brain OK" --thinking "$BRAIN_THINKING" --timeout 60 --json >/dev/null

echo "Installed Emperor Claw companion v2"
echo "- API URL: $API_URL"
echo "- Companion dir: $COMPANION_DIR"
echo "- Local brain agent: $LOCAL_AGENT_ID"
echo "- Service: emperor-claw-bridge.service"
echo "- Env file: $ENV_FILE"
