#!/usr/bin/env bash
set -euo pipefail

# Emperor Claw local companion doctor (runtime-side)

API_URL="${EMPEROR_CLAW_API_URL:-https://emperorclaw.malecu.eu}"
TOKEN="${EMPEROR_CLAW_API_TOKEN:-}"
COMPANION_DIR="${EMPEROR_CLAW_COMPANION_DIR:-$HOME/.openclaw/emperor-control-plane}"\

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_header() { echo -e "\n${BLUE}=== $1 ===${NC}"; }
print_success() { echo -e "${GREEN}✓ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠ $1${NC}"; }
print_error() { echo -e "${RED}✗ $1${NC}"; }
print_info() { echo -e "${BLUE}ℹ $1${NC}"; }

check_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    print_success "$1 found: $(command -v "$1")"
    return 0
  fi
  print_error "$1 not found"
  return 1
}

check_prereqs() {
  print_header "Prerequisite Check"
  local ok=0
  for c in curl node npm python3; do
    check_cmd "$c" || ok=1
  done
  return $ok
}

check_api() {
  print_header "API Connectivity"
  if [[ -z "$TOKEN" ]]; then
    print_warning "EMPEROR_CLAW_API_TOKEN not set; skipping API check"
    return 1
  fi
  local resp status
  resp=$(curl -sS -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$API_URL/api/mcp/agents?limit=1" -o /tmp/emperor-skill-doctor.json || true)
  status="${resp: -3}"
  if [[ "$status" != "200" ]]; then
    print_error "API returned HTTP $status"
    [[ -s /tmp/emperor-skill-doctor.json ]] && head -c 200 /tmp/emperor-skill-doctor.json && echo
    return 1
  fi
  print_success "API reachable (HTTP 200)"
  return 0
}

check_companion() {
  print_header "Companion Directory"
  if [[ ! -d "$COMPANION_DIR" ]]; then
    print_error "Companion dir not found: $COMPANION_DIR"
    return 1
  fi
  print_success "Companion dir: $COMPANION_DIR"
  for f in .env run-bridge.sh doctor.sh state/bridge-state.json; do
    if [[ -e "$COMPANION_DIR/$f" ]]; then
      print_success "$f present"
    else
      print_warning "$f missing"
    fi
  done
}

check_bridge_process() {
  print_header "Bridge Process"
  local pids
  pids=$(ps aux | grep -E "node .*bridge\\.js" | grep -v grep | awk '{print $2}' | tr '\n' ' ')
  if [[ -z "$pids" ]]; then
    print_warning "No bridge process found"
    return 1
  fi
  print_success "Bridge running (PID(s): $pids)"
}

check_systemd() {
  print_header "systemd User Service"
  if ! command -v systemctl >/dev/null 2>&1; then
    print_warning "systemctl not available"
    return 1
  fi
  if ! systemctl --user status >/dev/null 2>&1; then
    print_warning "systemd --user not active"
    return 1
  fi
  local services
  services=$(systemctl --user list-units 'emperor-claw-bridge-*' --no-legend 2>/dev/null || true)
  if [[ -z "$services" ]]; then
    print_warning "No emperor-claw-bridge-* user services registered"
    return 1
  fi
  echo "$services" | while read -r line; do
    local name status
    name=$(echo "$line" | awk '{print $1}')
    status=$(echo "$line" | awk '{print $3 " " $4}')
    echo "  $name $status"
  done
}

main() {
  check_prereqs || true
  check_api || true
  check_companion || true
  check_bridge_process || true
  check_systemd || true
}

main "$@"
