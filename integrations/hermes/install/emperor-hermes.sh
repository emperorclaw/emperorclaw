#!/usr/bin/env bash
# emperor-hermes: install, migrate, update and roll back Emperor Claw Hermes runtimes
# (bridge 0.9 + Hermes v0.22.4 gateway) on a remote Linux host, as systemd user units.
#
# Design: docs/design/hermes-persistent-runtime.md §8 (installer), §10 (fleet runbook), D21.
# Run `emperor-hermes help` for usage. Never needs sudo.
#
# Layout it manages (all under the invoking user's $HOME):
#   ~/.config/emperor-hermes/host.env          install-specific paths for the units
#   ~/.config/systemd/user/emperor-hermes-*    unit templates (from the bridge bundle)
#   ~/.local/share/emperor-hermes/             python symlink, per-profile records, log
#   ~/.hermes/hermes-agent-v0.22.4/            pinned Hermes, side by side with the old one
#   ~/.hermes/emperor-bridge/releases/<ver>/   bridge bundles, `current` symlink
#   ~/.hermes/backups/emperor-hermes/          state.db, config, .env, plugin and unit backups
set -Eeuo pipefail
umask 077

readonly EMPEROR_HERMES_VERSION="0.19.0"
readonly HERMES_REF="v0.22.4"
readonly HERMES_SHA="4d04303818b61bf3aa09278af48356315515965b"
readonly HERMES_CODE_VERSION="${HERMES_REF#v}"
readonly RELEASE_BASE="${EMPEROR_HERMES_RELEASE_BASE:-https://github.com/emperorclaw/emperorclaw/releases/download}"
readonly CLIENT_ENV_PASSTHROUGH='["EMPEROR_THREAD_ID","EMPEROR_THREAD_TYPE","EMPEROR_SESSION_GEN","EMPEROR_AGENT_ID","EMPEROR_PROFILE_HOME"]'

# Memory model for `doctor --plan` (D21). MiB. Overridable for re-measured numbers.
readonly MIB_STANDALONE="${EMPEROR_HERMES_STANDALONE_MIB:-345}"     # warm gateway (~300) + bridge (~45)
readonly MIB_SHARED_GATEWAY="${EMPEROR_HERMES_SHARED_GATEWAY_MIB:-300}"
readonly MIB_SHARED_BRIDGE="${EMPEROR_HERMES_SHARED_BRIDGE_MIB:-60}"
readonly MIB_RESERVE="${EMPEROR_HERMES_RESERVE_MIB:-512}"
readonly MIB_R1_GATE="${EMPEROR_HERMES_R1_GATE_MIB:-450}"            # R-1 item 1: shared gateway RSS gate

readonly HERMES_ROOT="$HOME/.hermes"
readonly PROFILES_ROOT="$HERMES_ROOT/profiles"
readonly BRIDGE_ROOT="$HERMES_ROOT/emperor-bridge"
readonly BACKUP_ROOT="$HERMES_ROOT/backups/emperor-hermes"
readonly LEGACY_CHECKOUT="$HERMES_ROOT/hermes-agent"
readonly CONFIG_DIR="$HOME/.config/emperor-hermes"
readonly HOST_ENV="$CONFIG_DIR/host.env"
readonly UNIT_DIR="$HOME/.config/systemd/user"
readonly DATA_DIR="$HOME/.local/share/emperor-hermes"
readonly RECORDS_DIR="$DATA_DIR/profiles"
readonly HOST_STATE="$DATA_DIR/host.state"
readonly STABLE_PYTHON="$DATA_DIR/python"
readonly LOG_FILE="$DATA_DIR/emperor-hermes.log"
readonly LOCAL_HERMES="$HOME/.local/bin/hermes"
readonly DEFAULT_HERMES_DIR="$HERMES_ROOT/hermes-agent-${HERMES_REF}"

# Options (set by parse_args).
OPT_PROFILES=""
OPT_ALL=0
OPT_GATEWAY=""
OPT_HERMES_DIR=""
OPT_BUNDLE=""
OPT_VERSION=""
OPT_SKIP_BROWSER=0
OPT_YES=0
OPT_FORCE=0
OPT_TAKE_OVER=0
OPT_PLAN=0
OPT_MEASURE=0
OPT_WHEN_IDLE=0
OPT_SHARED=0
OPT_PURGE=0
OPT_BRIDGE_ONLY=0
OPT_RESTART_GATEWAYS=0
OPT_DISABLE_WATCHDOGS=0
OPT_MAX_PARALLEL=""
OPT_DELTA_MIB="${EMPEROR_HERMES_SHARED_DELTA_MIB:-40}"
OPT_TIMEOUT=900

# Runtime globals.
HERMES_DIR=""
HERMES_LAUNCHER=""
PLAN=""
PLAN_MOVE=""
LOCK_HELD=0
TMP_ROOT=""
CURRENT_PROFILES=""
LEGACY_STOPPED=0

# ── output ──────────────────────────────────────────────────────────────────────────────────

log() {
    printf '%s\n' "$*" >&2
    if [ -d "$DATA_DIR" ]; then
        printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE" 2>/dev/null || true
    fi
}
step() { log "==> $*"; }
warn() { log "warning: $*"; }
die() {
    log "error: $*"
    if [ "$LEGACY_STOPPED" = 1 ] && [ -n "$CURRENT_PROFILES" ]; then
        log "The 0.3 bridge is stopped for: $CURRENT_PROFILES. Fix the problem and re-run, or go back with:"
        log "  emperor-hermes rollback --profile ${CURRENT_PROFILES// /,}"
    fi
    exit 1
}

on_error() {
    local rc=$? line=$1
    log "error: command failed (rc=$rc) at line $line. Details: $LOG_FILE"
    if [ "$LEGACY_STOPPED" = 1 ] && [ -n "$CURRENT_PROFILES" ]; then
        log "To go back to the 0.3 bridge: emperor-hermes rollback --profile ${CURRENT_PROFILES// /,}"
    fi
}
trap 'on_error $LINENO' ERR

cleanup() {
    if [ "$LOCK_HELD" = 1 ]; then rm -rf "$DATA_DIR/lock"; fi
    if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then rm -rf "$TMP_ROOT"; fi
}
trap cleanup EXIT

usage() {
    cat <<EOF
emperor-hermes $EMPEROR_HERMES_VERSION: Emperor Claw Hermes runtime installer (Hermes $HERMES_REF)

Usage: emperor-hermes <command> [options]

Commands
  doctor [--plan|--measure] [--profiles a,b]
                       Preflight checks. --plan: memory/topology plan (standalone, shared or move).
                       --measure: RSS of running gateways and bridges (appends to measurements.jsonl).
  install --profile p[,q] [--gateway standalone|shared]
                       Install or re-apply bridge 0.9 for the profiles. Stops their 0.3 units first.
  migrate --all | --profile p   [--gateway standalone|shared]
                       Same as install, for every profile that has a 0.3 bridge unit.
  update [--bundle B] [--version V] [--restart-gateways]
                       Install a newer bridge bundle, re-resolve Hermes' Python, re-apply defaults.
  rollback --profile p | --all
                       Stop the 0.9 units, restore state.db/config/.env/plugin, restart the 0.3 unit.
  rollback --bridge-only
                       Point the bridge back at the previous bundle and restart the bridges.
  status [--profile p]  Gateway, bridge and legacy unit status. Exit 1 if anything is wrong.
  restart-gateway [--profile p | --shared] [--when-idle] [--timeout S]
  finalize [--purge]   After the soak: point ~/.local/bin/hermes at $HERMES_REF, retire the 0.3 units,
                       bridge file and old checkout (archived; --purge deletes it).
  version | help

Options
  --hermes-dir DIR     Hermes checkout (default: ~/.hermes/hermes-agent-$HERMES_REF, side by side)
  --bundle PATH|URL    Bridge bundle (emperor-hermes-bridge-<ver>.tar.gz). Default: the GitHub release.
  --skip-browser       Install Hermes without the browser toolset.
  --max-parallel N     Set EMPEROR_CLAW_HERMES_MAX_PARALLEL_TURNS in the profiles' .env.
  --delta-mib N        Shared-gateway memory per extra profile for --plan (default 40, see R-1).
  --yes                Accept the shared-gateway trade-off without the interactive prompt.
  --force              Override the memory plan and the duplicate-runtime guard.
  --take-over-gateway  Stop and disable Hermes gateways emperor-hermes did not start (for example
                       hermes-gateway-<profile>.service) that serve the same profiles. Rollback restores them.
  --disable-watchdogs  Stop and disable self-made systemd timers/services and comment out crontab lines
                       that would restart the 0.3 bridges (creating duplicate runtimes). Rollback restores them.
EOF
}

# ── small helpers ───────────────────────────────────────────────────────────────────────────

have() { command -v "$1" >/dev/null 2>&1; }
sc() { systemctl --user "$@"; }
unit_active() { systemctl --user is-active --quiet "$1" 2>/dev/null; }
unit_enabled() { systemctl --user is-enabled --quiet "$1" 2>/dev/null; }
unit_truly_enabled() { # unit -> 0 only when is-enabled reports a real "enabled" (static/indirect/generated/transient do not count)
    local out
    out=$(systemctl --user is-enabled "$1" 2>/dev/null) || return 1
    case "$out" in
        enabled | enabled-runtime | linked | linked-runtime | alias) return 0 ;;
        *) return 1 ;;
    esac
}

valid_profile() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]]; }
profile_home() { printf '%s/%s\n' "$PROFILES_ROOT" "$1"; }

split_csv() { # "a,b c" -> one per line, de-duplicated, order kept
    local item seen=","
    local IFS=$', \n\t'
    for item in $1; do
        [ -n "$item" ] || continue
        case "$seen" in *",$item,"*) continue ;; esac
        seen="$seen$item,"
        printf '%s\n' "$item"
    done
}
join_csv() { local IFS=,; printf '%s' "$*"; }
in_list() { # needle items...
    local needle=$1 item
    shift
    for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
    return 1
}

safe_value() { # values written to host.env / .env must not break quoting
    case "$1" in *'"'* | *\\* | *$'\n'* | *'$'* | *'`'*) return 1 ;; esac
}

# KEY=value files (.env, host.env, records). Never sourced: parsed.
env_get() {
    [ -f "$1" ] || return 0
    awk -v k="$2" -v q="'" '
        { line = $0; sub(/^[ \t]+/, "", line); sub(/^export[ \t]+/, "", line) }
        index(line, k "=") == 1 { v = substr(line, length(k) + 2); found = 1 }
        END {
            if (found) {
                if (v ~ /^".*"$/ || (substr(v, 1, 1) == q && substr(v, length(v), 1) == q)) v = substr(v, 2, length(v) - 2)
                print v
            }
        }' "$1"
}
env_has() { [ -f "$1" ] && grep -Eq "^[[:space:]]*(export[[:space:]]+)?$2=" "$1"; }
env_set() {
    local f=$1 k=$2 v=$3 tmp
    safe_value "$v" || die "refusing to write an unsafe value for $k"
    mkdir -p "$(dirname "$f")"
    tmp=$(mktemp "$f.XXXXXX")
    if [ -f "$f" ]; then
        awk -v k="$k" '{ line = $0; sub(/^[ \t]+/, "", line); sub(/^export[ \t]+/, "", line); if (index(line, k "=") == 1) next; print }' "$f" >"$tmp"
        chmod "$(stat -c %a "$f")" "$tmp"
    fi
    printf '%s="%s"\n' "$k" "$v" >>"$tmp"
    mv -f "$tmp" "$f"
}
env_unset() {
    local f=$1 k=$2 tmp
    [ -f "$f" ] || return 0
    tmp=$(mktemp "$f.XXXXXX")
    awk -v k="$k" '{ line = $0; sub(/^[ \t]+/, "", line); sub(/^export[ \t]+/, "", line); if (index(line, k "=") == 1) next; print }' "$f" >"$tmp"
    chmod "$(stat -c %a "$f")" "$tmp"
    mv -f "$tmp" "$f"
}

record_file() { printf '%s/%s.env\n' "$RECORDS_DIR" "$1"; }
rec_get() { env_get "$(record_file "$1")" "$2"; }
rec_set() { env_set "$(record_file "$1")" "$2" "$3"; }
managed_profiles() { # profiles with a record whose status is active
    local f p
    for f in "$RECORDS_DIR"/*.env; do
        [ -e "$f" ] || continue
        p=${f##*/}; p=${p%.env}
        [ "$(env_get "$f" status)" = active ] && printf '%s\n' "$p"
    done
    return 0
}
recorded_profiles() {
    local f p
    for f in "$RECORDS_DIR"/*.env; do
        [ -e "$f" ] || continue
        p=${f##*/}; printf '%s\n' "${p%.env}"
    done
    return 0
}

ln_atomic() { # target link
    local tmp="$2.new.$$"
    ln -sfn "$1" "$tmp"
    mv -Tf "$tmp" "$2"
}

ensure_tmp() { # sets TMP_ROOT once; call directly, never inside $(...)
    if [ -z "$TMP_ROOT" ]; then TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/emperor-hermes.XXXXXX"); fi
}

take_lock() {
    mkdir -p "$DATA_DIR"
    if ! mkdir "$DATA_DIR/lock" 2>/dev/null; then
        local pid
        pid=$(cat "$DATA_DIR/lock/pid" 2>/dev/null || true)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            die "another emperor-hermes run is in progress (pid $pid)"
        fi
        rm -rf "$DATA_DIR/lock"
        mkdir "$DATA_DIR/lock"
    fi
    printf '%s\n' "$$" >"$DATA_DIR/lock/pid"
    LOCK_HELD=1
}

helper_python() {
    if [ -x "$STABLE_PYTHON" ]; then printf '%s\n' "$STABLE_PYTHON"; else command -v python3; fi
}

