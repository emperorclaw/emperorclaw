#!/bin/sh
# Container entrypoint for the Hermes v0.22.4 gateway contract harness.
#
#   run_contract.sh                     run $CONTRACT_SUITE (probe|bridge|all, default probe); exit code = verdict
#   run_contract.sh probe|bridge|all    same, suite given explicitly
#   run_contract.sh shell               set up the profile and fakes, then keep the container alive
#   run_contract.sh <cmd...>            set up, then exec <cmd...>
#
# probe  = gateway_probe.py: the Hermes protocol contract (owns its gateway, profile "spike").
# bridge = bridge_contract.py: bridge 0.9 (python -m emperor_bridge) against real gateways and the
#          fake Emperor (owns its own profiles). Skips with a clear message while the package is
#          missing, unless BRIDGE_CONTRACT_REQUIRE=1 (CI).
#
# Never uses real provider keys: the profile's only model route is the loopback fake provider.
set -eu

PROFILE="${HERMES_PROBE_PROFILE:-spike}"
FAKE_PORT="${FAKE_LLM_PORT:-8765}"
ECHO_PORT="${EMPEROR_ECHO_PORT:-8799}"
RESULTS="${PROBE_RESULTS_DIR:-/results}"
# The v0.22.4 installer keeps its venv under ~/.hermes/installs/<id>/environments/<hash>/venv.
# The shipped image links it to ~/.local/bin/hermes-venv-python (design D17); the spike base does not.
HERMES_PY="${HERMES_PYTHON:-}"
[ -x "$HERMES_PY" ] || HERMES_PY="$HOME/.local/bin/hermes-venv-python"
[ -x "$HERMES_PY" ] || HERMES_PY="$(ls -d "$HOME"/.hermes/installs/*/environments/*/venv/bin/python 2>/dev/null | head -1)"
[ -x "$HERMES_PY" ] || { echo "[harness] Hermes venv python not found" >&2; exit 2; }
export HERMES_PY
PROFILE_HOME="$HOME/.hermes/profiles/$PROFILE"

mkdir -p "$RESULTS"
export FAKE_LLM_LOG="$RESULTS/fake_llm_requests.jsonl"
export EMPEROR_ECHO_LOG="$RESULTS/emperor_echo_requests.jsonl"
: > "$FAKE_LLM_LOG"
: > "$EMPEROR_ECHO_LOG"

echo "[harness] hermes: $(hermes --version 2>/dev/null | head -1)"
echo "[harness] hermes-agent HEAD: $(git -C "$HERMES_REPO" rev-parse HEAD)"

# 1. Loopback fakes: OpenAI-compatible model + an Emperor API echo for the plugin.
PYTHONPATH="$HERMES_REPO" "$HERMES_PY" /opt/contract/fake_llm.py "$FAKE_PORT" > "$RESULTS/fake_llm.log" 2>&1 &
# The fake Emperor runs on the Hermes venv python too: it is stdlib-only, and that proves it on 3.14-era venvs.
"$HERMES_PY" /opt/contract/emperor_echo.py "$ECHO_PORT" > "$RESULTS/emperor_echo.log" 2>&1 &

# 2. Named profile, standalone gateway, routed to the fake (protocol doc 1.3 shape A, 7).
if [ ! -d "$PROFILE_HOME" ]; then
    hermes profile create "$PROFILE" > "$RESULTS/profile_create.log" 2>&1 || true
fi
mkdir -p "$PROFILE_HOME/plugins"
cat > "$PROFILE_HOME/config.yaml" <<EOF
model:
  provider: custom
  base_url: http://127.0.0.1:$FAKE_PORT/v1
  default: fake-model
  context_length: 128000
  key_env: FAKE_MODEL_KEY
agent:
  api_max_retries: 1
  reasoning_effort: none
gateway:
  standalone: true
  unmanaged_idle_exit_seconds: 0
approvals:
  mode: manual
  timeout: ${PROBE_APPROVAL_TIMEOUT:-20}
