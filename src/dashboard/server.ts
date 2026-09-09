/**
 * High-Performance Cyber-Quant Dashboard Server
 * ──────────────────────────────────────────────
 * Zero external web framework dependencies (pure Node.js http + SSE).
 * Streams real-time portfolio telemetry, CEX/DEX active positions,
 * multi-venue arbitrage consensus, and meme radars to the browser.
 */

import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConsolidatedState } from './state';

const PORT = parseInt(process.env.DASHBOARD_PORT || process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
// Fallback to source tree when running compiled (dist/ has no static assets copied)
const SOURCE_PUBLIC_DIR = path.join(process.cwd(), 'src', 'dashboard', 'public');
const INDEX_HTML_PATH = path.join(fs.existsSync(path.join(PUBLIC_DIR, 'index.html')) ? PUBLIC_DIR : SOURCE_PUBLIC_DIR, 'index.html');
const WIDGET_HTML_PATH = path.join(fs.existsSync(path.join(PUBLIC_DIR, 'widget.html')) ? PUBLIC_DIR : SOURCE_PUBLIC_DIR, 'widget.html');

// ─── BASIC AUTH CONFIGURATION ──────────────────────────────────────────────
const AUTH_USER = process.env.DASHBOARD_USER || '';
const AUTH_PASS = process.env.DASHBOARD_PASS || '';
const AUTH_ENABLED = AUTH_USER.length > 0 && AUTH_PASS.length > 0;
const TUNNEL_URL_FILE = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'tunnel-url.txt');

const AUTH_REALM = 'Quant Command Center';

/**
 * Validate HTTP Basic Auth credentials using timing-safe comparison.
 * Returns true if auth is disabled (no credentials configured) or valid.
 */
function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!AUTH_ENABLED) return true;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.writeHead(401, {
      'WWW-Authenticate': `Basic realm="${AUTH_REALM}"`,
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(`<!DOCTYPE html><html><head><title>401 — Authentication Required</title>
<style>body{background:#0a0a0f;color:#00ff88;font-family:'Courier New',monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;border:1px solid #00ff8844;padding:3rem;border-radius:12px;background:#0a0a0f99}
h1{font-size:2.5rem;margin:0 0 1rem}p{color:#888;font-size:1.1rem}</style></head>
<body><div class="box"><h1>🔐 ACCESS DENIED</h1><p>Quant Command Center requires authentication.</p></div></body></html>`);
    return false;
  }

  try {
    const encoded = authHeader.slice(6);
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) throw new Error('Invalid format');

    const providedUser = decoded.slice(0, colonIndex);
    const providedPass = decoded.slice(colonIndex + 1);

    // Timing-safe comparison to prevent timing attacks
    const userMatch = providedUser.length === AUTH_USER.length &&
      crypto.timingSafeEqual(Buffer.from(providedUser), Buffer.from(AUTH_USER));
    const passMatch = providedPass.length === AUTH_PASS.length &&
      crypto.timingSafeEqual(Buffer.from(providedPass), Buffer.from(AUTH_PASS));

    if (userMatch && passMatch) return true;
  } catch {}

  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${AUTH_REALM}"`,
    'Content-Type': 'text/plain',
  });
  res.end('Invalid credentials');
  return false;
}

// Keep track of connected SSE clients
const sseClients: Set<http.ServerResponse> = new Set();

let lastKnownState: any = null;

async function refreshStateAndBroadcast() {
  try {
    const state = await getConsolidatedState();
    lastKnownState = state;
    const payload = `data: ${JSON.stringify(state)}\n\n`;

    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  } catch (err: any) {
    console.error('⚠️ Dashboard state broadcast error:', err.message);
  }
}

