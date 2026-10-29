#!/usr/bin/env bash
# Build the Emperor Claw Hermes bridge bundle for remote hosts (`emperor-hermes`).
#
# Output (in --out, default dist/hermes-bridge):
#   emperor-hermes-bridge-<ver>.tar.gz (+ .sha256)   bridge package, plugin, units, logrotate config
#   emperor-hermes.sh (+ .sha256)                    the installer, published as a release asset
#
# Bundle layout (top directory emperor-hermes-bridge-<ver>/):
#   VERSION                  bridge version
#   bridge/                  python packages `emperor_bridge` (+ goal adapter) and `emperor_hostd`
#                            (the runtime host daemon); PYTHONPATH for the units
#   plugin/emperor-claw/     Hermes plugin copied into each profile
#   systemd/*.service        the unit templates (gateway, bridge, shared pair, hostd)
#   logrotate.conf           user logrotate config template
#   emperor-hermes.sh        installer copy
#
# Usage: scripts/package-hermes-bridge.sh [--version V] [--out DIR] [--plugin-dir DIR]
set -Eeuo pipefail
umask 022

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
plugin_dir="$repo/integrations/hermes/emperor-claw"
out="$repo/dist/hermes-bridge"
version=""

die() { printf 'package-hermes-bridge: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version) version=${2:?}; shift ;;
        --out) out=${2:?}; shift ;;
        --plugin-dir) plugin_dir=${2:?}; shift ;;
        -h | --help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) die "unknown option: $1" ;;
    esac
    shift
done

bridge_dir="$plugin_dir/bridge"
[ -f "$bridge_dir/emperor_bridge/__main__.py" ] ||
    die "$bridge_dir/emperor_bridge/__main__.py is missing: the bridge 0.9 package must exist before packaging"
[ -f "$bridge_dir/emperor_hostd/__main__.py" ] ||
    die "$bridge_dir/emperor_hostd/__main__.py is missing: the host daemon ships in the bundle"

if [ -z "$version" ]; then
    # BRIDGE_VERSION = "x.y.z" in emperor_bridge/version.py is the source of truth.
    version=$(sed -nE 's/^BRIDGE_VERSION[[:space:]]*(:[^=]*)?=[[:space:]]*["'\'']([^"'\'']+)["'\''].*/\2/p' \
        "$bridge_dir/emperor_bridge/version.py" 2>/dev/null | head -n 1 || true)
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$ ]] || die "cannot determine a valid version (got '${version}'); pass --version"

for f in "$repo/integrations/hermes/systemd/emperor-hermes-gateway@.service" \
    "$repo/integrations/hermes/systemd/emperor-hermes-bridge@.service" \
    "$repo/integrations/hermes/systemd/emperor-hermes-gateway-shared.service" \
    "$repo/integrations/hermes/systemd/emperor-hermes-bridge-shared.service" \
    "$repo/integrations/hermes/systemd/emperor-hermes-hostd.service" \
    "$repo/integrations/hermes/install/logrotate.conf" \
    "$repo/integrations/hermes/install/emperor-hermes.sh"; do
    [ -f "$f" ] || die "missing $f"
done

name="emperor-hermes-bridge-$version"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
top="$work/$name"
mkdir -p "$top/bridge" "$top/plugin/emperor-claw" "$top/systemd"

copy_tree() { # src dest: copy without caches or compiled files
    (cd "$1" && tar -cf - --exclude='__pycache__' --exclude='*.pyc' --exclude='.pytest_cache' --exclude='./bridge' .) |
        (cd "$2" && tar -xf -)
}
# The bridge 0.9 package (emperor_bridge/) plus its sibling modules (run.py, hermes_goal_adapter.py).
(cd "$bridge_dir" && tar -cf - --exclude='__pycache__' --exclude='*.pyc' .) | (cd "$top/bridge" && tar -xf -)
copy_tree "$plugin_dir" "$top/plugin/emperor-claw"
cp "$repo"/integrations/hermes/systemd/emperor-hermes-*.service "$top/systemd/"
cp "$repo/integrations/hermes/install/logrotate.conf" "$top/logrotate.conf"
cp "$repo/integrations/hermes/install/emperor-hermes.sh" "$top/emperor-hermes.sh"
chmod 755 "$top/emperor-hermes.sh"
printf '%s\n' "$version" >"$top/VERSION"

mkdir -p "$out"
tarball="$out/$name.tar.gz"
# Reproducible when GNU tar is available: fixed order, owner and mtime.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
    tar -C "$work" --sort=name --mtime='2026-01-01 00:00:00Z' --owner=0 --group=0 --numeric-owner -cf - "$name" | gzip -n -9 >"$tarball"
else
    tar -C "$work" -cf - "$name" | gzip -n -9 >"$tarball"
fi
cp "$repo/integrations/hermes/install/emperor-hermes.sh" "$out/emperor-hermes.sh"
chmod 755 "$out/emperor-hermes.sh"
(cd "$out" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256" && sha256sum emperor-hermes.sh >emperor-hermes.sh.sha256)
printf '%s\n' "$tarball"
