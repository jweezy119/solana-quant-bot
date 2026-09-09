#!/bin/sh
# ─── Cloudflare Quick Tunnel Entrypoint ───────────────────────────────────
# Starts a free Cloudflare Tunnel (no account/domain needed) that proxies
# traffic to the dashboard container. Captures the generated public URL
# and writes it to a shared volume so the dashboard can display it.

set -e

TUNNEL_URL_FILE="/app/data/tunnel-url.txt"
DASHBOARD_URL="http://dashboard:3000"

echo "═══════════════════════════════════════════════════════════════"
echo "  🌐 Cloudflare Quick Tunnel Starting..."
echo "  🔗 Proxying to: ${DASHBOARD_URL}"
echo "═══════════════════════════════════════════════════════════════"

# Start cloudflared and capture the URL from stderr
# cloudflared prints the tunnel URL to stderr in the format:
# "... | https://xxxxx.trycloudflare.com"
cloudflared tunnel --url "${DASHBOARD_URL}" --no-autoupdate 2>&1 | while IFS= read -r line; do
  echo "$line"
  # Capture the tunnel URL when it appears
  case "$line" in
    *trycloudflare.com*)
      URL=$(echo "$line" | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | head -1)
      if [ -n "$URL" ]; then
        echo "$URL" > "${TUNNEL_URL_FILE}"
        echo ""
        echo "═══════════════════════════════════════════════════════════════"
        echo "  ✅ TUNNEL LIVE!"
        echo "  🌍 Public URL: ${URL}"
        echo "  📱 Access your dashboard from ANY device at this URL"
        echo "═══════════════════════════════════════════════════════════════"
        echo ""
      fi
      ;;
  esac
done
