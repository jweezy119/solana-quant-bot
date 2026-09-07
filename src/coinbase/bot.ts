/**
 * Coinbase Autonomous Quant Compounding & Arbitrage Bot
 * ───────────────────────────────────────────────────────
 * Multi-pair continuous scanning loop integrating:
 * 1. Technical Analysis (RSI, EMA 9/21, ATR Volatility, Bollinger)
 * 2. Cross-Exchange Lead-Lag Arbitrage (Coinbase vs Kraken Order Books)
 * 3. Social Media & Twitter Sentiment (X API v2 + Live News Syndicate)
 * 4. Geometric Quant Compounding (Fractional Kelly Criterion for $100+ bankroll)
 * 5. Total Profit Indicator (Realized, Unrealized, Net ROI %, Win Rate)
 * 6. Audio Alerts on all transactions (Buy ding, Take-Profit win chime, Stop alert)
 * 7. Automated Stop-Loss (2.5%), Take-Profit (5.0%), & Trailing Breakeven Stop
 * 8. Paper Trading / Simulation vs Live Execution
 */

import 'dotenv/config';
import { fuseSignals } from './signal-fusion';
import {
  executeAIProposal,
  checkStopsAndTargets,
  loadPositions,
  isSimulationMode,
  QUANT_CONFIG,
  getPerformanceMetrics,
} from './risk-manager';
import { getAccountBalance } from './client';
import { pollAlphaRadar, getAlphaRadarState } from '../radar/alpha-radar';
import { checkCoinbaseNewListings, evaluateListingMomentum } from '../radar/coinbase-listing';

// ─── CONFIGURATION ───────────────────────────────────────────

const DEFAULT_PRODUCTS = ['BONK-USDC', 'SHIB-USDC', 'DOGE-USDC', 'PEPE-USDC', 'AERO-USDC', 'FARTCOIN-USDC', 'TURBO-USDC'];
const PRODUCTS: string[] = process.env.COINBASE_PRODUCTS
  ? process.env.COINBASE_PRODUCTS.split(',').map((p) => p.trim())
  : DEFAULT_PRODUCTS;

const POLL_INTERVAL_MS = parseInt(process.env.COINBASE_POLL_INTERVAL_MS || '12000', 10);
const SIMULATION_MODE = isSimulationMode();
const DEFAULT_SIM_CAPITAL = parseFloat(process.env.STARTING_CAPITAL || '100.53');

let isRunning = true;
let scanCount = 0;

