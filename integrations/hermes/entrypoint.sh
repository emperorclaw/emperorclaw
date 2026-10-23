#!/bin/sh
# Managed-mode (Docker) entrypoint for one Emperor Claw Hermes agent.
# Design: docs/design/hermes-persistent-runtime.md section 7.3.
#
# Runs under `tini -g`. Prepares the agent's Hermes profile on the persisted volume, then execs
# the bridge, which supervises the standalone gateway itself (emperor_bridge/supervisor.py):
#
#   /entrypoint.sh              prepare, then exec "$HERMES_PYTHON" -m emperor_bridge run
#   /entrypoint.sh <cmd...>     prepare, then exec <cmd...> (contract tests, debugging)
#   EMPEROR_HERMES_ENTRY=gateway-only
#                               prepare, then supervise the gateway without a bridge (diagnostics)
#
# Every start re-applies the profile config, so a recreated container (image update, key
# rotation, crash repair) converges on the current settings even when it was created with an
# older environment.
set -eu

log() { printf '[entrypoint] %s\n' "$*" >&2; }
fail() { code="$1"; shift; log "FATAL: $*"; exit "$code"; }

PROFILE_NAME="${EMPEROR_CLAW_AGENT_NAME:-}"
[ -n "$PROFILE_NAME" ] || fail 64 "EMPEROR_CLAW_AGENT_NAME is required (it names the Hermes profile)"
ROLE="${EMPEROR_CLAW_AGENT_ROLE:-operator}"
ENTRY="${EMPEROR_HERMES_ENTRY:-bridge}"
HERMES_PYTHON="${HERMES_PYTHON:-$HOME/.local/bin/hermes-venv-python}"
HERMES_CHECKOUT="${HERMES_CHECKOUT:-$HOME/.hermes/hermes-agent}"
PROFILE_HOME="$HOME/.hermes/profiles/$PROFILE_NAME"
ENV_FILE="$PROFILE_HOME/.env"
PINNED_VERSION="${EMPEROR_HERMES_PINNED_VERSION:-0.22.4}"
STARTED_AT="$(date +%s)"

# ── preflight: fail before touching the profile ─────────────────────────────────────────────
[ -x "$HERMES_PYTHON" ] || fail 70 "Hermes venv python not found at $HERMES_PYTHON (the image build links it; rebuild the image)"
command -v hermes >/dev/null 2>&1 || fail 70 "hermes launcher not on PATH"

case "$ENTRY" in
    bridge | gateway-only) ;;
    *) fail 64 "EMPEROR_HERMES_ENTRY must be 'bridge' or 'gateway-only', got '$ENTRY'" ;;
esac

if [ "$#" -eq 0 ] && [ "$ENTRY" = bridge ]; then
    # The bridge entry point is `python -m emperor_bridge` (emperor_bridge/__main__.py, bridge 0.9).
    if ! "$HERMES_PYTHON" -c 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("emperor_bridge.__main__") else 1)' 2>/dev/null; then
        fail 78 "bridge entry point missing: '$HERMES_PYTHON -m emperor_bridge' needs emperor_bridge/__main__.py under PYTHONPATH=${PYTHONPATH:-<unset>}. This image does not contain bridge 0.9. Rebuild it, or set EMPEROR_HERMES_ENTRY=gateway-only to run the supervised gateway alone."
    fi
fi

# ── profile ─────────────────────────────────────────────────────────────────────────────────
if [ ! -f "$PROFILE_HOME/config.yaml" ]; then
    log "hermes profile create $PROFILE_NAME"
    hermes profile create "$PROFILE_NAME" --clone --description "$ROLE" </dev/null \
        || log "profile create returned non-zero; continuing with the existing profile"
fi
[ -d "$PROFILE_HOME" ] || fail 70 "profile home $PROFILE_HOME was not created"

# Back up state.db once, before Hermes v0.22 first opens it (the volume may hold an older one).
VERSION_MARK="$PROFILE_HOME/.emperor-hermes-version"
if [ -f "$PROFILE_HOME/state.db" ] && [ ! -f "$VERSION_MARK" ] && [ ! -e "$PROFILE_HOME/state.db.pre-v0.22" ]; then
    log "backing up state.db to state.db.pre-v0.22"
    "$HERMES_PYTHON" - "$PROFILE_HOME/state.db" "$PROFILE_HOME/state.db.pre-v0.22" <<'PY' || fail 73 "state.db backup failed"
