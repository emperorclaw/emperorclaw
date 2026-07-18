#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
# EmperorClaw — One-command installer
# ═══════════════════════════════════════════════════════════════
# This script sets up EmperorClaw with Docker in a single step.
#
# Usage:
#   curl -fsSL https://emperorclaw.com/install.sh | bash
#   ./install.sh
#   ./install.sh --domain claw.mycompany.com

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║              EmperorClaw — Self-Hosted Installer            ║${NC}"
echo -e "${CYAN}║              https://emperorclaw.com                        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Parse args ──────────────────────────────────────────────────
DOMAIN=""
for arg in "$@"; do
    case "$arg" in
        --domain=*) DOMAIN="${arg#*=}" ;;
        --domain) DOMAIN="$2"; shift ;;
    esac
    shift 2>/dev/null || true
done

# ── Prerequisites ────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || { echo -e "${RED}git is required. Install it first: https://git-scm.com${NC}"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo -e "${RED}Docker is required. Install it first: https://docs.docker.com/engine/install/${NC}"; exit 1; }

DOCKER_COMPOSE_CMD=""
if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker-compose"
else
    echo -e "${RED}Docker Compose is required (docker compose or docker-compose).${NC}"
    exit 1
fi

echo -e "${GREEN}✓ git found${NC}"
echo -e "${GREEN}✓ Docker found${NC}"
echo ""

# ── Clone or detect repo ────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
    REPO_DIR="$SCRIPT_DIR"
    echo -e "${YELLOW}Detected existing EmperorClaw installation at $REPO_DIR${NC}"
else
    REPO_DIR="$HOME/emperorclaw"
    if [ -d "$REPO_DIR" ]; then
        echo -e "${YELLOW}Directory $REPO_DIR already exists. Updating...${NC}"
        cd "$REPO_DIR"
        git pull --ff-only origin main 2>/dev/null || true
    else
        echo -e "Cloning EmperorClaw into $REPO_DIR ..."
        git clone https://github.com/emperorclaw/emperorclaw.git "$REPO_DIR"
    fi
    cd "$REPO_DIR"
fi

echo ""

# ── .env setup ───────────────────────────────────────────────────
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}Creating .env from .env.example ...${NC}"
    cp .env.example .env

    # Generate a secure NEXTAUTH_SECRET
    if command -v openssl >/dev/null 2>&1; then
        SECRET=$(openssl rand -base64 32)
    else
        SECRET=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)
    fi

    # Update .env with generated secret
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$SECRET|" .env
    else
        sed -i "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$SECRET|" .env
    fi

    # Generate master key
    if command -v openssl >/dev/null 2>&1; then
        MASTER_KEY=$(openssl rand -hex 32)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^EMPEROR_CLAW_MASTER_KEY=.*|EMPEROR_CLAW_MASTER_KEY=$MASTER_KEY|" .env
        else
            sed -i "s|^EMPEROR_CLAW_MASTER_KEY=.*|EMPEROR_CLAW_MASTER_KEY=$MASTER_KEY|" .env
        fi
    fi

    echo -e "${GREEN}✓ .env created with generated secrets${NC}"
else
    echo -e "${YELLOW}.env already exists — skipping${NC}"
    # Check if NEXTAUTH_SECRET is still blank
    if grep -q '^NEXTAUTH_SECRET=$' .env 2>/dev/null; then
        echo -e "${RED}⚠  NEXTAUTH_SECRET is empty in .env. Generate one with: openssl rand -base64 32${NC}"
        echo -e "${RED}   The app will refuse to start without it.${NC}"
    fi
fi

# ── Domain configuration ─────────────────────────────────────────
if [ -n "$DOMAIN" ]; then
    echo -e "Configuring for domain: ${GREEN}$DOMAIN${NC}"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^APP_URL=.*|APP_URL=https://$DOMAIN|" .env
        sed -i '' "s|^NEXTAUTH_URL=.*|NEXTAUTH_URL=https://$DOMAIN|" .env
    else
        sed -i "s|^APP_URL=.*|APP_URL=https://$DOMAIN|" .env
        sed -i "s|^NEXTAUTH_URL=.*|NEXTAUTH_URL=https://$DOMAIN|" .env
    fi
fi

echo ""

# ── Build & start ────────────────────────────────────────────────
echo -e "${CYAN}Building and starting EmperorClaw ...${NC}"
echo -e "This may take a few minutes on first run."
echo ""

$DOCKER_COMPOSE_CMD up -d --build

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  EmperorClaw is starting!                                    ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
if [ -n "$DOMAIN" ]; then
echo -e "${GREEN}║  Open: https://$DOMAIN                                   ${NC}"
else
echo -e "${GREEN}║  Open: http://localhost:3000                                 ${NC}"
fi
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  Create your admin account on first visit.                   ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  Docs: https://github.com/emperorclaw/emperorclaw            ║${NC}"
echo -e "${GREEN}║  Site: https://emperorclaw.com                               ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "To stop:  ${YELLOW}cd $REPO_DIR && $DOCKER_COMPOSE_CMD down${NC}"
echo -e "To update: ${YELLOW}cd $REPO_DIR && git pull && $DOCKER_COMPOSE_CMD up -d --build${NC}"
echo ""
