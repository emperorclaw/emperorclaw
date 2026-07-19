#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# EmperorClaw — Pre-update database backup
# ═══════════════════════════════════════════════════════════════
# Usage:
#   ./scripts/backup-db.sh
#   ./scripts/backup-db.sh --output /path/to/backup.sql
#
# Requires: pg_dump (PostgreSQL client tools)
# Reads POSTGRES_CONNECTION_STRING from .env if not set in environment.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# ── Resolve connection string ──────────────────────────────────
if [ -z "${POSTGRES_CONNECTION_STRING:-}" ]; then
    if [ -f "$REPO_DIR/.env" ]; then
        # shellcheck disable=SC2046
        export $(grep -v '^#' "$REPO_DIR/.env" | grep POSTGRES_CONNECTION_STRING | xargs)
    fi
fi

if [ -z "${POSTGRES_CONNECTION_STRING:-}" ]; then
    echo -e "${RED}POSTGRES_CONNECTION_STRING is not set. Set it in .env or export it.${NC}"
    exit 1
fi

# ── Output path ─────────────────────────────────────────────────
OUTPUT="${1:-}"
if [ -z "$OUTPUT" ]; then
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    OUTPUT="$REPO_DIR/backups/emperorclaw-backup-${TIMESTAMP}.sql"
fi

mkdir -p "$(dirname "$OUTPUT")"

echo -e "${YELLOW}Backing up EmperorClaw database...${NC}"
echo -e "  Connection: ${POSTGRES_CONNECTION_STRING%%@*}@***"
echo -e "  Output:     ${OUTPUT}"

if pg_dump "$POSTGRES_CONNECTION_STRING" > "$OUTPUT" 2>/dev/null; then
    SIZE=$(du -h "$OUTPUT" | cut -f1)
    echo -e "${GREEN}✓ Backup complete (${SIZE})${NC}"
    echo -e "  ${OUTPUT}"
else
    echo -e "${RED}✗ Backup failed. Check your connection string and that pg_dump is installed.${NC}"
    exit 1
fi

# ── Rotation: keep last 7 backups ───────────────────────────────
BACKUP_DIR="$(dirname "$OUTPUT")"
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "emperorclaw-backup-*.sql" -type f 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt 7 ]; then
    echo -e "${YELLOW}Rotating old backups (keeping last 7)...${NC}"
    find "$BACKUP_DIR" -name "emperorclaw-backup-*.sql" -type f | sort | head -n -7 | xargs rm -f
fi

echo ""
echo -e "${GREEN}Ready to upgrade. Run:${NC}"
echo -e "  cd ${REPO_DIR}"
echo -e "  git pull --ff-only origin main"
echo -e "  docker compose up -d --build"
