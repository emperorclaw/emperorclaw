#!/usr/bin/env bash
set -euo pipefail

API_URL_DEFAULT="https://emperorclaw.malecu.eu"
AGENT_NAME_DEFAULT="Viktor"
OWNER_NAME_DEFAULT="Jose"
OWNER_TZ_DEFAULT="UTC"

API_URL="${EMPEROR_CLAW_API_URL:-$API_URL_DEFAULT}"
TOKEN="${EMPEROR_CLAW_API_TOKEN:-}"
AGENT_NAME="${EMPEROR_CLAW_AGENT_NAME:-$AGENT_NAME_DEFAULT}"
LOCAL_AGENT_ID="${EMPEROR_CLAW_BRAIN_AGENT_ID:-${AGENT_NAME,,}}"
AGENT_PROFILE="${EMPEROR_CLAW_AGENT_PROFILE:-operator}"
OWNER_NAME="${EMPEROR_CLAW_OWNER_NAME:-$OWNER_NAME_DEFAULT}"
OWNER_TIMEZONE="${EMPEROR_CLAW_OWNER_TIMEZONE:-$OWNER_TZ_DEFAULT}"
BRAIN_THINKING="${EMPEROR_CLAW_BRAIN_THINKING:-medium}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
AGENT_EMOJI="${EMPEROR_CLAW_AGENT_EMOJI:-🧠}"

print_help() {
  cat <<EOF
Emperor Claw OpenClaw bridge installer

Usage:
  ./install.sh [--agent-name NAME] [--local-id ID] [--profile operator|manager] [--owner-name NAME] [--owner-tz TZ] [--api-url URL]

Flags override defaults; environment variables still take precedence when set.

Defaults:
  agent name : $AGENT_NAME_DEFAULT
  profile    : operator
  api url    : $API_URL_DEFAULT
  owner name : $OWNER_NAME_DEFAULT
  owner tz   : $OWNER_TZ_DEFAULT
EOF
}

UPGRADE_MODE=false
CHECK_COMPATIBILITY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-name)
      AGENT_NAME="$2"; shift 2 ;;
    --local-id)
      LOCAL_AGENT_ID="$2"; shift 2 ;;
    --profile)
      AGENT_PROFILE="$2"; shift 2 ;;
    --owner-name)
      OWNER_NAME="$2"; shift 2 ;;
    --owner-tz)
      OWNER_TIMEZONE="$2"; shift 2 ;;
    --api-url)
      API_URL="$2"; shift 2 ;;
    --upgrade)
      UPGRADE_MODE=true; shift ;;
    --check-compatibility)
      CHECK_COMPATIBILITY=true; shift ;;
    -h|--help)
      print_help; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      print_help >&2
      exit 1 ;;
  esac
done

RUNTIME_ID="${EMPEROR_CLAW_RUNTIME_ID:-${AGENT_NAME,,}-$(hostname -s 2>/dev/null || hostname)}"
COMPANION_SLUG_DEFAULT="${EMPEROR_CLAW_BRAIN_AGENT_ID:-$AGENT_NAME}"
COMPANION_SLUG_DEFAULT="$(printf '%s' "$COMPANION_SLUG_DEFAULT" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
COMPANION_SLUG_DEFAULT="${COMPANION_SLUG_DEFAULT#-}"
COMPANION_SLUG_DEFAULT="${COMPANION_SLUG_DEFAULT%-}"
COMPANION_DIR="${EMPEROR_CLAW_COMPANION_DIR:-$OPENCLAW_HOME/emperor-control-plane-${COMPANION_SLUG_DEFAULT}}"
RUNTIME_DIR="$COMPANION_DIR/runtime"
STATE_DIR="${EMPEROR_CLAW_STATE_DIR:-$COMPANION_DIR/state}"
BRIDGE_STATE_PATH="${EMPEROR_CLAW_BRIDGE_STATE_PATH:-$STATE_DIR/bridge-state.json}"
ENV_FILE="$COMPANION_DIR/.env"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="${EMPEROR_CLAW_SERVICE_NAME:-emperor-claw-bridge-${COMPANION_SLUG_DEFAULT}}"
SERVICE_FILE="$SERVICE_DIR/${SERVICE_NAME}.service"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE:-$OPENCLAW_HOME/workspace}"
CONTROL_PLANE_JS_URL="${EMPEROR_CLAW_CONTROL_PLANE_JS_URL:-$API_URL/downloads/control-plane.js}"
BRIDGE_JS_URL="${EMPEROR_CLAW_BRIDGE_JS_URL:-$API_URL/downloads/bridge.js}"
OPENCLAW_CLI_PATH="${OPENCLAW_CLI_PATH:-}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

