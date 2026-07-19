#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# EmperorClaw — Standard update script
# ═══════════════════════════════════════════════════════════════
# Usage:
#   ./scripts/update.sh            # Update from git, rebuild, restart
#   ./scripts/update.sh --docker   # Update via Docker (pull image, recreate)
#   ./scripts/update.sh --check    # Only check if update is available
#
# This script is idempotent and safe for cron jobs.
# It backs up the database before applying any changes.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

MODE="${1:-git}"

# ── Check mode ───────────────────────────────────────────────────
if [[ "$MODE" == "--check" ]]; then
    git fetch origin 2>/dev/null
    BEHIND=$(git rev-list HEAD..origin/main --count 2>/dev/null || echo "0")
    if [[ "$BEHIND" -gt 0 ]]; then
        echo -e "${YELLOW}Update available: ${BEHIND} commit(s) behind origin/main${NC}"
        exit 1
    else
        echo -e "${GREEN}Already up to date.${NC}"
        exit 0
    fi
fi

echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║              EmperorClaw — Update                            ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Docker mode ──────────────────────────────────────────────────
if [[ "$MODE" == "--docker" ]]; then
    echo -e "${YELLOW}Pulling latest Docker image...${NC}"
    docker compose pull app
    echo -e "${YELLOW}Recreating containers...${NC}"
    docker compose up -d --remove-orphans
    echo -e "${GREEN}✓ EmperorClaw updated via Docker${NC}"
    echo -e "  Check logs: docker compose logs -f app"
    exit 0
fi

# ── Git mode (source build) ──────────────────────────────────────

# 1. Backup
echo -e "${YELLOW}[1/5] Backing up database...${NC}"
if [[ -f "$REPO_DIR/scripts/backup-db.sh" ]]; then
    bash "$REPO_DIR/scripts/backup-db.sh"
else
    echo -e "${RED}  backup-db.sh not found — skipping backup${NC}"
fi

# 2. Pull
echo -e "${YELLOW}[2/5] Pulling latest code...${NC}"
git fetch origin
BEHIND=$(git rev-list HEAD..origin/main --count 2>/dev/null || echo "0")
if [[ "$BEHIND" -eq 0 ]]; then
    echo -e "${GREEN}  Already up to date. Nothing to do.${NC}"
    exit 0
fi
echo -e "  ${BEHIND} commit(s) behind — pulling..."
git pull --ff-only origin main

# 3. Install
echo -e "${YELLOW}[3/5] Installing dependencies...${NC}"
npm install --no-audit --no-fund

# 4. Build
echo -e "${YELLOW}[4/5] Building...${NC}"
npm run build

# 5. Migrate + restart
echo -e "${YELLOW}[5/5] Running migrations + restarting...${NC}"
npm run db:migrate

if command -v pm2 &>/dev/null && pm2 list 2>/dev/null | grep -q emperorclaw; then
    pm2 restart emperorclaw
    echo -e "${GREEN}✓ EmperorClaw restarted via pm2${NC}"
elif docker compose version &>/dev/null && docker compose ps 2>/dev/null | grep -q emperorclaw; then
    docker compose up -d --build --remove-orphans
    echo -e "${GREEN}✓ EmperorClaw restarted via Docker Compose${NC}"
else
    echo -e "${YELLOW}⚠ Could not detect process manager. Restart manually.${NC}"
fi

echo ""
echo -e "${GREEN}✓ EmperorClaw updated to $(git rev-parse --short HEAD)${NC}"
echo -e "  Version: $(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo 'unknown')"