import sqlite3, sys
src, dst = sqlite3.connect(sys.argv[1]), sqlite3.connect(sys.argv[2])
with dst:
    src.backup(dst)
src.close()
dst.close()
PY
fi
printf '%s\n' "$PINNED_VERSION" > "$VERSION_MARK"

# Plugin: replace the whole directory so files removed upstream do not linger on the volume.
PLUGIN_DIR="$PROFILE_HOME/plugins/emperor-claw"
rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"
cp -R /opt/emperor-claw-plugin/. "$PLUGIN_DIR/"

# ── config.yaml ─────────────────────────────────────────────────────────────────────────────
# Pairs are collected in order and applied in one batch. Later pairs win, so the hard-applied
# keys go last.
CONFIG_PAIRS="$(mktemp)"
trap 'rm -f "$CONFIG_PAIRS"' EXIT
cfg() { printf 'set\t%s\t%s\n' "$1" "$2" >> "$CONFIG_PAIRS"; }
hard() { printf 'hard\t%s\t%s\n' "$1" "$2" >> "$CONFIG_PAIRS"; }
cfg_unset() { printf 'unset\t%s\t\n' "$1" >> "$CONFIG_PAIRS"; }

# Model provider. A cloned profile inherits the base image's provider, so set it explicitly.
# Hermes' provider registry has no "openai" plugin (direct OpenAI goes through "custom" with a
# base_url) and names Google/Grok "gemini"/"xai". OpenAI, DeepSeek and OpenRouter are
# live-verified; the others use registry names and are best effort.
DEFAULT_MODEL=""
case "${EMPEROR_CLAW_LLM_PROVIDER:-}" in
    openai) cfg model.provider custom; cfg model.base_url https://api.openai.com/v1; DEFAULT_MODEL="gpt-4o-mini" ;;
    anthropic) cfg model.provider anthropic; cfg_unset model.base_url; DEFAULT_MODEL="claude-3-5-haiku-latest" ;;
    google) cfg model.provider gemini; cfg_unset model.base_url; DEFAULT_MODEL="gemini-1.5-flash" ;;
    openrouter) cfg model.provider openrouter; cfg_unset model.base_url; DEFAULT_MODEL="nvidia/nemotron-3-ultra-550b-a55b:free" ;;
    grok) cfg model.provider xai; cfg_unset model.base_url; DEFAULT_MODEL="grok-2-latest" ;;
    deepseek) cfg model.provider deepseek; cfg_unset model.base_url; DEFAULT_MODEL="deepseek-chat" ;;
    "") ;;
    *) log "unknown EMPEROR_CLAW_LLM_PROVIDER '${EMPEROR_CLAW_LLM_PROVIDER}': leaving the profile's model provider as is" ;;
esac
if [ -n "${EMPEROR_CLAW_LLM_PROVIDER:-}" ]; then
    MODEL="${EMPEROR_CLAW_LLM_MODEL:-$DEFAULT_MODEL}"
    [ -n "$MODEL" ] && cfg model.default "$MODEL"
    # Non-reasoning models (gpt-4o-mini among them) reject the inherited "medium" with HTTP 400,
    # and `config unset` falls back to "medium" again: only an explicit "none" suppresses it.
    cfg agent.reasoning_effort none
fi

# Stop a tool loop that keeps failing instead of running to the 500-iteration cap.
cfg tool_loop_guardrails.hard_stop_enabled true

# Emperor's chat renders Markdown; replace Hermes' plain-text terminal hint instead of
# contradicting it on every turn.
cfg platform_hints.cli.replace "You are replying through Emperor Claw's web chat, a graphical chat app, not a terminal. GitHub-flavored Markdown renders: headings, bold, lists, tables, code blocks, links. Format for a reader: short paragraphs, tables for tabular data. Deliver files through Emperor Storage (emperor_upload_artifact) and cite the artifact; MEDIA: tags are not intercepted here."