confirm() { # prompt text -> 0 when accepted
    if [ "$OPT_YES" = 1 ]; then return 0; fi
    if [ ! -t 0 ]; then return 1; fi
    local answer
    printf '%s [type yes]: ' "$1" >&2
    read -r answer || return 1
    [ "$answer" = yes ]
}

# ── host.env ────────────────────────────────────────────────────────────────────────────────

host_get() { env_get "$HOST_ENV" "$1"; }
shared_list() { split_csv "$(host_get EMPEROR_HERMES_PROFILES)"; }
shared_csv() {
    local items=()
    mapfile -t items < <(shared_list)
    join_csv "${items[@]}"
}
in_shared() { # profile -> 0 when the shared bridge serves it
    local items=()
    mapfile -t items < <(shared_list)
    in_list "$1" "${items[@]}"
}

write_host_env() { # shared_profiles_csv
    local shared=$1 tmp v
    mkdir -p "$CONFIG_DIR"
    for v in "$HERMES_LAUNCHER" "$STABLE_PYTHON" "$HERMES_DIR" "$shared"; do
        safe_value "$v" || die "unsafe path for host.env: $v"
        case "$v" in *' '*) die "paths with spaces are not supported: $v" ;; esac
    done
    tmp=$(mktemp "$HOST_ENV.XXXXXX")
    {
        printf '# Written by emperor-hermes %s on %s. Do not edit: emperor-hermes update rewrites it.\n' \
            "$EMPEROR_HERMES_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf 'HERMES_LAUNCHER="%s"\n' "$HERMES_LAUNCHER"
        printf 'HERMES_PYTHON="%s"\n' "$STABLE_PYTHON"
        printf 'HERMES_CHECKOUT="%s"\n' "$HERMES_DIR"
        printf 'EMPEROR_HERMES_PROFILES="%s"\n' "$shared"
    } >"$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" "$HOST_ENV"
}

load_host() { # fill HERMES_DIR / HERMES_LAUNCHER from options or host.env
    HERMES_DIR=${OPT_HERMES_DIR:-$(host_get HERMES_CHECKOUT)}
    HERMES_DIR=${HERMES_DIR:-$DEFAULT_HERMES_DIR}
    HERMES_DIR=${HERMES_DIR%/}
    HERMES_LAUNCHER=$(launcher_for "$HERMES_DIR" || true)
    if [ "$CMD" = update ] && [ -z "$OPT_HERMES_DIR" ] && [ "$(checkout_head "$HERMES_DIR")" != "$HERMES_SHA" ]; then
        HERMES_DIR=$DEFAULT_HERMES_DIR # the pin moved: install the new version side by side
        HERMES_LAUNCHER=$(launcher_for "$HERMES_DIR" || true)
    fi
    return 0
}

# ── preflight ───────────────────────────────────────────────────────────────────────────────

ensure_user_bus() {
    if systemctl --user show-environment >/dev/null 2>&1; then return 0; fi
    if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
        XDG_RUNTIME_DIR="/run/user/$(id -u)"
        export XDG_RUNTIME_DIR
        if systemctl --user show-environment >/dev/null 2>&1; then return 0; fi
    fi
    return 1
}

linger_state() {
    if have loginctl; then
        loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || printf 'unknown\n'
    else
        printf 'unknown\n'
    fi
}

preflight() { # strict: 1 = fail on errors
    local strict=$1 problems=0 cmd
    [ "$(uname -s)" = Linux ] || die "Linux is required"
    [ "$(id -u)" != 0 ] || die "run emperor-hermes as the agents' user, not root"
    for cmd in curl git tar awk python3 systemctl; do
        if ! have "$cmd"; then log "  missing command: $cmd"; problems=$((problems + 1)); fi
    done
    if ensure_user_bus; then
        log "  systemd user bus: ok"
    else
        log "  systemd user bus: NOT reachable (log in over SSH, or set XDG_RUNTIME_DIR=/run/user/$(id -u))"
        problems=$((problems + 1))
    fi
    case "$(linger_state)" in
        yes) log "  linger: yes" ;;
        *) warn "linger is not enabled: units stop when you log out. Run: loginctl enable-linger $(id -un)" ;;
    esac
    if [ "$problems" -gt 0 ] && [ "$strict" = 1 ]; then die "preflight failed ($problems problem(s))"; fi
    return 0
}

# ── legacy (0.3) discovery ──────────────────────────────────────────────────────────────────

legacy_unit_files() {
    local f n
    for f in "$UNIT_DIR"/emperor-hermes-bridge-*.service; do
        [ -e "$f" ] || continue
        n=${f##*/}
        case "$n" in *@*|emperor-hermes-bridge-shared.service) continue ;; esac
        printf '%s\n' "$f"
    done
    return 0
}

legacy_unit_profile() { # unit file -> profile name
    local f=$1 p
    p=$(grep -Eo 'HERMES_PROFILE=[^"[:space:]]+' "$f" | tail -n 1 | cut -d= -f2 || true)
    if [ -z "$p" ]; then
        p=$(grep -Eo 'HERMES_HOME=[^"[:space:]]+' "$f" | tail -n 1 | sed -E 's#.*/profiles/([^/]+)/?$#\1#;t;d' || true)
    fi
    if [ -z "$p" ]; then p=${f##*/emperor-hermes-bridge-}; p=${p%.service}; fi
    printf '%s\n' "$p"
}

legacy_unit_for() { # profile -> unit name (recorded first, then discovered)
    local p=$1 u f
    u=$(rec_get "$p" legacy_unit 2>/dev/null || true)
    if [ -n "$u" ]; then printf '%s\n' "$u"; return 0; fi
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        if [ "$(legacy_unit_profile "$f")" = "$p" ]; then printf '%s\n' "${f##*/}"; return 0; fi
    done < <(legacy_unit_files)
    return 0
}

legacy_profiles() {
    local f
    while IFS= read -r f; do
        [ -n "$f" ] && legacy_unit_profile "$f"
    done < <(legacy_unit_files)
    return 0
}

legacy_env_files() { # unit name -> EnvironmentFile paths
    local f="$UNIT_DIR/$1"
    [ -f "$f" ] || return 0
    grep -E '^[[:space:]]*EnvironmentFile=' "$f" | sed -E 's/^[[:space:]]*EnvironmentFile=-?//; s/^"//; s/"$//' |
        sed "s#%h#$HOME#g" || true
}

legacy_env_dir() { # unit name -> dir of its EnvironmentFile ("" when unknown)
    local envfile
    envfile=$(legacy_env_files "$1" | head -n1)
    [ -n "$envfile" ] || return 0
    printf '%s\n' "$(dirname "$envfile")"
}

# Retiring a 0.3 unit (moving its file out of $UNIT_DIR) is stronger than disable --now: nothing
# can `systemctl enable` it again and it does not come back on reboot. Only the dash-form
# emperor-hermes-bridge-<name>.service units are retired; the @ template, the shared bridge and the
# logrotate units are never touched.

readonly HOLD_FILE=".emperor-hermes-hold"
readonly HOLD_MARKER="Migrated to bridge 0.9 by emperor-hermes"

retire_legacy_unit() { # unit profile -> move the 0.3 unit file to retired-units and hold its env dir
    local u=$1 p=$2 envdir
    case "$u" in emperor-hermes-bridge-*.service) ;; *) return 0 ;; esac
    case "$u" in *@* | emperor-hermes-bridge-shared.service | emperor-hermes-logrotate.service | emperor-hermes-logrotate.timer) return 0 ;; esac
    [ -f "$UNIT_DIR/$u" ] || return 0
    envdir=$(legacy_env_dir "$u")
    mkdir -p "$BACKUP_ROOT/retired-units"
    mv -f "$UNIT_DIR/$u" "$BACKUP_ROOT/retired-units/$u"
    [ ! -d "$UNIT_DIR/$u.d" ] || mv -f "$UNIT_DIR/$u.d" "$BACKUP_ROOT/retired-units/$u.d"
    log "  $p: retired $u (moved to $BACKUP_ROOT/retired-units/)"
    if [ -n "$envdir" ] && [ -d "$envdir" ] && [ "$envdir" != "$HOME" ] && [ ! -e "$envdir/$HOLD_FILE" ]; then
        printf '%s (%s): runs as emperor-hermes-gateway@%s + emperor-hermes-bridge@%s. Do not start the 0.3 unit: it creates a duplicate runtime.\n' \
            "$HOLD_MARKER" "$(date -u +%Y-%m-%d)" "$p" "$p" >"$envdir/$HOLD_FILE"
    fi
}

restore_retired_unit() { # unit profile -> move the unit back from retired-units and remove our hold; 0 when restored
    local u=$1 p=$2 envdir first
    [ -e "$BACKUP_ROOT/retired-units/$u" ] || return 1
    mkdir -p "$UNIT_DIR"
    mv -f "$BACKUP_ROOT/retired-units/$u" "$UNIT_DIR/$u"
    [ ! -e "$BACKUP_ROOT/retired-units/$u.d" ] || mv -f "$BACKUP_ROOT/retired-units/$u.d" "$UNIT_DIR/$u.d"
    log "  $p: restored $u from retired-units"
    envdir=$(legacy_env_dir "$u")
    if [ -n "$envdir" ] && [ -f "$envdir/$HOLD_FILE" ]; then
        first=$(head -n1 "$envdir/$HOLD_FILE" 2>/dev/null || true)
        case "$first" in "$HOLD_MARKER"*) rm -f "$envdir/$HOLD_FILE" ;; esac
    fi
    return 0
}

legacy_procs_for() { # profile -> pids of 0.3 bridge processes serving it
    local p=$1 dir pid cmd envp home
    for dir in /proc/[0-9]*; do
        pid=${dir#/proc/}
        cmd=$(tr '\0' ' ' 2>/dev/null <"$dir/cmdline" || true)
        case "$cmd" in *emperor_hermes_bridge.py*) ;; *) continue ;; esac
        envp=$(tr '\0' '\n' 2>/dev/null <"$dir/environ" || true)
        home=$(printf '%s\n' "$envp" | sed -n 's/^HERMES_HOME=//p' | tail -n 1)
        if [[ $'\n'"$envp"$'\n' == *$'\n'"HERMES_PROFILE=$p"$'\n'* ]] || [ "${home%/}" = "$PROFILES_ROOT/$p" ]; then
            printf '%s\n' "$pid"
        fi
    done
    return 0
}

stray_procs_for() { # profile unit -> 0.3 bridge pids for the profile that are NOT in the unit
    local p=$1 unit=$2 pid
    while IFS= read -r pid; do
        [ -n "$pid" ] || continue
        if [ -n "$unit" ] && grep -q "/$unit" "/proc/$pid/cgroup" 2>/dev/null; then continue; fi
        printf '%s\n' "$pid"
    done < <(legacy_procs_for "$p")
    return 0
}

guard_no_duplicate() { # profile
    local pids
    pids=$(legacy_procs_for "$1" | tr '\n' ' ')
    if [ -n "${pids// /}" ]; then
        if [ "$OPT_FORCE" = 1 ]; then
            warn "0.3 bridge process(es) still serve $1 (pid $pids); continuing because of --force"
        else
            die "a 0.3 bridge process still serves $1 (pid $pids) outside the unit. Stop it first (no duplicate runtimes), or use --force."
        fi
    fi
}

# ── gateways we did not start ───────────────────────────────────────────────────────────────