// Background poll loop pushing SSE updates every 2500ms
setInterval(refreshStateAndBroadcast, 2500);

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  // 0. Health check is EXEMPT from auth (Docker healthcheck needs it)
  if (url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), sseConnections: sseClients.size, authEnabled: AUTH_ENABLED }));
    return;
  }

  // 0b. Auth gate — every other route requires valid credentials
  if (!checkAuth(req, res)) return;

  // 1. Single-Page Application (HTML)
  if (url === '/' || url === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (fs.existsSync(INDEX_HTML_PATH)) {
      const html = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');
      res.writeHead(200);
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('<h1>Dashboard UI not found</h1>');
    }
    return;
  }

  // 1b. Widget Page (Compact Always-On View)
  if (url === '/widget') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (fs.existsSync(WIDGET_HTML_PATH)) {
      const html = fs.readFileSync(WIDGET_HTML_PATH, 'utf-8');
      res.writeHead(200);
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('<h1>Widget not found</h1>');
    }
    return;
  }

  // 2. REST API State Snapshot
  if (url === '/api/state') {
    try {
      const state = lastKnownState || (await getConsolidatedState());
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200);
      res.end(JSON.stringify(state));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2b. Force Telemetry Refresh
  if (url === '/api/refresh') {
    try {
      await refreshStateAndBroadcast();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'refreshed', timestamp: Date.now() }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 3. Server-Sent Events (SSE) Live Stream
  if (url === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');

    sseClients.add(res);

    // Send immediate snapshot
    if (lastKnownState) {
      res.write(`data: ${JSON.stringify(lastKnownState)}\n\n`);
    } else {
      getConsolidatedState().then((s) => {
        lastKnownState = s;
        res.write(`data: ${JSON.stringify(s)}\n\n`);
      }).catch(() => {});
    }

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 4. Tunnel URL (read from shared volume written by cloudflared)
  if (url === '/api/tunnel-url') {
    try {
      if (fs.existsSync(TUNNEL_URL_FILE)) {
        const tunnelUrl = fs.readFileSync(TUNNEL_URL_FILE, 'utf-8').trim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: tunnelUrl }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: null, message: 'Tunnel not active — access locally at http://localhost:3000' }));
      }
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: null }));
    }
    return;
  }

  // 5. Widget Compact State (strips heavy arrays for low-bandwidth widget)
  if (url === '/api/widget-state') {
    try {
      const state = lastKnownState || (await getConsolidatedState());
      const compact = {
        timestamp: state.timestamp,
        portfolio: state.portfolio,
        metrics: { winRatePct: state.metrics.winRatePct, wins: state.metrics.wins, losses: state.metrics.losses, realizedNetPnlUsd: state.metrics.realizedNetPnlUsd, profitFactor: state.metrics.profitFactor, regime: state.metrics.regime },
        protection: {
          stanceLabel: state.protection.stanceLabel,
          standDown: state.protection.riskStance.standDown,
          kellyRaw: state.protection.riskStance.kellyRaw,
          blockedToday: state.protection.riskStance.blockedToday,
          feesToday: state.protection.riskStance.feesToday,
          maxFeesPerDay: state.protection.riskStance.maxFeesPerDay,
          zeroFeeFamily: state.protection.riskStance.zeroFeeFamily,
          bannedProducts: state.protection.riskStance.bannedProducts,
          recentRejections: (state.protection.recentRejections || []).slice(0, 1),
        },
        positions: state.positions,
        gamification: { level: state.gamification.level, rankTitle: state.gamification.rankTitle, streak: state.gamification.streak },
        aiIntelligence: { regimeName: state.aiIntelligence.regimeName, vpinStatus: state.aiIntelligence.vpinStatus },
        recentTrades: (state.recentTrades || []).slice(0, 5),
      };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200);
      res.end(JSON.stringify(compact));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

function startServer(port: number) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`\n═══════════════════════════════════════════════════════════════════`);
    console.log(`  📊 QUANT COMMAND CENTER DASHBOARD LIVE`);
    console.log(`  🌐 Local URL: http://localhost:${port}`);
    console.log(`  📌 Widget: http://localhost:${port}/widget`);
    console.log(`  ⚡ SSE Telemetry: http://localhost:${port}/api/stream`);
    console.log(`  🔐 Auth: ${AUTH_ENABLED ? `ENABLED (user: ${AUTH_USER})` : 'DISABLED — set DASHBOARD_USER & DASHBOARD_PASS to enable'}`);
    // Show tunnel URL if available
    try {
      if (fs.existsSync(TUNNEL_URL_FILE)) {
        const tunnelUrl = fs.readFileSync(TUNNEL_URL_FILE, 'utf-8').trim();
        if (tunnelUrl) {
          console.log(`  🌍 Remote URL: ${tunnelUrl}`);
          console.log(`  📱 Access from ANY device at the URL above`);
        }
      }
    } catch {}
    console.log(`  💼 Dual-Venue Sync: Coinbase CEX Maker + Solana DEX Sniper`);
    console.log(`═══════════════════════════════════════════════════════════════════\n`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ Port ${port} in use, retrying on port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Dashboard Server Error:', err);
    }
  });
}

if (require.main === module) {
  startServer(PORT);
}

export { server, startServer };