# Emperor's own MCP server, next to the plugin's REST tools. The header is a ${VAR} template;
# the secret itself lives in the profile .env (below).
if [ -n "${EMPEROR_CLAW_API_URL:-}" ] && [ -n "${EMPEROR_CLAW_API_TOKEN:-}" ]; then
    cfg mcp_servers.emperorclaw.url "${EMPEROR_CLAW_API_URL}/mcp"
    # shellcheck disable=SC2016 # literal ${...}: Hermes expands it from the profile .env
    cfg mcp_servers.emperorclaw.headers.Authorization 'Bearer ${MCP_EMPERORCLAW_API_KEY}'
fi

# Headless container: answer the shared-metrics offer (declined) so no prompt can block a start.
cfg telemetry.shared_metrics.enabled false
cfg telemetry.shared_metrics.send false

# Server-provided defaults (src/lib/hermes-profile-defaults.ts), one key=value per line, split on
# the first "=". Containers created by an older server pass an older list; the hard keys below
# still win.
if [ -n "${EMPEROR_CLAW_HERMES_CONFIG_DEFAULTS:-}" ]; then
    printf '%s\n' "$EMPEROR_CLAW_HERMES_CONFIG_DEFAULTS" | while IFS='=' read -r key value; do
        [ -n "$key" ] && cfg "$key" "$value"
    done
fi

# Hard-applied on every start, whatever the container's environment says (design 7.3):
# standalone gateway that never idle-exits, a 30 s drain (the gateway exits ~20 s after it, ~50.5 s)
# inside the supervisor's 55 s SIGKILL deadline and Docker's
# 75 s stop budget, 60 s approval and clarify backstops, no auxiliary title calls, direct plugin tools, and
# the per-session client_env names the plugin reads through bound_client_env(). "hard" pairs are
# critical: the container refuses to start when one cannot be written.
hard gateway.standalone true
hard gateway.unmanaged_idle_exit_seconds 0
hard agent.restart_drain_timeout 30
hard agent.clarify_timeout 60
hard approvals.timeout 60
hard auxiliary.title_generation.enabled false
hard tools.tool_search.enabled off
hard terminal.client_env_passthrough '["EMPEROR_THREAD_ID","EMPEROR_THREAD_TYPE","EMPEROR_SESSION_GEN","EMPEROR_AGENT_ID","EMPEROR_PROFILE_HOME"]'

# One process through Hermes' own config writer (same coercion as `hermes config set`, ~0.3 s for
# all keys instead of ~1 s per CLI call). Exit 3 = API not importable -> CLI fallback below.
# Exit 4 = a hard key failed.
apply_config_batch() {
    HERMES_HOME="$PROFILE_HOME" "$HERMES_PYTHON" - "$CONFIG_PAIRS" <<'PY'
import contextlib, io, sys
try:
    from hermes_cli.config import set_config_value, unset_config_value
except Exception as exc:
    print(f"[entrypoint] Hermes config API unavailable ({exc!r}); using the CLI", file=sys.stderr)
    sys.exit(3)
pairs = []
with open(sys.argv[1], encoding="utf-8") as fh:
    for line in fh:
        kind, _, rest = line.rstrip("\n").partition("\t")
        key, _, value = rest.partition("\t")
        if key:
            pairs.append((kind, key, value))
try:  # answer the shared-metrics offer at the installed version: no consent prompt can block
    from hermes_cli.observability.shared_metrics_consent import OFFER_VERSION
    pairs.append(("set", "telemetry.shared_metrics.offer_version", str(OFFER_VERSION)))
except Exception:
    pass
failed, hard_failed = [], []
for kind, key, value in pairs:
    ok = True
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            if kind == "unset":
                unset_config_value(key)
            else:
                set_config_value(key, value)
    except SystemExit as exc:
        ok = exc.code in (None, 0)
    except Exception as exc:
        ok = False
        print(f"[entrypoint] config {key}: {exc!r}", file=sys.stderr)
    if not ok and kind != "unset":
        (hard_failed if kind == "hard" else failed).append(key)
print(f"[entrypoint] profile config: {len(pairs) - len(failed) - len(hard_failed)}/{len(pairs)} keys applied", file=sys.stderr)
if failed:
    print("[entrypoint] warning: not applied: " + ", ".join(failed), file=sys.stderr)
if hard_failed:
    print("[entrypoint] FATAL: required keys not applied: " + ", ".join(hard_failed), file=sys.stderr)
    sys.exit(4)
PY
}