gateway_proc_home() { # pid -> home a `hermes ... gateway run` process serves ("" when not a gateway)
    local pid=$1 args=() i prof="" home="" envp
    mapfile -d '' -t args 2>/dev/null <"/proc/$pid/cmdline" || return 0
    local is_gw=0 has_hermes=0
    for ((i = 0; i < ${#args[@]}; i++)); do
        case "${args[$i]}" in
            *hermes*) has_hermes=1 ;;
        esac
        if [ "${args[$i]}" = gateway ] && [ "${args[$((i + 1))]:-}" = run ]; then is_gw=1; fi
        if [ "${args[$i]}" = -p ] || [ "${args[$i]}" = --profile ]; then prof=${args[$((i + 1))]:-}; fi
    done
    if [ "$is_gw" != 1 ] || [ "$has_hermes" != 1 ]; then return 0; fi
    if [ -n "$prof" ]; then
        home=$(profile_home "$prof")
    else
        envp=$(tr '\0' '\n' 2>/dev/null <"/proc/$pid/environ" || true)
        home=$(printf '%s\n' "$envp" | sed -n 's/^HERMES_HOME=//p' | tail -n 1)
        home=${home%/}
        home=${home:-$HERMES_ROOT}
    fi
    printf '%s\n' "$home"
}

foreign_gateways() { # homes... -> one line per gateway serving them that emperor-hermes did not start
    local dir pid home h u name
    for dir in /proc/[0-9]*; do
        pid=${dir#/proc/}
        home=$(gateway_proc_home "$pid")
        [ -n "$home" ] || continue
        if grep -q 'emperor-hermes-gateway' "$dir/cgroup" 2>/dev/null; then continue; fi
        for h in "$@"; do
            if [ "$home" = "$h" ]; then printf 'process %s (gateway for %s)\n' "$pid" "$home"; fi
        done
    done
    while IFS= read -r u; do
        [ -n "$u" ] || continue
        unit_active "$u" || unit_enabled "$u" || continue
        name=${u%.service}
        name=${name#hermes-gateway}
        name=${name#[-@]}
        for h in "$@"; do
            if { [ -z "$name" ] && [ "$h" = "$HERMES_ROOT" ]; } || [ "$h" = "$(profile_home "$name")" ]; then
                printf 'unit %s\n' "$u"
            fi
        done
    done < <( { sc list-unit-files --type=service --no-legend --plain 'hermes-gateway*' 2>/dev/null
                sc list-units --type=service --all --no-legend --plain 'hermes-gateway*' 2>/dev/null; } |
              awk '$1 ~ /\.service$/ && !seen[$1]++ { print $1 }')
    return 0
}

gateway_homes() { # topology profiles... -> the homes our gateway(s) would serve
    local topo=$1 p
    shift
    if [ "$topo" = shared ]; then printf '%s\n' "$HERMES_ROOT"; fi
    for p in "$@"; do profile_home "$p"; done
}

guard_foreign_gateways() { # topology profiles... (before stopping anything)
    local topo=$1 found homes=() line u key
    shift
    mapfile -t homes < <(gateway_homes "$topo" "$@")
    found=$(foreign_gateways "${homes[@]}" | awk '!seen[$0]++')
    [ -n "$found" ] || return 0
    if [ "$OPT_TAKE_OVER" != 1 ]; then
        log "Hermes gateway(s) not started by emperor-hermes already serve these profiles:"
        log "$(printf '%s\n' "$found" | sed 's/^/    /')"
        die "refusing to replace them. Stop them yourself, or re-run with --take-over-gateway (rollback restores them)"
    fi
    while IFS= read -r line; do
        case "$line" in
            "unit "*)
                u=${line#unit }
                key="foreign_${u//[^A-Za-z0-9_]/_}"
                if [ -z "$(env_get "$HOST_STATE" "$key")" ]; then
                    env_set "$HOST_STATE" "$key" "$u:$(unit_enabled "$u" && printf enabled || printf disabled):$(unit_active "$u" && printf active || printf inactive)"
                fi
                sc disable --now "$u" >/dev/null 2>&1 || sc stop "$u" || true
                log "  took over: stopped and disabled $u"
                ;;
            *) warn "taking over: $line will be replaced (--replace)" ;;
        esac
    done <<<"$found"
}

restore_foreign_gateways() { # after a full rollback: restart what --take-over-gateway stopped
    local key val u en ac
    [ -f "$HOST_STATE" ] || return 0
    while IFS= read -r key; do
        val=$(env_get "$HOST_STATE" "$key")
        [ -n "$val" ] || continue
        u=${val%%:*}
        en=${val#*:}; en=${en%%:*}
        ac=${val##*:}
        if [ "$en" = enabled ]; then sc enable "$u" >/dev/null 2>&1 || true; fi
        if [ "$ac" = active ]; then sc start "$u" || warn "could not restart $u"; fi
        log "  restored $u ($en, $ac)"
        env_unset "$HOST_STATE" "$key"
    done < <(sed -n 's/^\(foreign_[A-Za-z0-9_]*\)=.*/\1/p' "$HOST_STATE")
}

# ── Hermes pin and venv ─────────────────────────────────────────────────────────────────────

launcher_for() {
    local d=$1 c
    for c in "$d/.hermes/bin/hermes" "$d/venv/bin/hermes" "$d/.venv/bin/hermes"; do
        if [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
    done
    return 1
}

checkout_head() { git -C "$1" rev-parse HEAD 2>/dev/null || true; }

profiles_use_browser() {
    local p
    for p in "$@"; do
        if grep -Eqs '^[[:space:]]*(export[[:space:]]+)?(EMPEROR_CLAW_HERMES_TOOLSETS|HERMES_TOOLSETS)=.*browser' "$(profile_home "$p")/.env"; then
            return 0
        fi
    done
    return 1
}

ensure_hermes() { # profiles (for the browser decision)
    local head script args bin_before bin_after
    head=$(checkout_head "$HERMES_DIR")
    if [ "$head" = "$HERMES_SHA" ]; then
        HERMES_LAUNCHER=$(launcher_for "$HERMES_DIR") || die "$HERMES_DIR is at $HERMES_REF but has no launcher (.hermes/bin/hermes)"
        log "  Hermes $HERMES_REF already installed in $HERMES_DIR"
        return 0
    fi
    if [ -n "$head" ]; then
        die "$HERMES_DIR is a Hermes checkout at $head, not $HERMES_REF ($HERMES_SHA). Pick another --hermes-dir."
    fi
    if [ -e "$HERMES_DIR" ] && [ -n "$(ls -A "$HERMES_DIR" 2>/dev/null)" ]; then
        die "$HERMES_DIR exists and is not a Hermes checkout. Move it away or pick another --hermes-dir."
    fi
    step "Installing Hermes $HERMES_REF into $HERMES_DIR (side by side, a few minutes)"
    if [ -n "${EMPEROR_HERMES_HERMES_INSTALL_SCRIPT:-}" ]; then
        script=$EMPEROR_HERMES_HERMES_INSTALL_SCRIPT
    else
        ensure_tmp
        script="$TMP_ROOT/hermes-install.sh"
        # Fetched by the pinned commit, not the tag: a moved tag cannot run other code here.
        curl -fsSL --retry 3 "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_SHA}/scripts/install.sh" -o "$script"
    fi
    args=(--skip-setup --skip-computer-use --branch "$HERMES_REF" --dir "$HERMES_DIR")
    if [ "$OPT_SKIP_BROWSER" = 1 ] || ! profiles_use_browser "$@"; then args+=(--skip-browser); fi
    bin_before=$(readlink -f "$LOCAL_HERMES" 2>/dev/null || true)
    if [ -e "$LOCAL_HERMES" ] && [ ! -e "$BACKUP_ROOT/host/local-bin-hermes" ]; then
        mkdir -p "$BACKUP_ROOT/host"
        cp -P "$LOCAL_HERMES" "$BACKUP_ROOT/host/local-bin-hermes"
    fi
    if ! bash "$script" "${args[@]}" >>"$LOG_FILE" 2>&1; then
        die "Hermes install failed. Details: $LOG_FILE"
    fi
    head=$(checkout_head "$HERMES_DIR")
    [ "$head" = "$HERMES_SHA" ] || die "pin check failed: $HERMES_DIR is at '${head:-?}', expected $HERMES_SHA"
    HERMES_LAUNCHER=$(launcher_for "$HERMES_DIR") || die "no Hermes launcher found under $HERMES_DIR"
    bin_after=$(readlink -f "$LOCAL_HERMES" 2>/dev/null || true)
    if [ "$bin_before" != "$bin_after" ] && [ -e "$BACKUP_ROOT/host/local-bin-hermes" ] && [ "$(host_state finalized)" != 1 ]; then
        warn "the Hermes installer changed $LOCAL_HERMES; restoring it (finalize repoints it later)"
        rm -f "$LOCAL_HERMES"
        cp -P "$BACKUP_ROOT/host/local-bin-hermes" "$LOCAL_HERMES"
    fi
    log "  pinned: $(git -C "$HERMES_DIR" describe --tags 2>/dev/null || true) $HERMES_SHA"
}

python_target() { # the venv interpreter the stable wrapper execs ("" when none)
    [ -f "$STABLE_PYTHON" ] || return 0
    sed -n 's/^exec "\(.*\)" "\$@"$/\1/p' "$STABLE_PYTHON" | head -n 1
}

venv_from_facts() { # checkout -> venv python named by ~/.hermes/installs/<key>/facts.json
    # Hermes v0.22.4 keys dependency state by checkout: <key> = sha256(realpath(checkout))[:16],
    # and facts.json's packages.venv.environment is the selected venv.
    python3 -c 'import hashlib, json, os, sys
root = os.path.realpath(sys.argv[1])
key = hashlib.sha256(root.encode()).hexdigest()[:16]
facts = json.load(open(os.path.join(sys.argv[2], "installs", key, "facts.json")))
print(os.path.join(facts["packages"]["venv"]["environment"], "bin", "python"))' "$1" "$HERMES_ROOT" 2>/dev/null || true
}

resolve_python() { # writes the stable wrapper (not a symlink: a venv is detected from the unresolved path)
    local target tmp
    if [ -n "${HERMES_PYTHON:-}" ]; then
        target=$HERMES_PYTHON
    else
        target=$(venv_from_facts "$HERMES_DIR")
        [ -n "$target" ] || die "cannot read the venv of $HERMES_DIR from $HERMES_ROOT/installs/<key>/facts.json"
    fi
    [ -x "$target" ] || die "Hermes venv python $target is not executable"
    case "$target" in *'"'* | *\\* | *'$'* | *'`'*) die "unsupported venv path: $target" ;; esac
    "$target" -c 'import sys, websockets
major = int(websockets.__version__.split(".")[0])
sys.exit(0 if major >= 13 and sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1 ||
        die "$target needs Python >= 3.11 and websockets >= 13"
    mkdir -p "$DATA_DIR"
    tmp="$STABLE_PYTHON.new.$$"
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$target" >"$tmp"
    chmod 755 "$tmp"
    mv -f "$tmp" "$STABLE_PYTHON"
    log "  bridge python: $STABLE_PYTHON (wrapper) -> $target"
}

host_state() { env_get "$HOST_STATE" "$1"; }

# ── bridge bundle ───────────────────────────────────────────────────────────────────────────

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

install_bundle() { # -> prints nothing; sets `current`
    local ver=${OPT_VERSION:-$EMPEROR_HERMES_VERSION} src=${OPT_BUNDLE:-} work tarball expected="" actual top dest prev
    if [ -z "$src" ]; then src="$RELEASE_BASE/v$ver/emperor-hermes-bridge-$ver.tar.gz"; fi
    ensure_tmp
    work="$TMP_ROOT/bundle"
    mkdir -p "$work"
    case "$src" in
        http://* | https://*)
            step "Downloading bridge bundle $src"
            tarball="$work/bundle.tar.gz"
            curl -fsSL --retry 3 "$src" -o "$tarball" || die "cannot download $src"
            expected=$(curl -fsSL --retry 3 "$src.sha256" 2>/dev/null | awk '{print $1}' || true)
            [ -n "$expected" ] || die "cannot download $src.sha256 (checksum required for downloads)"
            ;;
        *)
            [ -f "$src" ] || die "bundle not found: $src"
            tarball=$src
            if [ -f "$src.sha256" ]; then expected=$(awk '{print $1}' "$src.sha256"); fi
            ;;
    esac
    actual=$(sha256_of "$tarball")
    if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then die "bundle checksum mismatch ($actual != $expected)"; fi
    tar -xzf "$tarball" -C "$work"
    top=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'emperor-hermes-bridge-*' -print -quit)
    if [ -z "$top" ] || [ ! -f "$top/VERSION" ]; then die "not an emperor-hermes bridge bundle: $src"; fi
    ver=$(tr -d '[:space:]' <"$top/VERSION")
    [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$ ]] || die "bad bundle version '$ver'"
    [ -f "$top/bridge/emperor_bridge/__main__.py" ] || die "bundle $ver has no bridge/emperor_bridge package"
    if [ ! -d "$top/plugin/emperor-claw" ] || [ ! -d "$top/systemd" ]; then die "bundle $ver is incomplete"; fi
    dest="$BRIDGE_ROOT/releases/$ver"
    mkdir -p "$BRIDGE_ROOT/releases"
    if [ -f "$dest/bundle.sha256" ] && [ "$(cat "$dest/bundle.sha256")" = "$actual" ]; then
        log "  bridge $ver already unpacked"
    else
        rm -rf "$dest.tmp"
        cp -R "$top" "$dest.tmp"
        printf '%s\n' "$actual" >"$dest.tmp/bundle.sha256"
        rm -rf "$dest"
        mv "$dest.tmp" "$dest"
        log "  bridge $ver unpacked to $dest"
    fi
    prev=$(readlink "$BRIDGE_ROOT/current" 2>/dev/null || true)
    if [ "$prev" != "releases/$ver" ]; then
        if [ -n "$prev" ]; then env_set "$HOST_STATE" bridge_previous "${prev#releases/}"; fi
        ln_atomic "releases/$ver" "$BRIDGE_ROOT/current"
        env_set "$HOST_STATE" bridge_changed 1
    fi
    env_set "$HOST_STATE" bridge_version "$ver"
}

bridge_version() {
    local v
    v=$(cat "$BRIDGE_ROOT/current/VERSION" 2>/dev/null || true)
    printf '%s\n' "${v:-none}"
}

install_units() {
    local src="$BRIDGE_ROOT/current/systemd" f changed=0 conf
    [ -d "$src" ] || die "bundle has no systemd units"
    mkdir -p "$UNIT_DIR"
    for f in "$src"/*.service; do
        if ! cmp -s "$f" "$UNIT_DIR/${f##*/}"; then
            install -m 644 "$f" "$UNIT_DIR/${f##*/}"
            changed=1
        fi
    done
    if [ -f "$BRIDGE_ROOT/current/logrotate.conf" ] && have logrotate; then
        mkdir -p "$CONFIG_DIR" "$DATA_DIR"
        conf="$CONFIG_DIR/logrotate.conf"
        sed "s#@HOME@#$HOME#g" "$BRIDGE_ROOT/current/logrotate.conf" >"$conf.new"
        mv -f "$conf.new" "$conf"
        cat >"$UNIT_DIR/emperor-hermes-logrotate.service.new" <<EOF
# Written by emperor-hermes.
[Unit]
Description=Rotate Emperor Claw bridge logs

[Service]
Type=oneshot
ExecStart=$(command -v logrotate) -s %h/.local/share/emperor-hermes/logrotate.state %h/.config/emperor-hermes/logrotate.conf
EOF
        cat >"$UNIT_DIR/emperor-hermes-logrotate.timer.new" <<'EOF'
# Written by emperor-hermes.
[Unit]
Description=Daily rotation of Emperor Claw bridge logs

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=15min

[Install]
WantedBy=timers.target
EOF
        for f in emperor-hermes-logrotate.service emperor-hermes-logrotate.timer; do
            if cmp -s "$UNIT_DIR/$f.new" "$UNIT_DIR/$f"; then rm -f "$UNIT_DIR/$f.new"; else mv -f "$UNIT_DIR/$f.new" "$UNIT_DIR/$f"; changed=1; fi
        done
    elif ! have logrotate; then
        warn "logrotate not found: bridge logs will not be rotated"
    fi
    sc daemon-reload
    if [ -f "$UNIT_DIR/emperor-hermes-logrotate.timer" ]; then sc enable --now emperor-hermes-logrotate.timer >/dev/null 2>&1 || true; fi
    if [ "$changed" = 1 ]; then log "  units installed in $UNIT_DIR"; fi
}

# ── profile config ──────────────────────────────────────────────────────────────────────────

hermes_cmd() { # profile|"" args... (empty profile = default home)
    local p=$1
    shift
    if [ -n "$p" ]; then
        "$HERMES_LAUNCHER" -p "$p" "$@" >>"$LOG_FILE" 2>&1
    else
        "$HERMES_LAUNCHER" "$@" >>"$LOG_FILE" 2>&1
    fi
}

config_set() { # profile key value
    hermes_cmd "$1" config set "$2" "$3" || die "hermes ${1:+-p $1 }config set $2 failed. Details: $LOG_FILE"
}

builtin_defaults() {
    cat <<'EOF'
compression.threshold_tokens=80000
compression.proactive_prune_tokens=48000
compression.idle_compact_after_seconds=0
tools.tool_search.enabled=off
approvals.timeout=60
agent.restart_drain_timeout=30
agent.clarify_timeout=60
EOF
}

fetch_defaults() { # profile -> key=value lines
    local env url token out
    env="$(profile_home "$1")/.env"
    url=$(env_get "$env" EMPEROR_CLAW_API_URL)
    token=$(env_get "$env" EMPEROR_CLAW_API_TOKEN)
    if [ -n "$url" ] && [ -n "$token" ]; then
        # The token goes through stdin, never argv.
        if out=$(printf 'Authorization: Bearer %s\n' "$token" |
            curl -fsS --max-time 10 -H @- "${url%/}/api/mcp/runtime/profile-defaults" 2>/dev/null) &&
            [[ "$out" =~ (^|$'\n')[a-z_.]+= ]]; then
            printf '%s\n' "$out"
            return 0
        fi
    fi
    warn "could not fetch profile defaults from Emperor for $1; using the built-in $EMPEROR_HERMES_VERSION defaults"
    builtin_defaults
}

apply_profile_config() { # profile topology
    local p=$1 topo=$2 line key value
    while IFS= read -r line; do
        case "$line" in '' | '#'*) continue ;; esac
        key=${line%%=*}
        value=${line#*=}
        case "$key" in gateway.*) continue ;; esac # topology keys are ours
        config_set "$p" "$key" "$value"
    done < <(fetch_defaults "$p")
    config_set "$p" approvals.timeout 60
    config_set "$p" agent.restart_drain_timeout 30
    config_set "$p" agent.clarify_timeout 60
    config_set "$p" auxiliary.title_generation.enabled false
    config_set "$p" tools.tool_search.enabled off
    config_set "$p" terminal.client_env_passthrough "$CLIENT_ENV_PASSTHROUGH"
    if [ "$topo" = standalone ]; then
        config_set "$p" gateway.standalone true
        config_set "$p" gateway.unmanaged_idle_exit_seconds 0
    else
        config_set "$p" gateway.standalone false
    fi
}

apply_default_home_shared() {
    config_set "" gateway.multiplex_profiles true
    config_set "" gateway.unmanaged_idle_exit_seconds 0
    config_set "" agent.restart_drain_timeout 30
    config_set "" agent.clarify_timeout 60
    config_set "" terminal.client_env_passthrough "$CLIENT_ENV_PASSTHROUGH"
}

merge_legacy_env() { # profile legacy_unit
    local p=$1 unit=$2 penv src line key added=0
    penv="$(profile_home "$p")/.env"
    [ -f "$penv" ] || { : >"$penv"; chmod 600 "$penv"; }
    [ -n "$unit" ] || return 0
    while IFS= read -r src; do
        if [ -z "$src" ] || [ ! -f "$src" ] || [ "$src" = "$penv" ]; then continue; fi
        while IFS= read -r line || [ -n "$line" ]; do
            line=${line#"${line%%[![:space:]]*}"}
            line=${line#export }
            case "$line" in '' | '#'*) continue ;; esac
            key=${line%%=*}
            [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
            case "$key" in HERMES_BIN | HERMES_HOME | HERMES_PROFILE | PATH | HOME | PYTHONPATH) continue ;; esac
            if [ "$key" = HERMES_TOOLSETS ]; then
                if ! env_has "$penv" EMPEROR_CLAW_HERMES_TOOLSETS; then
                    printf 'EMPEROR_CLAW_HERMES_TOOLSETS=%s\n' "${line#*=}" >>"$penv"
                    added=$((added + 1))
                fi
                continue
            fi
            if ! env_has "$penv" "$key"; then
                printf '%s\n' "$line" >>"$penv"
                added=$((added + 1))
            fi
        done <"$src"
    done < <(legacy_env_files "$unit")
    chmod 600 "$penv"
    if [ "$added" -gt 0 ]; then log "  $p: merged $added setting(s) from the 0.3 bridge env into $penv"; fi
}

check_credentials() {
    local penv
    penv="$(profile_home "$1")/.env"
    [ -n "$(env_get "$penv" EMPEROR_CLAW_API_URL)" ] || die "$1: EMPEROR_CLAW_API_URL is missing in $penv"
    [ -n "$(env_get "$penv" EMPEROR_CLAW_API_TOKEN)" ] || die "$1: EMPEROR_CLAW_API_TOKEN is missing in $penv"
    [ -n "$(env_get "$penv" EMPEROR_CLAW_AGENT_ID)" ] || warn "$1: EMPEROR_CLAW_AGENT_ID is not set; the bridge resolves the agent by name"
}

install_plugin() { # profile
    local p=$1 home dest
    home=$(profile_home "$p")
    dest="$home/plugins/emperor-claw"
    mkdir -p "$home/plugins"
    rm -rf "$dest.new"
    cp -R "$BRIDGE_ROOT/current/plugin/emperor-claw" "$dest.new"
    rm -rf "$dest"
    mv "$dest.new" "$dest"
    hermes_cmd "$p" plugins enable emperor-claw || die "$p: hermes plugins enable emperor-claw failed"
}

restore_global_plugin() { # after a rollback: 0.3 bridges need the 0.3 plugin
    local b="$BACKUP_ROOT/host/plugin-emperor-claw.pre-0.9" dest="$HERMES_ROOT/plugins/emperor-claw"
    [ -d "$b" ] || return 0
    rm -rf "$dest"
    cp -R "$b" "$dest"
}

update_global_plugin() {
    local dest="$HERMES_ROOT/plugins/emperor-claw"
    [ -d "$dest" ] || return 0
    if [ ! -e "$BACKUP_ROOT/host/plugin-emperor-claw.pre-0.9" ]; then
        mkdir -p "$BACKUP_ROOT/host"
        cp -R "$dest" "$BACKUP_ROOT/host/plugin-emperor-claw.pre-0.9"
    fi
    rm -rf "$dest.new"
    cp -R "$BRIDGE_ROOT/current/plugin/emperor-claw" "$dest.new"
    rm -rf "$dest"
    mv "$dest.new" "$dest"
}

backup_files() { # profile: config.yaml, .env, plugin (once, before anything is changed)
    local p=$1 home dir
    home=$(profile_home "$p")
    dir="$BACKUP_ROOT/$p"
    mkdir -p "$dir"
    if [ -f "$home/config.yaml" ] && [ ! -e "$dir/config.yaml.pre-0.9" ]; then cp -p "$home/config.yaml" "$dir/config.yaml.pre-0.9"; fi
    if [ -f "$home/.env" ] && [ ! -e "$dir/env.pre-0.9" ]; then cp -p "$home/.env" "$dir/env.pre-0.9"; fi
    if [ ! -e "$dir/plugin.pre-0.9" ]; then
        if [ -d "$home/plugins/emperor-claw" ]; then
            cp -R "$home/plugins/emperor-claw" "$dir/plugin.pre-0.9"
        else
            mkdir -p "$dir/plugin.pre-0.9"
            : >"$dir/plugin.pre-0.9/.absent"
        fi
    fi
    return 0
}

backup_db() { # src dest (once; call with every writer of src stopped)
    local src=$1 dest=$2
    if [ ! -f "$src" ] || [ -f "$dest" ]; then return 0; fi
    mkdir -p "$(dirname "$dest")"
    python3 -c 'import sqlite3, sys
src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()' "$src" "$dest.tmp"
    mv "$dest.tmp" "$dest"
    log "  state.db backed up: $dest"
}

backup_default_home() { # before the first shared-gateway start
    if [ -f "$HERMES_ROOT/config.yaml" ] && [ ! -e "$BACKUP_ROOT/host/config.yaml.pre-0.9" ]; then
        mkdir -p "$BACKUP_ROOT/host"
        cp -p "$HERMES_ROOT/config.yaml" "$BACKUP_ROOT/host/config.yaml.pre-0.9"
    fi
    backup_db "$HERMES_ROOT/state.db" "$BACKUP_ROOT/host/state.db.pre-v0.22"
}

restore_default_home() { # after the last shared profile is rolled back
    if [ -f "$BACKUP_ROOT/host/config.yaml.pre-0.9" ]; then cp -p "$BACKUP_ROOT/host/config.yaml.pre-0.9" "$HERMES_ROOT/config.yaml"; fi
    if [ -f "$BACKUP_ROOT/host/state.db.pre-v0.22" ]; then
        if [ -f "$HERMES_ROOT/state.db" ]; then mv "$HERMES_ROOT/state.db" "$HERMES_ROOT/state.db.v0.22-rollback-$(date -u +%Y%m%dT%H%M%SZ)"; fi
        rm -f "$HERMES_ROOT/state.db-wal" "$HERMES_ROOT/state.db-shm"
        cp -p "$BACKUP_ROOT/host/state.db.pre-v0.22" "$HERMES_ROOT/state.db"
    fi
    local f ts
    ts=$(date -u +%Y%m%dT%H%M%SZ)
    for f in config.yaml.pre-0.9 state.db.pre-v0.22; do
        if [ -e "$BACKUP_ROOT/host/$f" ]; then mv "$BACKUP_ROOT/host/$f" "$BACKUP_ROOT/host/$f.rolled-back-$ts"; fi
    done
    return 0
}

legacy_active() { # 0 when any 0.3 bridge unit is still running
    local f
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        unit_active "${f##*/}" && return 0
    done < <(legacy_unit_files)
    return 1
}

# ── self-made bridge watchdogs ───────────────────────────────────────────────────────────────
# An agent (or a hand-written timer) may have created its own systemd timer/service or cron job
# that re-enables/restarts the 0.3 bridges. Left alone it brings the 0.3 runtimes back next to the
# 0.9 ones (duplicate runtimes answering the same messages), so it must be caught and stopped first.

own_unit() { # unit name -> 0 when it is ours (0.9 units) or a 0.3 bridge unit, never a watchdog
    case "$1" in
        emperor-hermes-gateway@* | emperor-hermes-gateway-shared.service | \
        emperor-hermes-bridge@* | emperor-hermes-bridge-*.service | \
        emperor-hermes-logrotate.service | emperor-hermes-logrotate.timer) return 0 ;;
        *) return 1 ;;
    esac
}

readonly START_VERB_RE='(^|[^[:alnum:]_])(start|restart|enable|reenable|reload-or-restart|try-restart)($|[^[:alnum:]_])'

has_start_verb() { # text -> 0 when it names a systemctl action that starts/restarts/enables
    printf '%s\n' "$1" | grep -Eq 'systemctl' &&
        printf '%s\n' "$1" | grep -Eq "$START_VERB_RE"
}

expand_path_word() { # word -> path with %h / $HOME / ${HOME} resolved
    local w=$1
    w=${w//'%h'/$HOME}
    w=${w//"\${HOME}"/$HOME}
    w=${w//"\$HOME"/$HOME}
    printf '%s\n' "$w"
}

watchdog_refs() { # text -> 0 when it would start/restart/enable a 0.3 bridge
    local text=$1
    printf '%s\n' "$text" | grep -Eq 'emperor_hermes_bridge\.py' && return 0
    printf '%s\n' "$text" | grep -Eq 'emperor-hermes-bridge-' || return 1
    has_start_verb "$text"
}

script_enables_bridge() { # path -> 0 when the readable script would start/restart/enable 0.3 bridges
    local path=$1
    [ -n "$path" ] || return 1
    path=${path/#\~/$HOME}
    case "$path" in
        "$HOME"/*) ;;
        *) return 1 ;;
    esac
    case "$path" in
        */emperor-hermes | */emperor-hermes.sh | "$BRIDGE_ROOT/releases"/*) return 1 ;;
    esac
    [ -f "$path" ] && [ -r "$path" ] || return 1
    [ "$(stat -c %s "$path" 2>/dev/null || printf 0)" -le 524288 ] || return 1
    if grep -Iq 'emperor_hermes_bridge\.py' "$path" 2>/dev/null; then return 0; fi
    grep -Iq 'emperor-hermes-bridge-' "$path" 2>/dev/null &&
        grep -Iq 'systemctl' "$path" 2>/dev/null &&
        grep -IqE "$START_VERB_RE" "$path" 2>/dev/null
}

candidate_units() { # -> user service/timer names that are neither ours nor 0.3 bridge units
    local f u
    for f in "$UNIT_DIR"/*.service "$UNIT_DIR"/*.timer; do
        [ -e "$f" ] || continue
        u=${f##*/}
        own_unit "$u" || printf '%s\n' "$u"
    done
    while IFS= read -r u; do
        [ -n "$u" ] || continue
        own_unit "$u" || printf '%s\n' "$u"
    done < <(sc list-units --all --type=service,timer --no-legend --plain 2>/dev/null | awk '$1 ~ /\.(service|timer)$/ { print $1 }')
    return 0
}

triggered_by() { # unit -> space-separated timers that trigger it ("" when none)
    systemctl --user show -p TriggeredBy --value "$1" 2>/dev/null || true
}

watchdog_timers_for() { # service -> timers that trigger it (one per line, de-duped)
    local svc=$1 timers t seen=","
    timers=$(triggered_by "$svc")
    [ -n "$timers" ] || timers="${svc%.service}.timer"
    for t in $timers; do
        case "$seen" in *",$t,"*) continue ;; esac
        seen="$seen$t,"
        printf '%s\n' "$t"
    done
}

unit_live() { # unit -> 0 when active, truly enabled, or (static and a triggering timer is enabled/active)
    local u=$1 en t
    unit_active "$u" && return 0
    unit_truly_enabled "$u" && return 0
    en=$(systemctl --user is-enabled "$u" 2>/dev/null || true)
    [ "$en" = static ] || return 1
    while IFS= read -r t; do
        [ -n "$t" ] || continue
        unit_active "$t" && return 0
        unit_truly_enabled "$t" && return 0
    done < <(watchdog_timers_for "$u")
    return 1
}

watchdog_units() { # -> unit names whose ExecStart* would bring the 0.3 bridges back (and are live)
    local u content word seen="," wd
    while IFS= read -r u; do
        [ -n "$u" ] || continue
        case "$seen" in *",$u,"*) continue ;; esac
        seen="$seen$u,"
        unit_live "$u" || continue
        content=$(sc cat "$u" 2>/dev/null || true)
        if watchdog_refs "$content"; then
            printf '%s\n' "$u"
            continue
        fi
        wd=$(sc show -p WorkingDirectory --value "$u" 2>/dev/null || true)
        while IFS= read -r word; do
            word=${word#\"}; word=${word%\"}
            [ -n "$word" ] || continue
            word=$(expand_path_word "$word")
            case "$word" in
                /* | ~/*) ;;
                *)
                    if [ -n "$wd" ]; then
                        word="$wd/$word"
                    else
                        continue
                    fi
                    ;;
            esac
            if script_enables_bridge "$word"; then printf '%s\n' "$u"; break; fi
        done < <(printf '%s\n' "$content" |
            sed -n -e 's/^[[:space:]]*ExecStartPre=-\?//p' -e 's/^[[:space:]]*ExecStart=-\?//p' |
            tr ' ' '\n' | sed '/^[[:space:]]*$/d')
    done < <(candidate_units)
    return 0
}

watchdog_crons() { # -> crontab lines that would bring the 0.3 bridges back
    local line word words=()
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        case "$line" in \#*) continue ;; esac
        if watchdog_refs "$line"; then printf '%s\n' "$line"; continue; fi
        read -ra words <<<"$line"
        for word in "${words[@]}"; do
            word=${word#\"}; word=${word%\"}
            [ -n "$word" ] || continue
            word=$(expand_path_word "$word")
            case "$word" in
                /* | ~/*) ;;
                *) continue ;;
            esac
            if script_enables_bridge "$word"; then printf '%s\n' "$line"; break; fi
        done
    done < <(crontab -l 2>/dev/null || true)
    return 0
}

watchdog_cron_is() { # line crons(nl-separated) -> 0 when line is one of the detected crons
    local line=$1 c
    while IFS= read -r c; do
        [ -n "$c" ] && [ "$c" = "$line" ] && return 0
    done <<<"$2"
    return 1
}

crontab_read() { # -> current crontab lines; "" when none; die on real read errors
    local out
    if ! out=$(crontab -l 2>&1); then
        if printf '%s\n' "$out" | grep -Eqi 'no crontab for'; then return 0; fi
        die "cannot read the current crontab: ${out:-crontab -l failed}"
    fi
    printf '%s\n' "$out"
}

disable_watchdogs() { # units crons -> stop/disables them and records the state for rollback
    local units=$1 crons=$2 u key timer crontab_text crontab_backup tmp line
    while IFS= read -r u; do
        [ -n "$u" ] || continue
        key="watchdog_unit_${u//[^A-Za-z0-9_]/_}"
        if [ -z "$(env_get "$HOST_STATE" "$key")" ]; then
            env_set "$HOST_STATE" "$key" "$u:$(unit_truly_enabled "$u" && printf enabled || printf disabled):$(unit_active "$u" && printf active || printf inactive)"
        fi
        sc disable --now "$u" >/dev/null 2>&1 || sc stop "$u" || true
        log "  disabled watchdog $u"
        if [ "${u%.service}" != "$u" ]; then
            while IFS= read -r timer; do
                [ -n "$timer" ] || continue
                if [ -f "$UNIT_DIR/$timer" ] || sc list-unit-files --type=timer --no-legend --plain "$timer" 2>/dev/null | grep -q "$timer"; then
                    key="watchdog_unit_${timer//[^A-Za-z0-9_]/_}"
                    if [ -z "$(env_get "$HOST_STATE" "$key")" ]; then
                        env_set "$HOST_STATE" "$key" "$timer:$(unit_truly_enabled "$timer" && printf enabled || printf disabled):$(unit_active "$timer" && printf active || printf inactive)"
                    fi
                    sc disable --now "$timer" >/dev/null 2>&1 || true
                    log "  disabled watchdog timer $timer"
                fi
            done < <(watchdog_timers_for "$u")
        fi
    done <<<"$units"
    if [ -n "$crons" ]; then
        crontab_text=$(crontab_read)
        if [ -z "$(env_get "$HOST_STATE" watchdog_crontab)" ]; then
            mkdir -p "$BACKUP_ROOT"
            crontab_backup="$BACKUP_ROOT/crontab.$(date -u +%Y%m%dT%H%M%SZ)"
            printf '%s\n' "$crontab_text" >"$crontab_backup"
            env_set "$HOST_STATE" watchdog_crontab "$crontab_backup"
        else
            crontab_backup=$(env_get "$HOST_STATE" watchdog_crontab)
        fi
        ensure_tmp
        tmp="$TMP_ROOT/crontab.new"
        : >"$tmp"
        while IFS= read -r line; do
            if watchdog_cron_is "$line" "$crons"; then
                printf '# disabled by emperor-hermes: %s\n' "$line"
            else
                printf '%s\n' "$line"
            fi
        done <<<"$crontab_text" >"$tmp"
        if [ -n "$crontab_text" ] && [ ! -s "$tmp" ]; then
            die "refusing to install an empty crontab"
        fi
        crontab "$tmp" || die "cannot write the new crontab"
        if [ -n "$(watchdog_crons)" ]; then
            die "crontab rewrite did not take effect: watchdog cron lines are still live"
        fi
        log "  commented out watchdog crontab lines (backup: $crontab_backup)"
    fi
}

guard_watchdogs() { # before touching anything: refuse unless --disable-watchdogs
    local units crons u
    units=$(watchdog_units)
    crons=$(watchdog_crons)
    [ -n "$units$crons" ] || return 0
    if [ "$OPT_DISABLE_WATCHDOGS" = 1 ]; then
        step "Disabling self-made 0.3 bridge watchdogs"
        disable_watchdogs "$units" "$crons"
        return 0
    fi
    log "Self-made 0.3 bridge watchdogs detected. They would restart the 0.3 bridges and create duplicate runtimes:"
    while IFS= read -r u; do
        [ -n "$u" ] || continue
        log "  - unit/timer $u (script: $(sc cat "$u" 2>/dev/null | sed -n 's/^[[:space:]]*ExecStart\(Pre\)\?=-\?//p' | head -n1))"
    done <<<"$units"
    while IFS= read -r u; do
        [ -n "$u" ] || continue
        log "  - cron: $u"
    done <<<"$crons"
    die "it would restart the 0.3 bridges and create duplicate runtimes; rerun with --disable-watchdogs to stop it, or remove it yourself"
}

restore_watchdogs() { # after a full rollback: re-enable timers/services and un-comment the watchdog crontab lines
    local key val u en ac current line tmp
    [ -f "$HOST_STATE" ] || return 0
    while IFS= read -r key; do
        val=$(env_get "$HOST_STATE" "$key")
        [ -n "$val" ] || continue
        u=${val%%:*}
        en=${val#*:}; en=${en%%:*}
        ac=${val##*:}
        if [ "$en" = enabled ]; then sc enable "$u" >/dev/null 2>&1 || true; fi
        if [ "$ac" = active ]; then sc start "$u" || warn "could not restart watchdog $u"; fi
        log "  restored watchdog $u ($en, $ac)"
        env_unset "$HOST_STATE" "$key"
    done < <(sed -n 's/^\(watchdog_unit_[A-Za-z0-9_]*\)=.*/\1/p' "$HOST_STATE")
    if [ -n "$(env_get "$HOST_STATE" watchdog_crontab)" ]; then
        if current=$(crontab -l 2>/dev/null) && printf '%s\n' "$current" | grep -q '^# disabled by emperor-hermes: '; then
            ensure_tmp
            tmp="$TMP_ROOT/crontab.restore"
            : >"$tmp"
            while IFS= read -r line; do
                case "$line" in
                    "# disabled by emperor-hermes: "*) printf '%s\n' "${line#"# disabled by emperor-hermes: "}" ;;
                    *) printf '%s\n' "$line" ;;
                esac
            done <<<"$current" >"$tmp"
            if crontab "$tmp" 2>/dev/null; then log "  restored the watchdog crontab lines"; else warn "could not write the restored crontab"; fi
        fi
        env_unset "$HOST_STATE" watchdog_crontab
    fi
}

report_watchdogs() { # -> prints detected watchdogs; 0 when any were found
    local units crons u
    units=$(watchdog_units)
    crons=$(watchdog_crons)
    [ -n "$units" ] || [ -n "$crons" ] || return 1
    printf 'Self-made 0.3 bridge watchdogs detected (they would restart the 0.3 bridges and create duplicate runtimes):\n'
    while IFS= read -r u; do [ -n "$u" ] && printf '  - unit/timer %s\n' "$u"; done <<<"$units"
    while IFS= read -r u; do [ -n "$u" ] && printf '  - cron %s\n' "$u"; done <<<"$crons"
    return 0
}

# ── gateway identify ────────────────────────────────────────────────────────────────────────

identify() { # control_home -> "state code_version pid served_homes" or "down <reason>"
    "$(helper_python)" -c '
import json, os, socket, sys
home = sys.argv[1]
path = os.path.join(home, "gateway.sock")
redirect = path + ".path"
if os.path.exists(redirect):
    path = open(redirect).read().strip()
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(3)
    s.connect(path)
    s.sendall(b"{\"protocol\":1,\"verb\":\"identify\",\"id\":1}\n")
    data = b""
    while not data.endswith(b"\n"):
        chunk = s.recv(65536)
        if not chunk:
            break
        data += chunk
    r = json.loads(data).get("result") or {}
except Exception as exc:
    print("down", type(exc).__name__)
    sys.exit(0)
homes = ",".join(p.get("home", "") for p in r.get("served_profiles") or [])
print(r.get("state", "?"), r.get("code_version", "?"), r.get("pid", "?"), homes or "-")
' "$1"
}

wait_ready() { # control_home label
    local home=$1 label=$2 deadline out
    deadline=$(($(date +%s) + ${EMPEROR_HERMES_READY_TIMEOUT:-120}))
    while :; do
        out=$(identify "$home")
        case "$out" in
            "ready $HERMES_CODE_VERSION "*) log "  $label: gateway ready ($out)"; return 0 ;;
            "ready "*) die "$label: gateway runs code_version ${out#ready }, expected $HERMES_CODE_VERSION" ;;
        esac
        if [ "$(date +%s)" -ge "$deadline" ]; then
            die "$label: gateway not ready after ${EMPEROR_HERMES_READY_TIMEOUT:-120}s ($out). See: journalctl --user -u $3"
        fi
        sleep 1
    done
}