check_server_compatibility() {
  echo "[emperor-claw] Checking server compatibility..."
  if ! HEALTH_RESPONSE=$(curl -fsSL -H "Authorization: Bearer $TOKEN" "$API_URL/api/mcp/runtime/health" 2>/dev/null); then
    echo "  ⚠️  Could not fetch server health endpoint"
    return 1
  fi
  EMPEROR_VERSION=$(echo "$HEALTH_RESPONSE" | grep -o '"emperorVersion":"[^"]*"' | cut -d'"' -f4)
  RECOMMENDED_SKILL_VERSION=$(echo "$HEALTH_RESPONSE" | grep -o '"recommendedSkillVersion":"[^"]*"' | cut -d'"' -f4)
  MIN_BRIDGE_VERSION=$(echo "$HEALTH_RESPONSE" | grep -o '"minimumBridgeVersion":"[^"]*"' | cut -d'"' -f4)
  DOCS_URL=$(echo "$HEALTH_RESPONSE" | grep -o '"docsUrl":"[^"]*"' | cut -d'"' -f4)
  echo "  ✅ Emperor version: ${EMPEROR_VERSION:-unknown}"
  echo "  📘 Docs: ${DOCS_URL:-$API_URL/docs}"
  if [[ -n "$RECOMMENDED_SKILL_VERSION" ]]; then
    echo "  🔧 Recommended skill version: $RECOMMENDED_SKILL_VERSION"
  fi
  if [[ -n "$MIN_BRIDGE_VERSION" ]]; then
    echo "  ⚙️  Minimum bridge version: $MIN_BRIDGE_VERSION"
  fi
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_BRIDGE_JS="$SKILL_ROOT/examples/bridge.js"
LOCAL_CONTROL_PLANE_JS="${EMPEROR_CLAW_LOCAL_CONTROL_PLANE_JS:-}"
LOCAL_DOCTOR_LOCAL_SH="$SCRIPT_DIR/doctor-local.sh"

if [[ "$CHECK_COMPATIBILITY" == true ]]; then
  check_server_compatibility
  exit 0
fi

check_server_compatibility

if [[ "$UPGRADE_MODE" == true ]]; then
  echo "[emperor-claw] Upgrading bridge runtime..."
fi

if [[ -n "$LOCAL_CONTROL_PLANE_JS" && -f "$LOCAL_CONTROL_PLANE_JS" ]]; then
  cp "$LOCAL_CONTROL_PLANE_JS" "$RUNTIME_DIR/control-plane.js"
elif curl -fsSL "$CONTROL_PLANE_JS_URL" -o "$RUNTIME_DIR/control-plane.js"; then
  :
else
  echo "Failed to download control-plane.js and no local fallback provided via EMPEROR_CLAW_LOCAL_CONTROL_PLANE_JS" >&2
  exit 1
fi

if [[ -f "$LOCAL_BRIDGE_JS" ]]; then
  cp "$LOCAL_BRIDGE_JS" "$RUNTIME_DIR/bridge.js"
elif curl -fsSL "$BRIDGE_JS_URL" -o "$RUNTIME_DIR/bridge.js"; then
  :
else
  echo "Failed to fetch bridge.js and local skill copy not found at $LOCAL_BRIDGE_JS" >&2
  exit 1
fi

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

EMPEROR_CLAW_COMPANION_DIR="$COMPANION_DIR" \
EMPEROR_CLAW_STATE_DIR="$STATE_DIR" \
EMPEROR_CLAW_BRIDGE_STATE_PATH="$BRIDGE_STATE_PATH" \
node "$RUNTIME_DIR/control-plane.js" bootstrap \
  --openclaw-home "$OPENCLAW_HOME" \
  --api-base-url "$API_URL" \
  --token "$TOKEN" \
  --agent-name "$AGENT_NAME" \
  --runtime-id "$RUNTIME_ID"

cat > "$ENV_FILE" <<EOF
EMPEROR_CLAW_API_URL=$API_URL
EMPEROR_CLAW_API_TOKEN=$TOKEN
EMPEROR_CLAW_AGENT_NAME=$AGENT_NAME
EMPEROR_CLAW_AGENT_PROFILE=$AGENT_PROFILE
EMPEROR_CLAW_RUNTIME_ID=$RUNTIME_ID
EMPEROR_CLAW_COMPANION_DIR=$COMPANION_DIR
EMPEROR_CLAW_STATE_DIR=$STATE_DIR
EMPEROR_CLAW_BRIDGE_STATE_PATH=$BRIDGE_STATE_PATH
EMPEROR_CLAW_BRAIN_AGENT_ID=$LOCAL_AGENT_ID
EMPEROR_CLAW_BRAIN_THINKING=$BRAIN_THINKING
EMPEROR_CLAW_AUTO_CLAIM=false
EMPEROR_CLAW_USE_EXECUTOR=false
EMPEROR_CLAW_DEBUG_PROMPTS=false
OPENCLAW_CLI_PATH=$OPENCLAW_CLI_PATH
OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT:-18789}
EOF
chmod 600 "$ENV_FILE"