// Graceful exit handlers
process.on('SIGINT', () => {
  console.log('\n\n🛑 Received SIGINT. Shutting down Coinbase Quant Bot cleanly...');
  isRunning = false;
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Received SIGTERM. Shutting down Coinbase Quant Bot cleanly...');
  isRunning = false;
  process.exit(0);
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCurrency(val: number): string {
  if (val >= 1000) {
    return `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else if (val >= 1) {
    return `$${val.toFixed(2)}`;
  } else if (val >= 0.01) {
    return `$${val.toFixed(4)}`;
  } else {
    return `$${val.toFixed(8)}`;
  }
}

function formatScore(score: number): string {
  if (score > 0) return `+${score.toFixed(2)}`;
  if (score < 0) return `${score.toFixed(2)}`;
  return ` 0.00`;
}

function formatArb(spreadPct: number, dir: string): string {
  const sign = spreadPct >= 0 ? '+' : '';
  const text = `${sign}${spreadPct.toFixed(2)}%`;
  if (dir === 'BUY_DISCOUNT') return `Arb:${text} [BUY]`;
  if (dir === 'SELL_PREMIUM') return `Arb:${text} [SELL]`;
  return `Arb:${text}`;
}

async function getAvailableCash(): Promise<number> {
  try {
    const usd = await getAccountBalance('USD');
    const usdc = await getAccountBalance('USDC');
    const total = usd + usdc;
    if (total > 0) return total;
    return DEFAULT_SIM_CAPITAL;
  } catch {
    return DEFAULT_SIM_CAPITAL;
  }
}

async function resolveProducts(configured: string[]): Promise<string[]> {
  try {
    const usd = await getAccountBalance('USD');
    const usdc = await getAccountBalance('USDC');
    if (usd <= 0.10 && usdc > 1.00) {
      return configured.map((p) => (p.endsWith('-USD') ? p.replace('-USD', '-USDC') : p));
    }
  } catch {}
  return configured;
}

import { connectWebsocket, getLiveMetrics } from './websocket';

// ─── MAIN BOT SCAN LOOP ──────────────────────────────────────

async function startCoinbaseBot() {
  const activeProducts = await resolveProducts(PRODUCTS);
  
  connectWebsocket(activeProducts); // Start the live stream

  console.clear();
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  🤖  COINBASE ADVANCED QUANT COMPOUNDING & ARBITRAGE BOT — GOD MODE');
  console.log('  🛡️  Regime: 🔴 BEAR SNIPER MODE (Capitulation Harvesting & Cash Defense)');
  console.log('  💰  Fee-Zero Maker Family Only: books that pay fees are banned; new books trade dust until proven');
  console.log('  🔬  Dust-Verify Loop: no Kelly edge ⇒ $5 dust re-proves the family instead of freezing');
  console.log(`  🚀  Runner Mode: zero-fee family winners trail the peak instead of sniping micro-premiums`);
  console.log(`  💸  Fee Leak Kill-Switch: all BUYs halt at $${process.env.COINBASE_MAX_FEES_PER_DAY_USD || '0.50'}/day in fees`);
  console.log(`  📐  Kelly Compounding: Half-Kelly │ Max Pos: ${(QUANT_CONFIG.maxPositionPct * 100)}% (~$${(DEFAULT_SIM_CAPITAL * QUANT_CONFIG.maxPositionPct).toFixed(2)}) │ Cash Buffer: $${QUANT_CONFIG.minCashReserveUsd.toFixed(2)} min`);
  console.log(`  🎯  Sniper Targets: +${(QUANT_CONFIG.takeProfitPct * 100).toFixed(1)}% Fast TP │ -${(QUANT_CONFIG.stopLossPct * 100).toFixed(1)}% Cut SL │ +${(QUANT_CONFIG.trailingLockPct * 100).toFixed(1)}% Net Lock`);
  console.log(`  ⚡  Execution: 🛡️ LIMIT MAKER ONLY (post_only: true) │ 0.6% Maker Fee (Zero Taker Churn)`);
  console.log(`  🐦  Social & War NLP: Active Twitter/News Feed (Liquidation Cascade Freeze enabled)`);
  console.log(`  🔊  Audio Alerts: Active (Buy Ding, Take-Profit Win Chime, Stop Loss Warning)`);
  console.log(`  💼  Mode: ${SIMULATION_MODE ? '🟡 SIMULATION (Paper Trading)' : '🔴 LIVE TRADING (Real Capital)'}`);
  console.log(`  🎯  Active Watchlist: [${activeProducts.join(', ')}]`);
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  const initialCash = await getAvailableCash();
  console.log(`\n💰 Bankroll Active: $${initialCash.toFixed(2)} USD/USDC (Baseline: $${DEFAULT_SIM_CAPITAL.toFixed(2)})`);

  // ── High-Frequency WebSocket Stop/Target Execution Loop ──
  // This runs entirely decoupled from the slow REST API scan loop to ensure sub-second stop/target execution
  setInterval(async () => {
    if (!isRunning) return;
    try {
      const livePrices: Record<string, number> = {};
      let hasData = false;
      for (const productId of activeProducts) {
        const metrics = getLiveMetrics(productId);
        if (metrics && metrics.price > 0) {
          livePrices[productId] = metrics.price;
          hasData = true;
        }
      }
      if (hasData) {
        // Pass 0 for cash/equity as sell executions don't mathematically require them
        await checkStopsAndTargets(livePrices, 0, 0); 
      }
    } catch (e) {}
  }, 1000); // 1-second ultra-fast local evaluation

  while (isRunning) {
    scanCount++;
    const timestamp = new Date().toISOString();

    const availableCash = await getAvailableCash();
    const currentPrices: Record<string, number> = {};
    const positions = loadPositions();
    const metrics = getPerformanceMetrics();

    // 1. Scan and compute current market prices for all products
    const scanResults: Record<string, any> = {};
    for (const productId of activeProducts) {
      try {
        const result = await fuseSignals(productId);
        scanResults[productId] = result;
        currentPrices[productId] = result.technical.currentPrice;
      } catch (err: any) {
        console.error(`  ⚠️ Error scanning ${productId}:`, err.message);
      }
    }

    // 2. Calculate Total Portfolio Equity, Realized, and Unrealized PnL
    let openPositionsValue = 0;
    let unrealizedPnlUsd = 0;

    for (const pos of Object.values(positions)) {
      const price = currentPrices[pos.productId] || pos.entryPrice;
      openPositionsValue += price * pos.quantity;
      unrealizedPnlUsd += (price - pos.entryPrice) * pos.quantity;
    }

    const totalPortfolioEquity = availableCash + openPositionsValue;
    const totalNetProfitUsd = metrics.totalRealizedPnl + unrealizedPnlUsd;
    const totalNetProfitPct = DEFAULT_SIM_CAPITAL > 0 ? (totalNetProfitUsd / DEFAULT_SIM_CAPITAL) * 100 : 0;

    // 3. Detect New Listings & Inject into Dynamic Listing Momentum Queue
    if (scanCount % 2 === 1) {
      try {
        const listingAlerts = await checkCoinbaseNewListings();
        for (const alert of listingAlerts) {
          const targetId = alert.quoteCurrency === 'USDC' ? alert.productId : `${alert.baseCurrency}-USDC`;
          if (!activeProducts.includes(targetId)) {
            console.log(`\n🌟 [DYNAMIC LISTING ROTATOR]: New asset ${targetId} detected on Coinbase!`);
            const evalRes = await evaluateListingMomentum(targetId);
            if (evalRes.safe) {
              console.log(`   ✅ Order book liquid (Spread: ${evalRes.spreadPct.toFixed(2)}%). Injecting into priority sniper queue!`);
              activeProducts.unshift(targetId); // Prioritize at front of queue

              if (availableCash - QUANT_CONFIG.minTradeUsd >= QUANT_CONFIG.minCashReserveUsd) {
                const listingProposal = {
                  productId: targetId,
                  action: 'BUY' as const,
                  confidence: 0.88,
                  reasoning: `🚀 Listing Catalyst: Newly listed asset ${targetId} on Coinbase with 25m decay window`,
                  strategy: 'LISTING_MOMENTUM' as const,
                  maxHoldDurationMs: 25 * 60 * 1000,
                };
                await executeAIProposal(listingProposal, availableCash, evalRes.bestBid, totalPortfolioEquity);
              }
            } else {
              console.log(`   ⚠️ Holding back listing entry: ${evalRes.reason}`);
            }
          }
        }
      } catch (err: any) {
        console.error('  ⚠️ Listing scanner error:', err.message);
      }
    }

    const pSign = totalNetProfitUsd >= 0 ? '+' : '';
    const rSign = metrics.totalRealizedPnl >= 0 ? '+' : '';
    const uSign = unrealizedPnlUsd >= 0 ? '+' : '';

    // ─── DASHBOARD PROFIT HEADER ────────────────────────────
    console.log(`\n─── Scan #${scanCount}  [${timestamp}] ─────────────────────────────────────────────────────────────`);
    console.log(`  💼 Active Equity: $${totalPortfolioEquity.toFixed(2)} │ Cash: $${availableCash.toFixed(2)} │ Open: ${Object.keys(positions).length}/${QUANT_CONFIG.maxConcurrentPositions}`);
    console.log(`  📈 NET PROFIT: ${pSign}$${totalNetProfitUsd.toFixed(2)} (${pSign}${totalNetProfitPct.toFixed(2)}%) │ Realized Net: ${rSign}$${metrics.totalRealizedPnl.toFixed(2)} │ Unrealized: ${uSign}$${unrealizedPnlUsd.toFixed(2)}`);
    if (metrics.totalFeesPaid > 0) {
      console.log(`  💸 Fee Audit: Gross PnL: $${metrics.totalGrossPnl.toFixed(2)} │ Fees Paid: -$${metrics.totalFeesPaid.toFixed(2)} │ Net: $${metrics.totalRealizedPnl.toFixed(2)}`);
    }
    console.log(`  🏆 Performance: ${metrics.totalTrades} Closed Trades │ Win Rate: ${metrics.winRatePct.toFixed(1)}% (${metrics.wins}W / ${metrics.losses}L / ${metrics.breakevens}BE)`);
    const radar = getAlphaRadarState();
    console.log(`  📡 RADAR PULSE: ${radar.summary}`);
    console.log(`  ─────────────────────────────────────────────────────────────────────────────`);

    // 4. Process Product Signals and Execute Actions
    for (const productId of activeProducts) {
      try {
        const result = scanResults[productId];
        if (!result) continue; // Skip if scan failed earlier
        
        const { proposal, technical, social, arbitrage } = result;

        const padProd = productId.padEnd(9);
        const padPrice = formatCurrency(technical.currentPrice).padEnd(13);
        const padRsi = `RSI:${technical.rsi.toFixed(0)}`.padEnd(7);
        const padTrend = `[${technical.trend.toLowerCase()}]`.padEnd(11);
        const padArb = formatArb(arbitrage.spreadPct, arbitrage.direction).padEnd(16);
        
        const liveMetrics = getLiveMetrics(productId);
        const ofi = liveMetrics ? liveMetrics.imbalance : 0;
        const ofiStr = ofi > 0.15 ? `🌊 OFI:+${(ofi*100).toFixed(0)}%` : ofi < -0.15 ? `🚨 OFI:${(ofi*100).toFixed(0)}%` : `⚖️ OFI:${(ofi*100).toFixed(0)}%`;
        const padOfi = ofiStr.padEnd(12);

        const padAction = proposal.action === 'BUY'
          ? `🟢 BUY (${(proposal.confidence * 100).toFixed(0)}%)`
          : proposal.action === 'SELL'
          ? `🔴 SELL (${(proposal.confidence * 100).toFixed(0)}%)`
          : `⚪ HOLD`;

        console.log(`  ${padProd} ${padPrice} ${padRsi} ${padTrend} │ ${padArb} │ ${padOfi} │ ${padAction}`);

        if (social.sampleHeadlines.length > 0 && scanCount % 4 === 1) {
          console.log(`    ↳ ${social.sampleHeadlines[0]}`);
        }

        if (proposal.action !== 'HOLD') {
          await executeAIProposal(proposal, availableCash, technical.currentPrice, totalPortfolioEquity);
        }
      } catch (err: any) {
        console.error(`  ⚠️ Error processing ${productId}:`, err.message);
      }
    }

    // 5. Check Stop-Loss, Take-Profit, Trailing Breakeven, and Time-Decay on held positions
    // 5. (Moved to High-Frequency WebSocket Loop)

    // 6. Active Positions Display
    const updatedPositions = loadPositions();
    const openCount = Object.keys(updatedPositions).length;
    if (openCount > 0) {
      console.log(`\n  📂 Active Positions (${openCount}/${QUANT_CONFIG.maxConcurrentPositions}):`);
      for (const [id, pos] of Object.entries(updatedPositions)) {
        const live = currentPrices[id] || pos.entryPrice;
        const pnlUsd = (live - pos.entryPrice) * pos.quantity;
        const pnlPct = ((live - pos.entryPrice) / pos.entryPrice) * 100;
        const color = pnlUsd >= 0 ? '+' : '';
        const holdTag = pos.strategy === 'LISTING_MOMENTUM' && pos.maxHoldDurationMs
          ? ` │ ⏳ Hold: ${Math.max(0, Math.round((pos.maxHoldDurationMs - (Date.now() - pos.entryTime)) / 60000))}m left`
          : '';
        console.log(
          `     • ${id}${pos.strategy === 'LISTING_MOMENTUM' ? ' [LISTING]' : ''}: ${pos.quantity >= 10 ? pos.quantity.toFixed(0) : pos.quantity >= 1 ? pos.quantity.toFixed(2) : pos.quantity.toFixed(6)} @ ${formatCurrency(pos.entryPrice)} → ${formatCurrency(live)} │ PnL: ${color}$${pnlUsd.toFixed(2)} (${color}${pnlPct.toFixed(2)}%) │ Stop: ${formatCurrency(pos.stopLossPrice)} │ Target: ${formatCurrency(pos.takeProfitPrice)}${holdTag}`
        );
      }
    }

    console.log(`\n  ⏳ Next scan in ${POLL_INTERVAL_MS / 1000}s...`);
    await sleep(POLL_INTERVAL_MS);
  }
}

if (require.main === module) {
  startCoinbaseBot().catch((err) => {
    console.error('Fatal Coinbase Bot Error:', err);
    process.exit(1);
  });
}