# ── memory plan (D21) ───────────────────────────────────────────────────────────────────────

mem_available_mib() {
    awk '/^MemAvailable:/ { printf "%d\n", $2 / 1024; found = 1 } END { if (!found) print 0 }' "${EMPEROR_HERMES_MEMINFO:-/proc/meminfo}"
}

unit_mem_mib() { # unit -> MiB used (cgroup MemoryCurrent, else VmRSS of MainPID), 0 when stopped
    local u=$1 cur pid
    unit_active "$u" || { printf '0\n'; return 0; }
    cur=$(sc show -p MemoryCurrent --value "$u" 2>/dev/null || true)
    if [[ "$cur" =~ ^[0-9]{1,15}$ ]]; then
        printf '%d\n' $((cur / 1048576))
        return 0
    fi
    pid=$(sc show -p MainPID --value "$u" 2>/dev/null || printf '0')
    if [ "${pid:-0}" != 0 ] && [ -r "/proc/$pid/status" ]; then
        awk '/^VmRSS:/ { printf "%d\n", $2 / 1024 }' "/proc/$pid/status"
    else
        printf '0\n'
    fi
}

running_new(){ # profile -> 0 when its 0.9 units already run
    local p=$1
    unit_active "emperor-hermes-bridge@$p.service" && return 0
    in_shared "$p" && unit_active emperor-hermes-bridge-shared.service
}

