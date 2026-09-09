#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Health Monitor — checks all services and auto-recovers
#  Designed to run as a cron job or systemd timer (every 5 min)
# ═══════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"
LOG_FILE="$PROJECT_DIR/data/health.log"
MAX_LOG_LINES=2000

# Timestamp helper
ts() {
  date '+%Y-%m-%d %H:%M:%S'
}

log() {
  echo "[$(ts)] $1" | tee -a "$LOG_FILE"
}

# Rotate log if too large
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt "$MAX_LOG_LINES" ]; then
  tail -n 1000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

# ─── Check each container ────────────────────────────────────────────
HEALTHY=true

check_container() {
  local NAME="$1"
  local STATUS
  STATUS=$(docker inspect --format='{{.State.Status}}' "$NAME" 2>/dev/null || echo "missing")
  
  if [ "$STATUS" = "running" ]; then
    # Check health status if available
    local HEALTH
    HEALTH=$(docker inspect --format='{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo "none")
    if [ "$HEALTH" = "unhealthy" ]; then
      log "⚠️  $NAME is UNHEALTHY — restarting..."
      docker restart "$NAME" 2>/dev/null
      HEALTHY=false
    fi
  elif [ "$STATUS" = "exited" ] || [ "$STATUS" = "dead" ] || [ "$STATUS" = "missing" ]; then
    log "🔴 $NAME is $STATUS — restarting stack..."
    cd "$PROJECT_DIR"
    docker compose -f "$COMPOSE_FILE" up -d "$NAME" 2>/dev/null
    HEALTHY=false
  fi
}

check_container "sqb-trading-bot"
check_container "sqb-dashboard"
check_container "sqb-tunnel"

# ─── HTTP health check on dashboard ──────────────────────────────────
DASH_RESPONSE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/api/health 2>/dev/null || echo "000")
if [ "$DASH_RESPONSE" != "200" ]; then
  log "🔴 Dashboard HTTP health check failed (status: $DASH_RESPONSE) — restarting..."
  docker restart sqb-dashboard 2>/dev/null
  HEALTHY=false
fi

# ─── Check tunnel is generating a URL ────────────────────────────────
TUNNEL_URL_FILE="$PROJECT_DIR/data/tunnel-url.txt"
if [ -f "$TUNNEL_URL_FILE" ]; then
  TUNNEL_AGE=$(( $(date +%s) - $(stat -c %Y "$TUNNEL_URL_FILE" 2>/dev/null || echo 0) ))
  # If the tunnel URL file is older than 30 minutes, the tunnel may have restarted
  # and the URL changed. Update it from the logs.
  if [ "$TUNNEL_AGE" -gt 1800 ]; then
    NEW_URL=$(docker logs sqb-tunnel 2>&1 | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | tail -1)
    if [ -n "$NEW_URL" ]; then
      echo "$NEW_URL" > "$TUNNEL_URL_FILE"
      log "🔄 Updated tunnel URL: $NEW_URL"
    fi
  fi
fi

if [ "$HEALTHY" = true ]; then
  log "✅ All services healthy (dashboard: $DASH_RESPONSE)"
fi