apply_config_cli() {
    tab="$(printf '\t')"
    while IFS="$tab" read -r kind key value; do
        [ -n "$key" ] || continue
        if [ "$kind" = unset ]; then
            hermes -p "$PROFILE_NAME" config unset "$key" </dev/null >/dev/null 2>&1 || true
        elif ! hermes -p "$PROFILE_NAME" config set "$key" "$value" </dev/null >/dev/null 2>&1; then
            [ "$kind" = hard ] && fail 74 "required config key $key could not be set"
            log "warning: config set $key failed"
        fi
    done < "$CONFIG_PAIRS"
}

rc=0
apply_config_batch || rc=$?
case "$rc" in
    0) ;;
    3) apply_config_cli ;;
    *) fail 74 "profile config could not be applied (rc $rc)" ;;
esac
rm -f "$CONFIG_PAIRS"

hermes -p "$PROFILE_NAME" plugins enable emperor-claw </dev/null >/dev/null 2>&1 \
    || log "warning: plugins enable emperor-claw failed"

# ── profile .env ────────────────────────────────────────────────────────────────────────────
# The plugin and the bridge read credentials from the profile .env (D8), and at boot .env wins
# over the process environment, so a rotated key must be written here or the old one stays live.
umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

dotenv_value() {
    case "$1" in
        *[!A-Za-z0-9_./:@+,=%-]*) printf "'%s'" "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g")" ;;
        *) printf '%s' "$1" ;;
    esac
}

set_env() {
    key="$1"
    value="$2"
    sed -i -e "/^${key}=/d" -e "/^export ${key}=/d" "$ENV_FILE"
    case "$value" in
        *"
"*) log "skipping $key in .env: multi-line value"; return 0 ;;
    esac
    printf '%s=%s\n' "$key" "$(dotenv_value "$value")" >> "$ENV_FILE"
}

for key in EMPEROR_CLAW_API_URL EMPEROR_CLAW_API_TOKEN EMPEROR_CLAW_AGENT_ID EMPEROR_CLAW_AGENT_NAME \
    EMPEROR_CLAW_AGENT_ROLE EMPEROR_CLAW_RUNTIME_ID EMPEROR_CLAW_LLM_PROVIDER EMPEROR_CLAW_LLM_MODEL \
    EMPEROR_CLAW_HERMES_TOOLSETS EMPEROR_CLAW_HERMES_MAX_PARALLEL_TURNS EMPEROR_CLAW_HERMES_CWD \
    EMPEROR_CLAW_HERMES_COMPACT_AFTER_TOKENS EMPEROR_CLAW_HERMES_TURN_TIMEOUT_SECONDS \
    EMPEROR_CLAW_HERMES_TURN_IDLE_TIMEOUT_SECONDS OPENAI_API_KEY ANTHROPIC_API_KEY GOOGLE_API_KEY \
    OPENROUTER_API_KEY GROK_API_KEY DEEPSEEK_API_KEY; do
    eval "present=\${$key+x}"
    if [ -n "$present" ]; then
        eval "value=\${$key}"
        set_env "$key" "$value"
    fi
done
if [ -n "${EMPEROR_CLAW_API_TOKEN:-}" ]; then
    set_env MCP_EMPERORCLAW_API_KEY "$EMPEROR_CLAW_API_TOKEN"
fi

# ── hand over ───────────────────────────────────────────────────────────────────────────────
export EMPEROR_CLAW_HERMES_GATEWAY=managed HERMES_PROFILE="$PROFILE_NAME" HERMES_PYTHON HERMES_CHECKOUT
# Bridge 0.3 settings from containers created by older servers; bridge 0.9 does not use them.
unset HERMES_BIN HERMES_HOME HERMES_TOOLSETS 2>/dev/null || true

log "profile $PROFILE_NAME ready in $(( $(date +%s) - STARTED_AT )) s"
if [ "$#" -gt 0 ]; then
    exec "$@"
fi
if [ "$ENTRY" = gateway-only ]; then
    log "starting the supervised gateway without a bridge (EMPEROR_HERMES_ENTRY=gateway-only)"
    exec "$HERMES_PYTHON" -m emperor_bridge.supervisor run
fi
log "starting bridge"
exec "$HERMES_PYTHON" -m emperor_bridge run