compute_plan() { # profiles... -> sets PLAN (standalone|shared|move), PLAN_MOVE; prints the table
    local profiles=("$@") p n=0 avail reclaim=0 u m usable need_st need_sh keep i
    local shared_running=0
    unit_active emperor-hermes-gateway-shared.service && shared_running=1
    local new=()
    for p in "${profiles[@]}"; do
        if running_new "$p"; then continue; fi
        new+=("$p")
        n=$((n + 1))
        u=$(legacy_unit_for "$p")
        if [ -n "$u" ]; then m=$(unit_mem_mib "$u"); reclaim=$((reclaim + m)); fi
    done
    avail=$(mem_available_mib)
    usable=$((avail + reclaim - MIB_RESERVE))
    need_st=$((n * MIB_STANDALONE))
    if [ "$shared_running" = 1 ]; then
        need_sh=$((n * OPT_DELTA_MIB))
    elif [ "$n" -gt 0 ]; then
        need_sh=$((MIB_SHARED_GATEWAY + (n - 1) * OPT_DELTA_MIB + MIB_SHARED_BRIDGE))
    else
        need_sh=0
    fi
    PLAN_MOVE=""
    if [ "$need_st" -le "$usable" ]; then
        PLAN=standalone
    elif [ "$need_sh" -le "$usable" ]; then
        PLAN=shared
    else
        PLAN=move
        keep=0
        if [ "$usable" -gt 0 ]; then keep=$((usable / MIB_STANDALONE)); fi
        for ((i = keep; i < n; i++)); do PLAN_MOVE="$PLAN_MOVE ${new[$i]}"; done
        PLAN_MOVE=${PLAN_MOVE# }
    fi
    {
        printf 'Memory plan (D21), host %s (%s)\n' "$(uname -n)" "$(uname -m)"
        printf '  profiles to place:       %d (%s)\n' "$n" "$(join_csv "${new[@]}")"
        printf '  MemAvailable:            %d MiB\n' "$avail"
        printf '  + 0.3 bridges (stopped): %d MiB\n' "$reclaim"
        printf '  - reserve:               %d MiB\n' "$MIB_RESERVE"
        printf '  = usable:                %d MiB\n' "$usable"
        printf '  standalone needs:        %d MiB (%d x %d)\n' "$need_st" "$n" "$MIB_STANDALONE"
        printf '  shared needs:            %d MiB (gateway %d + %d x delta %d + bridge %d)\n' \
            "$need_sh" "$MIB_SHARED_GATEWAY" $((n > 0 ? n - 1 : 0)) "$OPT_DELTA_MIB" "$MIB_SHARED_BRIDGE"
        case "$PLAN" in
            standalone) printf 'PLAN: standalone x%d\n' "$n" ;;
            shared) printf 'PLAN: shared (requires --gateway shared; read the trade-off first)\n' ;;
            move) printf 'PLAN: move. Keep at most %d standalone here; move to another host: %s\n' "$keep" "${PLAN_MOVE:-none}" ;;
        esac
    }
}

