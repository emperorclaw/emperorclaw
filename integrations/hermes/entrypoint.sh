#!/bin/sh
set -e

PROFILE_NAME="${EMPEROR_CLAW_AGENT_NAME:?EMPEROR_CLAW_AGENT_NAME is required}"
ROLE="${EMPEROR_CLAW_AGENT_ROLE:-operator}"

echo "[entrypoint] hermes profile create $PROFILE_NAME"
hermes profile create "$PROFILE_NAME" --clone --description "$ROLE" || true

# `hermes profile create` also writes the per-profile wrapper at
# ~/.local/bin/<profile>, which the bridge uses as HERMES_BIN. That directory
# is NOT on the persisted profile volume (/home/hermes/.hermes/profiles), so a
# recreate (retry, image update, key rotation) finds the profile already
# present, `create` fails with "already exists", and the wrapper is never
# rebuilt — every turn then dies with "No such file or directory:
# /home/hermes/.local/bin/<profile>". Recreate the wrapper explicitly when it
# is missing; its contents mirror what `hermes profile create` generates.
WRAPPER="$HOME/.local/bin/$PROFILE_NAME"
if [ ! -x "$WRAPPER" ]; then
    echo "[entrypoint] recreating missing profile wrapper $WRAPPER"
    mkdir -p "$HOME/.local/bin"
    printf '#!/bin/sh\nexec /home/hermes/.local/bin/hermes -p "%s" "$@"\n' "$PROFILE_NAME" > "$WRAPPER"
    chmod +x "$WRAPPER"
fi

