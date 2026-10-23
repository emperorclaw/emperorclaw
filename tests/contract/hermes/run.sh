#!/usr/bin/env bash
# One command: build the Hermes v0.22.4 contract image and run the contract suites.
#
#   tests/contract/hermes/run.sh                        # CONTRACT_SUITE=probe (default) on HERMES_BASE=auto
#   tests/contract/hermes/run.sh all                    # probe + bridge (= CONTRACT_SUITE=all; CI adds HERMES_BASE=shipped)
#   RECORD_FIXTURES=1 tests/contract/hermes/run.sh      # also rewrite tests/fixtures/hermes-v0224/*.jsonl
#   PROBE_ONLY=27,28 tests/contract/hermes/run.sh       # a subset of the probe (self-contained scenarios only)
#   BRIDGE_ONLY=simple_turn CONTRACT_SUITE=bridge tests/contract/hermes/run.sh
#
# HERMES_BASE picks the image the harness is layered on:
#   shipped  build integrations/hermes (the managed image we ship) as $SHIPPED_IMAGE; fail if it does
#            not build or is not pinned to v0.22.4. CI uses this.
#   spike    the W0 spike's own pinned install (Dockerfile.spike-base). Useful while W6 rewrites the
#            shipped Dockerfile.
#   auto     (default) shipped if it builds and is pinned, else spike with a loud warning.
# SKIP_BUILD=1 reuses the existing $HERMES_CONTRACT_IMAGE.
# Exit code 0 = every required scenario passed. Needs Docker; network only for the image builds.
set -euo pipefail
CONTRACT_SUITE="${1:-${CONTRACT_SUITE:-probe}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERE="$ROOT/tests/contract/hermes"
HERMES_BASE="${HERMES_BASE:-auto}"
HERMES_COMMIT="4d04303818b61bf3aa09278af48356315515965b"
SHIPPED_IMAGE="${SHIPPED_IMAGE:-emperorclaw-hermes:ci}"
SPIKE_BASE_IMAGE="${SPIKE_BASE_IMAGE:-emperor-hermes-contract-base:v0.22.4}"
IMAGE="${HERMES_CONTRACT_IMAGE:-emperor-hermes-contract:v0.22.4}"
RESULTS="${RESULTS_DIR:-$HERE/results}"
mkdir -p "$RESULTS"
rm -rf "$RESULTS"/*.log "$RESULTS"/*.json "$RESULTS"/*.jsonl "$RESULTS"/*.yaml "$RESULTS"/bridge 2>/dev/null || true

# Docker Desktop on Windows (Git Bash) must not rewrite container paths; host paths go through
# host_path (cygpath -w) instead.
export MSYS_NO_PATHCONV=1
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

pinned() {  # pinned <image>: the image's Hermes checkout is exactly the v0.22.4 commit
    local sha
    sha="$(docker run --rm --entrypoint git "$1" -C /home/hermes/.hermes/hermes-agent rev-parse HEAD 2>/dev/null || true)"
    [ "$sha" = "$HERMES_COMMIT" ]
}

build_shipped() {
    echo "[run.sh] building the shipped image $SHIPPED_IMAGE from integrations/hermes"
    docker build -t "$SHIPPED_IMAGE" "$(host_path "$ROOT/integrations/hermes")" || return 1
    pinned "$SHIPPED_IMAGE" || { echo "[run.sh] $SHIPPED_IMAGE is not pinned to Hermes $HERMES_COMMIT" >&2; return 1; }
}

build_spike() {
    echo "[run.sh] building the spike base $SPIKE_BASE_IMAGE"
    docker build -f "$(host_path "$HERE/Dockerfile.spike-base")" -t "$SPIKE_BASE_IMAGE" "$(host_path "$ROOT")"
}

if [ "${SKIP_BUILD:-0}" != "1" ]; then
    case "$HERMES_BASE" in
        shipped) build_shipped; BASE_IMAGE="$SHIPPED_IMAGE" ;;
        spike) build_spike; BASE_IMAGE="$SPIKE_BASE_IMAGE" ;;
        auto)
            if build_shipped; then
                BASE_IMAGE="$SHIPPED_IMAGE"
            else
                echo "[run.sh] WARNING: the shipped image is not usable yet; falling back to the spike base." >&2
                echo "[run.sh] WARNING: this run does NOT prove the shipped image (CI uses HERMES_BASE=shipped)." >&2
                build_spike
                BASE_IMAGE="$SPIKE_BASE_IMAGE"
            fi ;;
        *) echo "[run.sh] HERMES_BASE must be shipped, spike or auto" >&2; exit 2 ;;
    esac
    echo "[run.sh] contract image $IMAGE on base $BASE_IMAGE"
    docker build --build-arg "BASE_IMAGE=$BASE_IMAGE" -f "$(host_path "$HERE/Dockerfile")" -t "$IMAGE" "$(host_path "$ROOT")"
    printf '%s\n' "$BASE_IMAGE" > "$RESULTS/base-image.txt"
fi

# SYS_PTRACE: ws_drop_replay borrows the bridge's socket with pidfd_getfd(2), which
# hosted CI runners refuse without it (Docker Desktop allows it by default).
args=(--rm --name "hermes-contract-$$" --cap-add SYS_PTRACE -v "$(host_path "$RESULTS"):/results"
      -e "CONTRACT_SUITE=$CONTRACT_SUITE")
if [ "${RECORD_FIXTURES:-0}" = "1" ]; then
    mkdir -p "$ROOT/tests/fixtures/hermes-v0224"
    args+=(-v "$(host_path "$ROOT/tests/fixtures/hermes-v0224"):/fixtures" -e PROBE_FIXTURES_DIR=/fixtures)
fi
for var in PROBE_LATENCY_RUNS PROBE_ONLY BRIDGE_ONLY BRIDGE_CONTRACT_REQUIRE; do
    if [ -n "${!var:-}" ]; then args+=(-e "$var=${!var}"); fi
done

docker run "${args[@]}" "$IMAGE"