# ── shared-mode trade-off ───────────────────────────────────────────────────────────────────

SHARED_TRADEOFF="Shared gateway trade-off:
  1. Every agent on this host runs in ONE Hermes process. A bug or a malicious tool could use
     another agent's Emperor token; actions would be attributed to the wrong agent.
  2. On a single-user host the agents' files are already mutually readable; the new exposure
     is in-process only.
  3. One gateway crash, restart or model-key rotation interrupts every agent on this host.
  Allowed only when all profiles here belong to ONE Emperor company, one operator, one OS user.
  Bridge 0.9 refuses to dispatch if Emperor reports otherwise (sharedHostOk=false)."

confirm_shared() {
    log "$SHARED_TRADEOFF"
    confirm "Use one shared gateway for: $*?" || die "shared gateway not confirmed (re-run with --yes to accept)"
    local urls
    urls=$(for p in "$@"; do env_get "$(profile_home "$p")/.env" EMPEROR_CLAW_API_URL; done | sort -u | grep -c . || true)
    if [ "${urls:-0}" -gt 1 ]; then die "shared gateway: the profiles point at different Emperor URLs"; fi
}

# ── commands ────────────────────────────────────────────────────────────────────────────────

target_profiles() { # -> profiles from --profile / --all
    local list=()
    if [ "$OPT_ALL" = 1 ]; then
        mapfile -t list < <( { legacy_profiles; recorded_profiles; } | awk '!seen[$0]++')
    fi
    if [ -n "$OPT_PROFILES" ]; then mapfile -t -O "${#list[@]}" list < <(split_csv "$OPT_PROFILES"); fi
    local p
    for p in "${list[@]}"; do valid_profile "$p" || die "invalid profile name: $p"; done
    printf '%s\n' "${list[@]}" | awk 'NF && !seen[$0]++'
}

stop_new_units_for() { # profile
    local p=$1
    sc disable --now "emperor-hermes-bridge@$p.service" >/dev/null 2>&1 || true
    sc disable --now "emperor-hermes-gateway@$p.service" >/dev/null 2>&1 || true
}

default_topology() { # profiles... -> recorded topology when they all agree, else standalone
    local p t first=""
    for p in "$@"; do
        t=$(rec_get "$p" topology)
        [ -n "$t" ] || { printf 'standalone\n'; return 0; }
        [ -z "$first" ] && first=$t
        [ "$t" = "$first" ] || { printf 'standalone\n'; return 0; }
    done
    printf '%s\n' "${first:-standalone}"
}

cmd_install() { # topology from --gateway, profiles from --profile/--all
    local topo p u unit shared_csv pids switched=0 retired_any=0
    local profiles=() shared_new=()
    mapfile -t profiles < <(target_profiles)
    [ "${#profiles[@]}" -gt 0 ] || die "no profiles: pass --profile p[,q] or --all"
    topo=${OPT_GATEWAY:-$(default_topology "${profiles[@]}")}
    case "$topo" in standalone | shared) ;; *) die "--gateway must be standalone or shared" ;; esac
    take_lock
    mkdir -p "$RECORDS_DIR" "$BACKUP_ROOT"
    CURRENT_PROFILES="${profiles[*]}"

    step "Preflight"
    preflight 1
    load_host
    compute_plan "${profiles[@]}" >&2
    case "$PLAN:$topo" in
        move:*) [ "$OPT_FORCE" = 1 ] || die "not enough memory for these agents on this host (see the plan). Use --force to override." ;;
        shared:standalone) [ "$OPT_FORCE" = 1 ] || die "standalone does not fit; re-run with --gateway shared (after reading the trade-off) or --force" ;;
        standalone:shared) warn "standalone would fit on this host; using shared because --gateway shared was given" ;;
    esac
    for p in "${profiles[@]}"; do
        [ -d "$(profile_home "$p")" ] || [ -n "$(legacy_unit_for "$p")" ] ||
            die "profile $p does not exist ($(profile_home "$p")). Create it with: hermes profile create $p --clone"
    done
    if [ "$topo" = shared ]; then confirm_shared "${profiles[@]}"; fi
    guard_foreign_gateways "$topo" "${profiles[@]}"
    guard_watchdogs

    step "Hermes $HERMES_REF"
    ensure_hermes "${profiles[@]}"
    resolve_python
    step "Bridge bundle"
    install_bundle
    install_units

    # Phase A, the 0.3 bridge still runs: back up and check everything we can first.
    step "Checking profiles"
    for p in "${profiles[@]}"; do
        u=$(legacy_unit_for "$p")
        if [ -n "$u" ]; then rec_set "$p" legacy_unit "$u"; fi
        if [ ! -d "$(profile_home "$p")" ]; then
            hermes_cmd "" profile create "$p" --clone || die "cannot create profile $p"
        fi
        pids=$(stray_procs_for "$p" "$u" | tr '\n' ' ')
        if [ -n "${pids// /}" ] && [ "$OPT_FORCE" != 1 ]; then
            die "a 0.3 bridge process serves $p outside its unit (pid $pids). Stop it first (no duplicate runtimes), or use --force."
        fi
        backup_files "$p"
        merge_legacy_env "$p" "$u"
        check_credentials "$p"
        if in_shared "$p" && [ "$topo" = standalone ]; then switched=1; fi
    done

    # Phase B: stop the 0.3 runtime (and any 0.9 unit of the other topology) for these profiles.
    step "Stopping 0.3 bridges: ${profiles[*]}"
    LEGACY_STOPPED=1
    for p in "${profiles[@]}"; do
        u=$(rec_get "$p" legacy_unit)
        if [ -n "$u" ] && [ -z "$(rec_get "$p" legacy_state)" ]; then
            # The 0.3 unit's state before this migration; rollback restores exactly this.
            rec_set "$p" legacy_state "$(unit_enabled "$u" && printf enabled || printf disabled):$(unit_active "$u" && printf active || printf inactive)"
        fi
        if [ -n "$u" ] && { unit_active "$u" || unit_enabled "$u"; }; then
            sc disable --now "$u" >/dev/null 2>&1 || sc stop "$u"
            log "  $p: stopped and disabled $u"
        fi
        if [ -n "$u" ]; then retire_legacy_unit "$u" "$p" && retired_any=1; fi
        if [ "$topo" = shared ]; then stop_new_units_for "$p"; fi
    done
    if [ "$retired_any" = 1 ]; then sc daemon-reload; fi
    if [ "$switched" = 1 ]; then
        sc stop emperor-hermes-bridge-shared.service emperor-hermes-gateway-shared.service >/dev/null 2>&1 || true
        log "  shared gateway stopped while profiles move to standalone"
    fi
    for p in "${profiles[@]}"; do
        guard_no_duplicate "$p"
        backup_db "$(profile_home "$p")/state.db" "$BACKUP_ROOT/$p/state.db.pre-v0.22"
    done

    # Phase C: plugin and Hermes config.
    step "Configuring profiles"
    for p in "${profiles[@]}"; do
        if [ -n "$OPT_MAX_PARALLEL" ]; then env_set "$(profile_home "$p")/.env" EMPEROR_CLAW_HERMES_MAX_PARALLEL_TURNS "$OPT_MAX_PARALLEL"; fi
        install_plugin "$p"
        apply_profile_config "$p" "$topo"
        mkdir -p "$(profile_home "$p")/emperor"
        [ -n "$(rec_get "$p" installed_at)" ] || rec_set "$p" installed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        log "  $p: configured ($topo)"
    done
    if ! legacy_active; then update_global_plugin; fi

    # The shared bridge's profile list after this run.
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        if [ "$topo" = standalone ] && in_list "$p" "${profiles[@]}"; then continue; fi
        shared_new+=("$p")
    done < <(shared_list)
    if [ "$topo" = shared ]; then
        for p in "${profiles[@]}"; do in_list "$p" "${shared_new[@]}" || shared_new+=("$p"); done
    fi
    shared_csv=$(join_csv "${shared_new[@]}")
    write_host_env "$shared_csv"

    # Phase D: start. Gateway first, bridge once the gateway is ready.
    step "Starting 0.9 units"
    if [ "$topo" = standalone ]; then
        for p in "${profiles[@]}"; do
            unit="emperor-hermes-gateway@$p.service"
            sc enable "$unit" >/dev/null 2>&1
            sc restart "$unit"
            wait_ready "$(profile_home "$p")" "$p" "$unit"
            sc enable "emperor-hermes-bridge@$p.service" >/dev/null 2>&1
            sc restart "emperor-hermes-bridge@$p.service"
            rec_set "$p" topology standalone
            rec_set "$p" status active
            log "  $p: emperor-hermes-gateway@$p + emperor-hermes-bridge@$p running"
        done
        if [ "$switched" = 1 ]; then
            if [ -n "$shared_csv" ]; then
                sc start emperor-hermes-gateway-shared.service
                wait_ready "$HERMES_ROOT" shared emperor-hermes-gateway-shared.service
                sc start emperor-hermes-bridge-shared.service
                log "  shared gateway + bridge restarted for: $shared_csv"
            else
                sc disable --now emperor-hermes-bridge-shared.service emperor-hermes-gateway-shared.service >/dev/null 2>&1 || true
            fi
        fi
    else
        backup_default_home
        apply_default_home_shared
        sc enable emperor-hermes-gateway-shared.service >/dev/null 2>&1
        sc restart emperor-hermes-gateway-shared.service
        wait_ready "$HERMES_ROOT" shared emperor-hermes-gateway-shared.service
        sc enable emperor-hermes-bridge-shared.service >/dev/null 2>&1
        sc restart emperor-hermes-bridge-shared.service
        for p in "${profiles[@]}"; do
            rec_set "$p" topology shared
            rec_set "$p" status active
        done
        log "  emperor-hermes-gateway-shared + emperor-hermes-bridge-shared running for: $shared_csv"
    fi
    env_set "$HOST_STATE" bridge_changed 0
    LEGACY_STOPPED=0
    CURRENT_PROFILES=""
    step "Done"
    OPT_PROFILES=$(join_csv "${profiles[@]}")
    cmd_status || true
}

cmd_migrate() {
    if [ "$OPT_ALL" = 1 ] && [ -z "$(legacy_profiles)" ] && [ -z "$(recorded_profiles)" ]; then
        die "no 0.3 bridge units (emperor-hermes-bridge-<profile>.service) found in $UNIT_DIR"
    fi
    cmd_install
}

restart_bridges() {
    local p
    for p in $(managed_profiles); do
        if [ "$(rec_get "$p" topology)" = standalone ]; then sc restart "emperor-hermes-bridge@$p.service"; fi
    done
    if [ -n "$(shared_list)" ]; then sc restart emperor-hermes-bridge-shared.service; fi
}