PLUGIN_DIR="$HOME/.hermes/profiles/$PROFILE_NAME/plugins/emperor-claw"
mkdir -p "$PLUGIN_DIR"
cp -R /opt/emperor-claw-plugin/* "$PLUGIN_DIR/"

echo "[entrypoint] hermes plugins enable emperor-claw"
hermes -p "$PROFILE_NAME" plugins enable emperor-claw || true

# A freshly cloned profile inherits whatever provider the base image's
# default profile happens to have (observed: OpenRouter, regardless of what
# the operator picked in EmperorClaw). Setting EMPEROR_CLAW_LLM_PROVIDER (or
# OPENAI_API_KEY etc.) as a bare env var does NOT change this — the CLI's
# per-profile config.yaml is what actually decides which endpoint/auth Hermes
# calls. Explicitly point the profile at the right provider before starting
# the bridge; otherwise every reply fails with an auth error against whatever
# provider the profile happened to inherit, using no key at all for it.
if [ -n "$EMPEROR_CLAW_LLM_PROVIDER" ]; then
    echo "[entrypoint] configuring model provider: $EMPEROR_CLAW_LLM_PROVIDER"
    # Hermes' providers are a fixed plugin registry (ls
    # ~/.hermes/hermes-agent/plugins/model-providers/) — there is no plain
    # "openai" plugin; direct OpenAI access goes through the generic "custom"
    # provider with an explicit base_url. Google/Grok are named "gemini"/"xai"
    # in that registry, not "google"/"grok". Only OpenAI, DeepSeek,
    # and OpenRouter have been live-verified with a real key and a
    # real reply; the others use registry-confirmed plugin names but are
    # best-effort.
    case "$EMPEROR_CLAW_LLM_PROVIDER" in
        openai)
            hermes -p "$PROFILE_NAME" config set model.provider custom || true
            hermes -p "$PROFILE_NAME" config set model.base_url https://api.openai.com/v1 || true
            DEFAULT_MODEL="gpt-4o-mini"
            ;;
        anthropic)
            hermes -p "$PROFILE_NAME" config set model.provider anthropic || true
            hermes -p "$PROFILE_NAME" config unset model.base_url || true
            DEFAULT_MODEL="claude-3-5-haiku-latest"
            ;;
        google)
            hermes -p "$PROFILE_NAME" config set model.provider gemini || true
            hermes -p "$PROFILE_NAME" config unset model.base_url || true
            DEFAULT_MODEL="gemini-1.5-flash"
            ;;
        openrouter)
            hermes -p "$PROFILE_NAME" config set model.provider openrouter || true
            hermes -p "$PROFILE_NAME" config unset model.base_url || true
            # Free by default so an OpenRouter worker can reply at zero cost
            # when the operator leaves the model blank.
            DEFAULT_MODEL="nvidia/nemotron-3-ultra-550b-a55b:free"
            ;;
        grok)
            hermes -p "$PROFILE_NAME" config set model.provider xai || true
            hermes -p "$PROFILE_NAME" config unset model.base_url || true
            DEFAULT_MODEL="grok-2-latest"
            ;;
        deepseek)
            hermes -p "$PROFILE_NAME" config set model.provider deepseek || true
            hermes -p "$PROFILE_NAME" config unset model.base_url || true
            DEFAULT_MODEL="deepseek-chat"
            ;;
        *)
            DEFAULT_MODEL=""
            ;;
    esac
    MODEL="${EMPEROR_CLAW_LLM_MODEL:-$DEFAULT_MODEL}"
    if [ -n "$MODEL" ]; then
        hermes -p "$PROFILE_NAME" config set model.default "$MODEL" || true
    fi
    # A cloned profile inherits agent.reasoning_effort: medium, which several
    # non-reasoning models (gpt-4o-mini among them) reject outright with an
    # HTTP 400 rather than ignoring — confirmed live. `config unset` here
    # does NOT work (the CLI falls back to its own internal default of
    # "medium" regardless) — only an explicit "none" value actually
    # suppresses the parameter, confirmed live.
    hermes -p "$PROFILE_NAME" config set agent.reasoning_effort none || true
fi

# Hermes' tool-loop guardrail is warning-only on CLI sessions by default, and
# the bridge runs `hermes chat` as exactly that. An agent that keeps calling a
# tool that keeps failing (a rejected task body, a bad argument) then loops
# until the 500-iteration cap instead of replying. Enable the hard stop so the
# turn ends with a short explanation. Legitimate iteration is unaffected: any
# successful mutating call resets the failure streak.
echo "[entrypoint] enabling tool-loop guardrail hard stop"
hermes -p "$PROFILE_NAME" config set tool_loop_guardrails.hard_stop_enabled true || true

# `hermes chat -q` runs under Hermes' CLI platform hint, which tells the model
# "Markdown does NOT render — write plain text". Emperor's chat renders
# Markdown (and, on servers that advertise it, charts/tabs/widgets — the bridge
# adds that guide per turn), so replace the hint instead of contradicting it
# on every turn. `replace` is Hermes' documented platform_hints override.
echo "[entrypoint] setting Emperor chat formatting hint"
hermes -p "$PROFILE_NAME" config set platform_hints.cli.replace "You are replying through Emperor Claw's web chat, a graphical chat app, not a terminal. GitHub-flavored Markdown renders: headings, bold, lists, tables, code blocks, links. Format for a reader: short paragraphs, tables for tabular data. Deliver files through Emperor Storage (emperor_upload_artifact) and cite the artifact; MEDIA: tags are not intercepted here." || true

# Connect this profile to Emperor's own real MCP server (/mcp) as an
# additional MCP connection — alongside, not instead of, the emperor-claw
# plugin's REST-backed tools above. `hermes mcp add --auth header` always
# prompts interactively for the token (no scriptable flag for it), so this
# writes the same config it would produce directly: a `${VAR}`-templated
# header in config.yaml (hermes_cli/mcp_config.py's _bearer_auth_headers
# format) plus the actual secret in the profile's .env — confirmed live
# against a running container that `hermes mcp test emperorclaw` connects
# and discovers all 19 tools, and that a real chat turn actually calls one
# (list_agents) and gets a correct answer, with zero HERMES_TOOLSETS change.
if [ -n "$EMPEROR_CLAW_API_URL" ] && [ -n "$EMPEROR_CLAW_API_TOKEN" ]; then
    echo "[entrypoint] connecting profile to Emperor's MCP server"
    hermes -p "$PROFILE_NAME" config set mcp_servers.emperorclaw.url "${EMPEROR_CLAW_API_URL}/mcp" || true
    hermes -p "$PROFILE_NAME" config set 'mcp_servers.emperorclaw.headers.Authorization' 'Bearer ${MCP_EMPERORCLAW_API_KEY}' || true
    # Idempotent: the profile now lives on a persisted named volume, so a
    # recreate would otherwise append a SECOND MCP_EMPERORCLAW_API_KEY line and
    # leave a stale token behind that a "first wins" env loader could pick.
    # Replace the existing line instead of appending.
    ENV_FILE="$HOME/.hermes/profiles/$PROFILE_NAME/.env"
    touch "$ENV_FILE"
    sed -i "/^MCP_EMPERORCLAW_API_KEY=/d" "$ENV_FILE"
    echo "MCP_EMPERORCLAW_API_KEY=${EMPEROR_CLAW_API_TOKEN}" >> "$ENV_FILE"
fi

# Point the bridge's `hermes` subprocess calls at this agent's own profile.
# `hermes profile create` generates a per-profile wrapper at
# ~/.local/bin/<profile> that execs `hermes -p <profile> "$@"` (verified by
# actually building this image and running the two commands above against
# the real installer). Setting HERMES_BIN to that wrapper is how the bridge
# (which reads HERMES_BIN from its own env,
# see emperor_hermes_bridge.py) ends up calling `hermes -p "$PROFILE_NAME"
# chat ...` for every invocation instead of whatever profile is the CLI's
# sticky default — HERMES_HOME/HERMES_PROFILE env vars alone do NOT select
# the profile in this Hermes version (confirmed: `hermes profile list` still
# shows the default profile marked regardless of those two vars).
export HERMES_BIN="$HOME/.local/bin/$PROFILE_NAME"

# Point Hermes at this agent's profile home. Hermes reads/writes its per-profile
# state (the session store at $HERMES_HOME/state.db, logs at
# $HERMES_HOME/logs/agent.log) under HERMES_HOME, and the bridge reads both to
# surface the agent's reasoning and live tool activity in the chat. Unset, the
# bridge finds neither and every turn falls back to a bare elapsed-time status.
# This matches the documented layout HERMES_HOME=<root>/profiles/<name>.
export HERMES_HOME="$HOME/.hermes/profiles/$PROFILE_NAME"

echo "[entrypoint] starting bridge"
exec python /opt/emperor-claw-plugin/bridge/emperor_hermes_bridge.py
