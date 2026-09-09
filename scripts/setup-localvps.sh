#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Solana Quant Bot — Local VPS Setup Script
#  One-time setup to deploy the trading bot + dashboard stack
# ═══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"
ENV_FILE="$PROJECT_DIR/.env"
DATA_DIR="$PROJECT_DIR/data"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

banner() {
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  🚀 Solana Quant Bot — Local VPS Setup${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
}

step() {
  echo -e "${GREEN}[✓]${NC} $1"
}

warn() {
  echo -e "${YELLOW}[!]${NC} $1"
}

fail() {
  echo -e "${RED}[✗]${NC} $1"
  exit 1
}

banner

# ─── Step 1: Check Docker ──────────────────────────────────────────────
echo -e "${BOLD}Step 1: Checking Docker...${NC}"

if ! command -v docker &>/dev/null; then
  fail "Docker is not installed. Install it first: https://docs.docker.com/engine/install/ubuntu/"
fi

if ! docker ps &>/dev/null; then
  warn "Docker daemon not accessible. Trying to fix permissions..."
  
  # Create docker group if it doesn't exist (snap Docker doesn't always create it)
  if ! getent group docker &>/dev/null; then
    echo "Creating 'docker' group..."
    sudo groupadd docker 2>/dev/null || true
  fi
  
  # Add current user to docker group
  sudo usermod -aG docker "$USER"
  
  # Fix socket permissions
  if [ -S /var/run/docker.sock ]; then
    sudo chown root:docker /var/run/docker.sock
    sudo chmod 660 /var/run/docker.sock
  fi
  
  # Try again with the new group
  if ! sg docker -c "docker ps" &>/dev/null 2>&1; then
    warn "Group change requires a fresh login session."
    echo ""
    echo -e "  ${YELLOW}Please run these commands, then re-run this script:${NC}"
    echo -e "  ${BOLD}  sudo groupadd docker 2>/dev/null${NC}"
    echo -e "  ${BOLD}  sudo usermod -aG docker $USER${NC}"
    echo -e "  ${BOLD}  sudo chown root:docker /var/run/docker.sock${NC}"
    echo -e "  ${BOLD}  newgrp docker${NC}"
    echo ""
    exit 1
  fi
fi

step "Docker is running ($(docker --version | cut -d' ' -f3 | tr -d ','))"

# Check Docker Compose
if ! docker compose version &>/dev/null; then
  fail "Docker Compose is not available. Install it: https://docs.docker.com/compose/install/"
fi
step "Docker Compose available ($(docker compose version --short))"

# ─── Step 2: Ensure .env file exists ───────────────────────────────────
echo ""
echo -e "${BOLD}Step 2: Configuring environment...${NC}"

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$PROJECT_DIR/.env.example" ]; then
    cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
    step "Created .env from .env.example"
  else
    fail ".env.example not found. Cannot create .env file."
  fi
fi

# ─── Step 3: Configure Dashboard Auth ─────────────────────────────────
echo ""
echo -e "${BOLD}Step 3: Dashboard Authentication${NC}"

CURRENT_USER=$(grep -E "^DASHBOARD_USER=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 | tr -d '"' || echo "")
CURRENT_PASS=$(grep -E "^DASHBOARD_PASS=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 | tr -d '"' || echo "")

if [ -z "$CURRENT_USER" ] || [ "$CURRENT_USER" = "admin" ] && [ -z "$CURRENT_PASS" ] || [ "$CURRENT_PASS" = "changeme123" ]; then
  echo ""
  echo -e "  ${YELLOW}Set up credentials for your dashboard (accessed from anywhere):${NC}"
  echo ""
  
  read -rp "  Dashboard username [admin]: " DASH_USER
  DASH_USER="${DASH_USER:-admin}"
  
  read -rsp "  Dashboard password: " DASH_PASS
  echo ""
  
  if [ -z "$DASH_PASS" ]; then
    # Generate a random password
    DASH_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)
    echo -e "  ${YELLOW}Generated random password: ${BOLD}$DASH_PASS${NC}"
    echo -e "  ${YELLOW}Save this password! You'll need it to access the dashboard.${NC}"
  fi
  
  # Update or add DASHBOARD_USER and DASHBOARD_PASS in .env
  if grep -qE "^DASHBOARD_USER=" "$ENV_FILE"; then
    sed -i "s|^DASHBOARD_USER=.*|DASHBOARD_USER=$DASH_USER|" "$ENV_FILE"
  else
    echo "" >> "$ENV_FILE"
    echo "# ─── LOCAL VPS / DASHBOARD AUTH ──────────────────────────" >> "$ENV_FILE"
    echo "DASHBOARD_USER=$DASH_USER" >> "$ENV_FILE"
  fi
  
  if grep -qE "^DASHBOARD_PASS=" "$ENV_FILE"; then
    sed -i "s|^DASHBOARD_PASS=.*|DASHBOARD_PASS=$DASH_PASS|" "$ENV_FILE"
  else
    echo "DASHBOARD_PASS=$DASH_PASS" >> "$ENV_FILE"
  fi
  
  # Ensure DASHBOARD_PORT is set
  if ! grep -qE "^DASHBOARD_PORT=" "$ENV_FILE"; then
    echo "DASHBOARD_PORT=3000" >> "$ENV_FILE"
  fi
  
  step "Dashboard credentials configured (user: $DASH_USER)"
else
  step "Dashboard credentials already configured (user: $CURRENT_USER)"
fi

# ─── Step 4: Create data directory ─────────────────────────────────────
echo ""
echo -e "${BOLD}Step 4: Preparing data directory...${NC}"
mkdir -p "$DATA_DIR"
step "Data directory ready: $DATA_DIR"

# ─── Step 5: Build Docker images ──────────────────────────────────────
echo ""
echo -e "${BOLD}Step 5: Building Docker images...${NC}"
echo "  This may take a few minutes on first run..."
echo ""

cd "$PROJECT_DIR"
docker compose -f "$COMPOSE_FILE" build

step "Docker images built successfully"

# ─── Step 6: Start the stack ──────────────────────────────────────────
echo ""
echo -e "${BOLD}Step 6: Starting services...${NC}"

docker compose -f "$COMPOSE_FILE" up -d

step "All services started"

# ─── Step 7: Wait for services and show status ─────────────────────────
echo ""
echo -e "${BOLD}Step 7: Waiting for services to become healthy...${NC}"

# Wait up to 60 seconds for dashboard to be healthy
WAITED=0
while [ $WAITED -lt 60 ]; do
  HEALTH=$(docker inspect --format='{{.State.Health.Status}}' sqb-dashboard 2>/dev/null || echo "starting")
  if [ "$HEALTH" = "healthy" ]; then
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
  echo -ne "\r  Waiting... ${WAITED}s (dashboard: $HEALTH)    "
done
echo ""

step "Dashboard is healthy"

# ─── Step 8: Get tunnel URL ───────────────────────────────────────────
echo ""
echo -e "${BOLD}Step 8: Getting Cloudflare Tunnel URL...${NC}"

TUNNEL_WAITED=0
TUNNEL_URL=""
while [ $TUNNEL_WAITED -lt 30 ]; do
  if [ -f "$DATA_DIR/tunnel-url.txt" ]; then
    TUNNEL_URL=$(cat "$DATA_DIR/tunnel-url.txt" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$TUNNEL_URL" ]; then
      break
    fi
  fi
  # Also try reading from container logs
  TUNNEL_URL=$(docker logs sqb-tunnel 2>&1 | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | tail -1 || echo "")
  if [ -n "$TUNNEL_URL" ]; then
    echo "$TUNNEL_URL" > "$DATA_DIR/tunnel-url.txt"
    break
  fi
  sleep 2
  TUNNEL_WAITED=$((TUNNEL_WAITED + 2))
  echo -ne "\r  Waiting for tunnel... ${TUNNEL_WAITED}s    "
done
echo ""

# ─── Final Status ─────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}  ✅ LOCAL VPS DEPLOYMENT COMPLETE${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# Show container status
docker compose -f "$COMPOSE_FILE" ps

echo ""
echo -e "  ${BOLD}📊 Local Dashboard:${NC}    http://localhost:3000"
if [ -n "$TUNNEL_URL" ]; then
  echo -e "  ${BOLD}🌍 Remote Dashboard:${NC}   ${GREEN}$TUNNEL_URL${NC}"
  echo -e "  ${BOLD}📱 Access Anywhere:${NC}    Open the URL above on any device"
else
  echo -e "  ${YELLOW}🌐 Tunnel URL:${NC}         Waiting... check 'docker logs sqb-tunnel'"
fi
echo -e "  ${BOLD}🔐 Login:${NC}              user: $(grep -E '^DASHBOARD_USER=' "$ENV_FILE" | cut -d'=' -f2)"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    View logs:     ${CYAN}docker compose -f docker-compose.prod.yml logs -f${NC}"
echo -e "    Bot logs:      ${CYAN}docker logs -f sqb-trading-bot${NC}"
echo -e "    Dashboard:     ${CYAN}docker logs -f sqb-dashboard${NC}"
echo -e "    Tunnel URL:    ${CYAN}docker logs sqb-tunnel 2>&1 | grep trycloudflare${NC}"
echo -e "    Stop all:      ${CYAN}docker compose -f docker-compose.prod.yml down${NC}"
echo -e "    Restart all:   ${CYAN}docker compose -f docker-compose.prod.yml restart${NC}"
echo -e "    Health check:  ${CYAN}curl http://localhost:3000/api/health${NC}"
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