cmd_update() {
    local p topo old_py new_py old_launcher profiles=()
    take_lock
    [ -f "$HOST_ENV" ] || die "nothing to update: run emperor-hermes install first"
    preflight 1
    load_host
    old_py=$(python_target)
    old_launcher=$(host_get HERMES_LAUNCHER)
    mapfile -t profiles < <(managed_profiles)
    step "Hermes $HERMES_REF"
    ensure_hermes "${profiles[@]}"
    resolve_python
    new_py=$(python_target)
    step "Bridge bundle"
    install_bundle
    install_units
    if ! legacy_active; then update_global_plugin; fi
    step "Re-applying profile config"
    for p in "${profiles[@]}"; do
        topo=$(rec_get "$p" topology)
        install_plugin "$p"
        apply_profile_config "$p" "$topo"
    done
    if [ -n "$(shared_list)" ]; then apply_default_home_shared; fi
    write_host_env "$(shared_csv)"
    if [ "$OPT_RESTART_GATEWAYS" = 1 ] || [ "$old_py" != "$new_py" ] || [ "$old_launcher" != "$HERMES_LAUNCHER" ]; then
        step "Restarting gateways (Hermes changed)"
        for p in "${profiles[@]}"; do
            if [ "$(rec_get "$p" topology)" = standalone ]; then
                sc restart "emperor-hermes-gateway@$p.service"
                wait_ready "$(profile_home "$p")" "$p" "emperor-hermes-gateway@$p.service"
            fi
        done
        if [ -n "$(shared_list)" ]; then
            sc restart emperor-hermes-gateway-shared.service
            wait_ready "$HERMES_ROOT" shared emperor-hermes-gateway-shared.service
        fi
    fi
    step "Restarting bridges ($(bridge_version))"
    restart_bridges
    env_set "$HOST_STATE" bridge_changed 0
    cmd_status || true
}

restore_profile_files() { # profile
    local p=$1 home dir ts
    home=$(profile_home "$p")
    dir="$BACKUP_ROOT/$p"
    ts=$(date -u +%Y%m%dT%H%M%SZ)
    if [ -f "$dir/state.db.pre-v0.22" ]; then
        if [ -f "$home/state.db" ]; then mv "$home/state.db" "$home/state.db.v0.22-rollback-$ts"; fi
        rm -f "$home/state.db-wal" "$home/state.db-shm"
        cp -p "$dir/state.db.pre-v0.22" "$home/state.db"
        log "  $p: state.db restored (0.22 copy kept as state.db.v0.22-rollback-$ts)"
    fi
    if [ -f "$dir/config.yaml.pre-0.9" ]; then cp -p "$dir/config.yaml.pre-0.9" "$home/config.yaml"; fi
    if [ -f "$dir/env.pre-0.9" ]; then cp -p "$dir/env.pre-0.9" "$home/.env"; fi
    if [ -d "$dir/plugin.pre-0.9" ]; then
        rm -rf "$home/plugins/emperor-claw"
        if [ ! -e "$dir/plugin.pre-0.9/.absent" ]; then cp -R "$dir/plugin.pre-0.9" "$home/plugins/emperor-claw"; fi
    fi
}

unfinalize() { # put back what finalize retired
    local f
    [ "$(host_state finalized)" = 1 ] || return 0
    step "Undoing finalize"
    if [ ! -d "$LEGACY_CHECKOUT" ]; then
        if [ -d "$BACKUP_ROOT/host/hermes-agent-legacy" ]; then
            mv "$BACKUP_ROOT/host/hermes-agent-legacy" "$LEGACY_CHECKOUT"
            log "  restored $LEGACY_CHECKOUT"
        else
            die "the old Hermes checkout was purged. Reinstall commit $(host_state legacy_hermes_commit) into $LEGACY_CHECKOUT first (install.sh --dir $LEGACY_CHECKOUT, then git checkout), then re-run rollback"
        fi
    fi
    if [ -e "$BACKUP_ROOT/host/local-bin-hermes" ] || [ -L "$BACKUP_ROOT/host/local-bin-hermes" ]; then
        rm -f "$LOCAL_HERMES"
        cp -P "$BACKUP_ROOT/host/local-bin-hermes" "$LOCAL_HERMES"
    fi
    for f in "$BACKUP_ROOT/host/units"/*.service; do
        [ -e "$f" ] || continue
        [ -e "$UNIT_DIR/${f##*/}" ] || install -m 644 "$f" "$UNIT_DIR/${f##*/}"
    done
    for f in "$BACKUP_ROOT/host/legacy-bridge"/*; do
        [ -e "$f" ] || continue
        [ -e "$BRIDGE_ROOT/${f##*/}" ] || cp -Rp "$f" "$BRIDGE_ROOT/${f##*/}"
    done
    sc daemon-reload
    env_set "$HOST_STATE" finalized 0
}

cmd_rollback_bridge() {
    local prev
    take_lock
    prev=$(host_state bridge_previous)
    if [ -z "$prev" ] || [ ! -d "$BRIDGE_ROOT/releases/$prev" ]; then die "no previous bridge bundle recorded"; fi
    load_host
    env_set "$HOST_STATE" bridge_previous "$(bridge_version)"
    ln_atomic "releases/$prev" "$BRIDGE_ROOT/current"
    env_set "$HOST_STATE" bridge_version "$prev"
    step "Bridge bundle back to $prev; restarting bridges"
    restart_bridges
}

cmd_rollback() {
    if [ "$OPT_BRIDGE_ONLY" = 1 ]; then
        cmd_rollback_bridge
        return
    fi
    local p u state touched_shared=0 remaining restored_any=0
    local profiles=() keep=()
    mapfile -t profiles < <(if [ "$OPT_ALL" = 1 ]; then recorded_profiles; fi; split_csv "$OPT_PROFILES")
    mapfile -t profiles < <(printf '%s\n' "${profiles[@]}" | awk 'NF && !seen[$0]++')
    [ "${#profiles[@]}" -gt 0 ] || die "rollback what? pass --profile p or --all"
    for p in "${profiles[@]}"; do
        [ -f "$(record_file "$p")" ] || die "$p was not installed by emperor-hermes"
    done
    take_lock
    ensure_user_bus || die "systemd user bus not reachable"
    load_host
    unfinalize

    step "Stopping 0.9 units: ${profiles[*]}"
    for p in "${profiles[@]}"; do
        stop_new_units_for "$p"
        if in_shared "$p"; then touched_shared=1; fi
    done
    if [ "$touched_shared" = 1 ]; then
        sc stop emperor-hermes-bridge-shared.service emperor-hermes-gateway-shared.service >/dev/null 2>&1 || true
    fi
    while IFS= read -r p; do
        [ -n "$p" ] && ! in_list "$p" "${profiles[@]}" && keep+=("$p")
    done < <(shared_list)
    remaining=$(join_csv "${keep[@]}")
    if [ -f "$HOST_ENV" ] && [ -n "$HERMES_LAUNCHER" ]; then write_host_env "$remaining"; fi

    step "Restoring profile files"
    for p in "${profiles[@]}"; do
        restore_profile_files "$p"
        rec_set "$p" status rolled-back
        # Retire this cycle's backups so a later install takes fresh ones.
        if [ -d "$BACKUP_ROOT/$p" ]; then
            mv "$BACKUP_ROOT/$p" "$BACKUP_ROOT/$p.rolled-back-$(date -u +%Y%m%dT%H%M%SZ)-$$"
        fi
    done
    if [ "$touched_shared" = 1 ]; then
        if [ -n "$remaining" ]; then
            sc start emperor-hermes-gateway-shared.service
            wait_ready "$HERMES_ROOT" shared emperor-hermes-gateway-shared.service
            sc start emperor-hermes-bridge-shared.service
            log "  shared gateway + bridge restarted for: $remaining"
        else
            sc disable emperor-hermes-bridge-shared.service emperor-hermes-gateway-shared.service >/dev/null 2>&1 || true
            restore_default_home
        fi
    fi

    restore_global_plugin
    step "Restoring 0.3 unit files"
    for p in "${profiles[@]}"; do
        u=$(rec_get "$p" legacy_unit)
        [ -n "$u" ] || continue
        restore_retired_unit "$u" "$p" && restored_any=1
    done
    if [ "$restored_any" = 1 ]; then sc daemon-reload; fi
    step "Starting 0.3 bridges"
    for p in "${profiles[@]}"; do
        u=$(rec_get "$p" legacy_unit)
        if [ -n "$u" ] && [ -f "$UNIT_DIR/$u" ]; then
            state=$(rec_get "$p" legacy_state)
            state=${state:-enabled:active}
            if [ "${state%%:*}" = enabled ]; then sc enable "$u" >/dev/null 2>&1 || true; fi
            if [ "${state##*:}" = active ]; then sc restart "$u"; fi
            log "  $p: $u restored (${state/:/, })"
            env_unset "$(record_file "$p")" legacy_state
        else
            warn "$p: no 0.3 unit recorded; nothing to restart"
        fi
    done
    if [ -z "$(managed_profiles)" ]; then
        restore_foreign_gateways
        restore_watchdogs
        if [ -d "$BACKUP_ROOT/host/plugin-emperor-claw.pre-0.9" ]; then
            mv "$BACKUP_ROOT/host/plugin-emperor-claw.pre-0.9" "$BACKUP_ROOT/host/plugin-emperor-claw.rolled-back-$(date -u +%Y%m%dT%H%M%SZ)-$$"
        fi
    fi
    log "Rolled back: ${profiles[*]}"
}

idle() { # profiles... -> 0 when no turn is submitted/running
    local p
    for p in "$@"; do
        if ! "$(helper_python)" -c '
import json, sys
try:
    st = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
busy = [t for t in (st.get("turns") or {}).values() if t.get("status") in ("submitted", "running")]
sys.exit(1 if busy else 0)' "$(profile_home "$p")/emperor/bridge-state.json"; then
            return 1
        fi
    done
    return 0
}

cmd_restart_gateway() {
    local targets=() p deadline
    ensure_user_bus || die "systemd user bus not reachable"
    load_host
    if [ "$OPT_SHARED" = 1 ]; then
        targets=(shared)
    elif [ -n "$OPT_PROFILES" ]; then
        mapfile -t targets < <(split_csv "$OPT_PROFILES")
    else
        for p in $(managed_profiles); do [ "$(rec_get "$p" topology)" = standalone ] && targets+=("$p"); done
        [ -n "$(shared_list)" ] && targets+=(shared)
    fi
    [ "${#targets[@]}" -gt 0 ] || die "no gateways to restart"
    for p in "${targets[@]}"; do
        if [ "$OPT_WHEN_IDLE" = 1 ]; then
            local watch=("$p")
            if [ "$p" = shared ]; then mapfile -t watch < <(shared_list); fi
            deadline=$(($(date +%s) + OPT_TIMEOUT))
            until idle "${watch[@]}"; do
                [ "$(date +%s)" -lt "$deadline" ] || die "$p: still busy after ${OPT_TIMEOUT}s; not restarting"
                sleep 5
            done
        fi
        if [ "$p" = shared ]; then
            guard_foreign_gateways shared
            sc restart emperor-hermes-gateway-shared.service
            wait_ready "$HERMES_ROOT" shared emperor-hermes-gateway-shared.service
        else
            guard_foreign_gateways standalone "$p"
            sc restart "emperor-hermes-gateway@$p.service"
            wait_ready "$(profile_home "$p")" "$p" "emperor-hermes-gateway@$p.service"
        fi
    done
}