cat > "$COMPANION_DIR/run-bridge.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/.env"
export EMPEROR_CLAW_CONFIG_PATH="$SCRIPT_DIR/bridge.config.json"
export EMPEROR_CLAW_RECONNECT_BASE_MS="${EMPEROR_CLAW_RECONNECT_BASE_MS:-2000}"
export EMPEROR_CLAW_RECONNECT_MAX_MS="${EMPEROR_CLAW_RECONNECT_MAX_MS:-60000}"
exec node "$SCRIPT_DIR/runtime/bridge.js"
EOF
chmod 755 "$COMPANION_DIR/run-bridge.sh"

if [[ -f "$LOCAL_DOCTOR_LOCAL_SH" ]]; then
  cp "$LOCAL_DOCTOR_LOCAL_SH" "$COMPANION_DIR/doctor.sh"
  chmod 755 "$COMPANION_DIR/doctor.sh"
fi

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
EnvironmentFile=$ENV_FILE
ExecStart=$COMPANION_DIR/run-bridge.sh
WorkingDirectory=$COMPANION_DIR
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  systemctl --user daemon-reload
  if [[ "$UPGRADE_MODE" == true ]] && systemctl --user is-active "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    echo "[emperor-claw] Upgrading, restarting bridge service..."
    systemctl --user restart "${SERVICE_NAME}.service" || true
  else
    systemctl --user enable "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
    systemctl --user restart "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  fi
  sleep 2
  if ! systemctl --user is-active --quiet "${SERVICE_NAME}.service"; then
    echo "[emperor-claw] systemd user service did not become active; starting bridge directly as fallback." >&2
    nohup "$COMPANION_DIR/run-bridge.sh" >/dev/null 2>&1 &
  fi
else
  echo "[emperor-claw] systemd --user not available; starting bridge directly." >&2
  nohup "$COMPANION_DIR/run-bridge.sh" >/dev/null 2>&1 &
fi

if [[ -x "$COMPANION_DIR/doctor.sh" ]]; then
  EMPEROR_CLAW_API_TOKEN="$TOKEN" EMPEROR_CLAW_COMPANION_DIR="$COMPANION_DIR" "$COMPANION_DIR/doctor.sh" || true
fi
"$OPENCLAW_CLI_PATH" agent --agent "$LOCAL_AGENT_ID" --message "Reply exactly with: ${AGENT_NAME} brain OK" --thinking "$BRAIN_THINKING" --timeout 60 --json >/dev/null

echo "Installed Emperor Claw companion v2"
echo "- API URL: $API_URL"
echo "- Companion dir: $COMPANION_DIR"
echo "- Local brain agent: $LOCAL_AGENT_ID"
echo "- Service: ${SERVICE_NAME}.service"
echo "- Env file: $ENV_FILE"