terminal:
  client_env_passthrough:
    - EMPEROR_CLAW_TURN_THREAD_ID
    - EMPEROR_CLAW_TURN_MESSAGE_ID
    - EMPEROR_CLAW_API_TOKEN
    - EMPEROR_THREAD_ID
    - EMPEROR_THREAD_TYPE
    - EMPEROR_SESSION_GEN
    - HERMES_PROBE_PREFIXED
telemetry:
  shared_metrics:
    enabled: false
    send: false
EOF
# Credentials live in the profile .env (the probe rewrites it to test rotation).
cat > "$PROFILE_HOME/.env" <<EOF
FAKE_MODEL_KEY=sk-fake-boot
EMPEROR_PROBE_DOTENV=dotenv-v1
EOF
chmod 600 "$PROFILE_HOME/.env"

rm -rf "$PROFILE_HOME/plugins/emperor-claw" "$PROFILE_HOME/plugins/envprobe"
cp -R /opt/emperor-claw-plugin "$PROFILE_HOME/plugins/emperor-claw"
cp -R /opt/contract/envprobe "$PROFILE_HOME/plugins/envprobe"
hermes -p "$PROFILE" plugins enable emperor-claw > "$RESULTS/plugins_enable.log" 2>&1 || true
hermes -p "$PROFILE" plugins enable envprobe >> "$RESULTS/plugins_enable.log" 2>&1 || true
# Keep the offer answered at the installed version so no interactive prompt can block.
OFFER_VERSION="$(cd "$HERMES_REPO" && "$HERMES_PY" -c "from hermes_cli.observability.shared_metrics_consent import OFFER_VERSION as v; print(v)" 2>/dev/null || echo 1)"
hermes -p "$PROFILE" config set telemetry.shared_metrics.offer_version "$OFFER_VERSION" > /dev/null 2>&1 || true

# Emperor's production profile defaults (src/lib/hermes-profile-defaults.ts), applied the way
# integrations/hermes/entrypoint.sh applies them.
for kv in compression.threshold_tokens=80000 compression.proactive_prune_tokens=48000           compression.idle_compact_after_seconds=0 approvals.single_query_mode=approve           tools.tool_search.enabled=off; do
    hermes -p "$PROFILE" config set "${kv%%=*}" "${kv#*=}" > /dev/null 2>&1 </dev/null || true
done

cp "$PROFILE_HOME/config.yaml" "$RESULTS/profile_config.yaml"

# Wait for the fakes.
for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:$FAKE_PORT/v1/models" > /dev/null 2>&1 \
        && curl -fsS "http://127.0.0.1:$ECHO_PORT/healthz" > /dev/null 2>&1; then
        break
    fi
    sleep 0.1
done

export HERMES_PROBE_PROFILE="$PROFILE" HERMES_PROBE_HOME="$PROFILE_HOME" PROBE_RESULTS_DIR="$RESULTS"
export EMPEROR_ECHO_URL="http://127.0.0.1:$ECHO_PORT"

export FAKE_LLM_URL="http://127.0.0.1:$FAKE_PORT/v1"

run_suites() {
    suite="$1"
    rc=0
    echo "[harness] CONTRACT_SUITE=$suite"
    case "$suite" in
        probe|all)
            /opt/probe/bin/python /opt/contract/gateway_probe.py || rc=1 ;;
    esac
    case "$suite" in
        bridge|all)
            /opt/probe/bin/python /opt/contract/bridge_contract.py || rc=1 ;;
    esac
    case "$suite" in
        probe|bridge|all) ;;
        *) echo "[harness] unknown CONTRACT_SUITE '$suite' (probe|bridge|all)" >&2; rc=2 ;;
    esac
    echo "[harness] verdict rc=$rc"
    return "$rc"
}

mode="${1:-}"
case "$mode" in
    ""|suite) run_suites "${CONTRACT_SUITE:-probe}"; exit $? ;;
    probe|bridge|all) run_suites "$mode"; exit $? ;;
    shell) echo "[harness] ready; docker exec into this container"; exec sleep infinity ;;
    *) exec "$@" ;;
esac
