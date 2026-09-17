#!/usr/bin/env bash
set -euo pipefail
# Install Docker Engine and Compose from Docker's official apt repository.
DISTRO=$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2 }' /etc/os-release)
CODENAME=$(awk -F= '$1 == "VERSION_CODENAME" { gsub(/"/, "", $2); print $2 }' /etc/os-release)
case "$DISTRO" in ubuntu|debian) ;; *) echo "Install Docker for your Linux distribution: https://docs.docker.com/engine/install/" >&2; exit 1;; esac
[ -n "$CODENAME" ] || { echo "Cannot determine your distribution release." >&2; exit 1; }
PRIVILEGED=()
if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null || { echo "Docker setup needs sudo or root." >&2; exit 1; }
    PRIVILEGED=(sudo)
fi
"${PRIVILEGED[@]}" apt-get update
"${PRIVILEGED[@]}" apt-get install -y ca-certificates curl
"${PRIVILEGED[@]}" install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$DISTRO/gpg" | "${PRIVILEGED[@]}" tee /etc/apt/keyrings/docker.asc >/dev/null
"${PRIVILEGED[@]}" chmod a+r /etc/apt/keyrings/docker.asc
ARCH=$(dpkg --print-architecture)
printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$DISTRO" "$CODENAME" "$ARCH" | "${PRIVILEGED[@]}" tee /etc/apt/sources.list.d/docker.sources >/dev/null
"${PRIVILEGED[@]}" apt-get update
"${PRIVILEGED[@]}" apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
"${PRIVILEGED[@]}" systemctl enable --now docker