cmd_finalize() {
    local p u f commit
    take_lock
    ensure_user_bus || die "systemd user bus not reachable"
    load_host
    [ -n "$HERMES_LAUNCHER" ] || die "Hermes $HERMES_REF is not installed"
    [ "$(host_state finalized)" != 1 ] || { log "already finalized"; return 0; }
    for p in $(recorded_profiles); do
        [ "$(rec_get "$p" status)" = active ] || [ "$OPT_FORCE" = 1 ] || die "$p is not on 0.9 (status $(rec_get "$p" status)); use --force to finalize anyway"
    done
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        p=$(legacy_unit_profile "$f")
        [ "$(rec_get "$p" status)" = active ] || [ "$OPT_FORCE" = 1 ] ||
            die "${f##*/} serves $p, which is not migrated yet; migrate it first or use --force"
    done < <(legacy_unit_files)
    step "Finalizing"
    mkdir -p "$BACKUP_ROOT/host/units" "$BACKUP_ROOT/host/legacy-bridge"
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        u=${f##*/}
        sc disable --now "$u" >/dev/null 2>&1 || true
        cp -p "$f" "$BACKUP_ROOT/host/units/$u"
        rm -f "$f"
        log "  retired $u (copy in $BACKUP_ROOT/host/units)"
    done < <(legacy_unit_files)
    for f in emperor_hermes_bridge.py emperor_goals.py hermes_goal_adapter.py operating-guide.md; do
        if [ -e "$BRIDGE_ROOT/$f" ]; then mv -f "$BRIDGE_ROOT/$f" "$BACKUP_ROOT/host/legacy-bridge/$f"; fi
    done
    if [ -e "$LOCAL_HERMES" ] && [ ! -e "$BACKUP_ROOT/host/local-bin-hermes" ]; then cp -P "$LOCAL_HERMES" "$BACKUP_ROOT/host/local-bin-hermes"; fi
    mkdir -p "$(dirname "$LOCAL_HERMES")"
    ln_atomic "$HERMES_LAUNCHER" "$LOCAL_HERMES"
    log "  $LOCAL_HERMES -> $HERMES_LAUNCHER"
    if [ -d "$LEGACY_CHECKOUT" ] && [ "$(readlink -f "$LEGACY_CHECKOUT")" != "$(readlink -f "$HERMES_DIR")" ]; then
        commit=$(checkout_head "$LEGACY_CHECKOUT")
        env_set "$HOST_STATE" legacy_hermes_commit "${commit:-unknown}"
        if [ "$OPT_PURGE" = 1 ]; then
            rm -rf "$LEGACY_CHECKOUT"
            log "  removed $LEGACY_CHECKOUT (was ${commit:-unknown})"
        else
            rm -rf "$BACKUP_ROOT/host/hermes-agent-legacy"
            mv "$LEGACY_CHECKOUT" "$BACKUP_ROOT/host/hermes-agent-legacy"
            log "  archived $LEGACY_CHECKOUT (${commit:-unknown}) to $BACKUP_ROOT/host/hermes-agent-legacy"
        fi
    fi
    sc daemon-reload
    env_set "$HOST_STATE" finalized 1
    log "Finalized. Rollback still works: emperor-hermes rollback --all"
}

health_summary() { # profile -> one line from <home>/emperor/health.json (written by the bridge)
    "$(helper_python)" -c '
import json, sys
try:
    h = json.load(open(sys.argv[1]))
except Exception:
    print("no health.json yet")
    sys.exit(0)
keys = ("bridgeVersion", "registered", "duplicateRuntime", "sharedHostOk", "gatewayTopology", "lastError")
print(" ".join("%s=%s" % (k, h[k]) for k in keys if k in h) or "health.json present")
' "$(profile_home "$1")/emperor/health.json"
}

cmd_status() {
    local p topo bad=0 out u head pids profiles=()
    ensure_user_bus || die "systemd user bus not reachable"
    load_host
    if [ -n "$OPT_PROFILES" ]; then mapfile -t profiles < <(split_csv "$OPT_PROFILES"); else mapfile -t profiles < <(recorded_profiles); fi
    head=$(checkout_head "$HERMES_DIR")
    printf 'emperor-hermes %s on %s (%s)\n' "$EMPEROR_HERMES_VERSION" "$(uname -n)" "$(uname -m)"
    printf '  hermes:   %s %s\n' "$HERMES_DIR" "$([ "$head" = "$HERMES_SHA" ] && printf '(%s, pinned)' "$HERMES_REF" || printf '(NOT at %s: %s)' "$HERMES_REF" "${head:-missing}")"
    [ "$head" = "$HERMES_SHA" ] || bad=1
    printf '  python:   %s -> %s\n' "$STABLE_PYTHON" "$(python_target)"
    [ -x "$STABLE_PYTHON" ] || bad=1
    printf '  bridge:   %s\n' "$(bridge_version)"
    printf '  finalized: %s\n' "$( [ "$(host_state finalized)" = 1 ] && printf yes || printf no)"
    if report_watchdogs; then bad=1; fi
    if [ -n "$(shared_list)" ]; then
        out=$(identify "$HERMES_ROOT")
        printf '  shared gateway: %s, %s\n' "$(sc is-active emperor-hermes-gateway-shared.service 2>/dev/null || true)" "$out"
        printf '  shared bridge:  %s (%s)\n' "$(sc is-active emperor-hermes-bridge-shared.service 2>/dev/null || true)" "$(shared_csv)"
        unit_active emperor-hermes-gateway-shared.service && unit_active emperor-hermes-bridge-shared.service || bad=1
        case "$out" in "ready $HERMES_CODE_VERSION "*) ;; *) bad=1 ;; esac
    fi
    for p in "${profiles[@]}"; do
        topo=$(rec_get "$p" topology)
        printf '%s [%s, %s]\n' "$p" "${topo:-not installed}" "$(rec_get "$p" status)"
        [ "$(rec_get "$p" status)" = active ] || { bad=1; continue; }
        if [ "$topo" = standalone ]; then
            out=$(identify "$(profile_home "$p")")
            printf '  gateway: %s, %s\n' "$(sc is-active "emperor-hermes-gateway@$p.service" 2>/dev/null || true)" "$out"
            printf '  bridge:  %s\n' "$(sc is-active "emperor-hermes-bridge@$p.service" 2>/dev/null || true)"
            unit_active "emperor-hermes-gateway@$p.service" && unit_active "emperor-hermes-bridge@$p.service" || bad=1
            case "$out" in "ready $HERMES_CODE_VERSION "*) ;; *) bad=1 ;; esac
        else
            in_shared "$p" || { printf '  NOT in the shared bridge profile list\n'; bad=1; }
        fi
        printf '  health:  %s\n' "$(health_summary "$p")"
        u=$(rec_get "$p" legacy_unit)
        if [ -n "$u" ] && [ -f "$UNIT_DIR/$u" ]; then
            printf '  0.3 unit %s: %s/%s\n' "$u" "$(sc is-active "$u" 2>/dev/null || true)" "$(sc is-enabled "$u" 2>/dev/null || true)"
            if unit_active "$u"; then printf '  DUPLICATE: the 0.3 unit is running too\n'; bad=1; fi
        elif [ -n "$u" ] && [ -e "$BACKUP_ROOT/retired-units/$u" ]; then
            printf '  0.3 unit %s: retired\n' "$u"
        fi
        pids=$(legacy_procs_for "$p" | tr '\n' ' ')
        if [ -n "${pids// /}" ]; then printf '  DUPLICATE: 0.3 bridge process(es) %s\n' "$pids"; bad=1; fi
    done
    if [ "$bad" = 1 ]; then printf 'STATUS: problems found\n'; return 1; fi
    printf 'STATUS: ok\n'
}

cmd_measure() {
    local u mib pid line json="" ts gw_shared=""
    ensure_user_bus || die "systemd user bus not reachable"
    mkdir -p "$DATA_DIR"
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf 'Memory measurement %s on %s (%s), MemAvailable %d MiB\n' "$ts" "$(uname -n)" "$(uname -m)" "$(mem_available_mib)"
    printf '  %-48s %8s %8s\n' unit pid MiB
    while IFS= read -r line; do
        u=${line%% *}
        [ -n "$u" ] || continue
        mib=$(unit_mem_mib "$u")
        pid=$(sc show -p MainPID --value "$u" 2>/dev/null || printf 0)
        printf '  %-48s %8s %8s\n' "$u" "$pid" "$mib"
        json="$json{\"unit\":\"$u\",\"mib\":$mib},"
        [ "$u" = emperor-hermes-gateway-shared.service ] && gw_shared=$mib
    done < <(sc list-units --type=service --state=active --no-legend --plain 'emperor-hermes-*' 2>/dev/null | awk '{print $1}')
    printf '{"ts":"%s","host":"%s","arch":"%s","memAvailableMib":%d,"units":[%s]}\n' \
        "$ts" "$(uname -n)" "$(uname -m)" "$(mem_available_mib)" "${json%,}" >>"$DATA_DIR/measurements.jsonl"
    if [ -n "$gw_shared" ]; then
        if [ "$gw_shared" -le "$MIB_R1_GATE" ]; then
            printf 'R-1 item 1: shared gateway %d MiB <= %d MiB: PASS (valid only after ~20 warm turns per profile)\n' "$gw_shared" "$MIB_R1_GATE"
        else
            printf 'R-1 item 1: shared gateway %d MiB > %d MiB: FAIL\n' "$gw_shared" "$MIB_R1_GATE"
        fi
    fi
    printf 'Appended to %s\n' "$DATA_DIR/measurements.jsonl"
}

cmd_doctor() {
    if [ "$OPT_MEASURE" = 1 ]; then cmd_measure; return; fi
    local profiles=()
    if [ -n "$OPT_PROFILES" ]; then
        mapfile -t profiles < <(split_csv "$OPT_PROFILES")
    else
        mapfile -t profiles < <( { legacy_profiles; recorded_profiles; } | awk 'NF && !seen[$0]++')
    fi
    if [ "$OPT_PLAN" = 1 ]; then
        ensure_user_bus || warn "systemd user bus not reachable: 0.3 bridge memory is not counted"
        [ "${#profiles[@]}" -gt 0 ] || die "no profiles found; pass --profiles a,b"
        compute_plan "${profiles[@]}"
        local homes=() p found
        for p in "${profiles[@]}"; do homes+=("$(profile_home "$p")"); done
        found=$(foreign_gateways "$HERMES_ROOT" "${homes[@]}" | awk '!seen[$0]++')
        if [ -n "$found" ]; then
            printf 'NOTE: Hermes gateways not started by emperor-hermes serve these profiles (install needs --take-over-gateway):\n'
            printf '%s\n' "$found" | sed 's/^/  /'
        fi
        return 0
    fi
    local homes=() p
    for p in "${profiles[@]}"; do homes+=("$(profile_home "$p")"); done
    printf 'Preflight\n'
    preflight 0 2>&1
    load_host
    if [ "$(checkout_head "$HERMES_DIR")" = "$HERMES_SHA" ]; then
        printf 'Hermes checkout %s: pinned %s\n' "$HERMES_DIR" "$HERMES_REF"
    else
        printf 'Hermes checkout %s: not installed yet\n' "$HERMES_DIR"
    fi
    printf 'Legacy Hermes checkout %s: %s\n' "$LEGACY_CHECKOUT" "$(checkout_head "$LEGACY_CHECKOUT")"
    printf '0.3 bridge units: %s\n' "$(legacy_unit_files | sed 's#.*/##' | tr '\n' ' ')"
    printf 'Profiles: %s\n' "${profiles[*]:-none}"
    local foreign
    foreign=$(foreign_gateways "$HERMES_ROOT" "${homes[@]}" | awk '!seen[$0]++')
    if [ -n "$foreign" ]; then
        printf 'Hermes gateways not started by emperor-hermes (install refuses unless --take-over-gateway):\n'
        printf '%s\n' "$foreign" | sed 's/^/  /'
    fi
    report_watchdogs || true
    if [ -e "$STABLE_PYTHON" ]; then printf 'Bridge python: %s\n' "$(python_target)"; fi
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --profile | --profiles) [ "$#" -ge 2 ] || die "$1 needs a value"; OPT_PROFILES="${OPT_PROFILES:+$OPT_PROFILES,}$2"; shift ;;
            --profile=* | --profiles=*) OPT_PROFILES="${OPT_PROFILES:+$OPT_PROFILES,}${1#*=}" ;;
            --all) OPT_ALL=1 ;;
            --gateway) [ "$#" -ge 2 ] || die "--gateway needs a value"; OPT_GATEWAY=$2; shift ;;
            --gateway=*) OPT_GATEWAY=${1#*=} ;;
            --hermes-dir) [ "$#" -ge 2 ] || die "--hermes-dir needs a value"; OPT_HERMES_DIR=$2; shift ;;
            --hermes-dir=*) OPT_HERMES_DIR=${1#*=} ;;
            --bundle) [ "$#" -ge 2 ] || die "--bundle needs a value"; OPT_BUNDLE=$2; shift ;;
            --bundle=*) OPT_BUNDLE=${1#*=} ;;
            --version) [ "$#" -ge 2 ] || die "--version needs a value"; OPT_VERSION=$2; shift ;;
            --max-parallel) [ "$#" -ge 2 ] || die "--max-parallel needs a value"; OPT_MAX_PARALLEL=$2; shift ;;
            --delta-mib) [ "$#" -ge 2 ] || die "--delta-mib needs a value"; OPT_DELTA_MIB=$2; shift ;;
            --timeout) [ "$#" -ge 2 ] || die "--timeout needs a value"; OPT_TIMEOUT=$2; shift ;;
            --skip-browser) OPT_SKIP_BROWSER=1 ;;
            --yes | -y) OPT_YES=1 ;;
            --force) OPT_FORCE=1 ;;
            --take-over-gateway) OPT_TAKE_OVER=1 ;;
            --plan) OPT_PLAN=1 ;;
            --measure) OPT_MEASURE=1 ;;
            --when-idle) OPT_WHEN_IDLE=1 ;;
            --shared) OPT_SHARED=1 ;;
            --purge) OPT_PURGE=1 ;;
            --bridge-only) OPT_BRIDGE_ONLY=1 ;;
            --restart-gateways) OPT_RESTART_GATEWAYS=1 ;;
            --disable-watchdogs) OPT_DISABLE_WATCHDOGS=1 ;;
            -h | --help) usage; exit 0 ;;
            *) die "unknown option: $1 (see emperor-hermes help)" ;;
        esac
        shift
    done
    if [ -n "$OPT_HERMES_DIR" ]; then
        case "$OPT_HERMES_DIR" in "~"/*) OPT_HERMES_DIR="$HOME/${OPT_HERMES_DIR#\~/}" ;; /*) ;; *) OPT_HERMES_DIR="$PWD/$OPT_HERMES_DIR" ;; esac
    fi
    if [ -n "$OPT_BUNDLE" ]; then
        case "$OPT_BUNDLE" in http://* | https://* | /*) ;; *) OPT_BUNDLE="$PWD/$OPT_BUNDLE" ;; esac
    fi
    [[ "$OPT_DELTA_MIB" =~ ^[0-9]+$ ]] || die "--delta-mib must be a number"
    [[ "$OPT_TIMEOUT" =~ ^[0-9]+$ ]] || die "--timeout must be a number"
    [ -z "$OPT_MAX_PARALLEL" ] || [[ "$OPT_MAX_PARALLEL" =~ ^[1-9][0-9]*$ ]] || die "--max-parallel must be a positive number"
    return 0
}

CMD=""
main() {
    CMD=${1:-help}
    local cmd=$CMD
    [ "$#" -gt 0 ] && shift
    parse_args "$@"
    mkdir -p "$DATA_DIR"
    case "$cmd" in
        install) cmd_install ;;
        migrate) cmd_migrate ;;
        update) cmd_update ;;
        rollback) cmd_rollback ;;
        status) cmd_status || exit 1 ;;
        doctor) cmd_doctor ;;
        finalize) cmd_finalize ;;
        restart-gateway) cmd_restart_gateway ;;
        version | --version) printf 'emperor-hermes %s (Hermes %s %s)\n' "$EMPEROR_HERMES_VERSION" "$HERMES_REF" "$HERMES_SHA" ;;
        help | -h | --help) usage ;;
        *) usage >&2; die "unknown command: $cmd" ;;
    esac
}

main "$@"
