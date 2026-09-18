#!/bin/sh
# ─── Multi-Mode Container Entrypoint ──────────────────────────────────────
# Routes to the correct service based on SERVICE_MODE environment variable.
# Used by docker-compose.prod.yml to run bot and dashboard from the same image.

set -e

MODE="${SERVICE_MODE:-bot}"

echo "═══════════════════════════════════════════════════════════════"
echo "  🚀 Solana Quant Bot — Container Start"
echo "  📋 Mode: ${MODE}"
echo "  🕐 Time: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "═══════════════════════════════════════════════════════════════"

case "$MODE" in
  bot)
    echo "  🤖 Starting Coinbase Trading Bot..."
    exec node dist/src/coinbase/bot.js
    ;;
  dashboard)
    echo "  📊 Starting Dashboard Server..."
    exec node dist/src/dashboard/server.js
    ;;
  grid)
    echo "  🕸️ Starting Smart Grid Bot..."
    exec node dist/src/coinbase/smart-grid.js
    ;;
  *)
    echo "  ❌ Unknown SERVICE_MODE: $MODE"
    echo "     Valid modes: bot, dashboard, grid"
    exit 1
    ;;
esac
