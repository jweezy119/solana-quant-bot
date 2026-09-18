/**
 * Backtesting Engine
 * ──────────────────
 * Replays collected training data and simulates the signal fusion logic
 * to measure strategy performance before deploying live.
 *
 * Usage: npx ts-node src/ml/backtester.ts --days 7
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CSV_FILE = path.join(DATA_DIR, 'training_data.csv');
const RESULTS_FILE = path.join(DATA_DIR, 'backtest-results.json');

interface DataRow {
  timestamp: number;
  product: string;
  price: number;
  rsi: number;
  ema9: number;
  ema21: number;
  atr: number;
  atrPct: number;
  bbLower: number;
  bbUpper: number;
  trend: string;
  ofi: number;
  arbSpread: number;
  socialScore: number;
  btcPrice: number;
  btcRsi: number;
  action: string;
  confidence: number;
  outcome5m: number;
  outcome15m: number;
  outcome1h: number;
}

interface SimPosition {
  product: string;
  entryPrice: number;
  entryTime: number;
  sizeUsd: number;
  stopPct: number;
  tpPct: number;
}

interface TradeResult {
  product: string;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  pnlUsd: number;
  reason: string;
}

function parseCSV(): DataRow[] {
  if (!fs.existsSync(CSV_FILE)) {
    console.error(`❌ No training data found at ${CSV_FILE}`);
    console.error('   Run the bot for 24-48h to collect enough data.');
    process.exit(1);
  }

  const content = fs.readFileSync(CSV_FILE, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) {
    console.error('❌ Training data file is empty.');
    process.exit(1);
  }

  const rows: DataRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 21) continue;

    const outcome5m = parseFloat(parts[18]) || 0;
    const outcome15m = parseFloat(parts[19]) || 0;
    const outcome1h = parseFloat(parts[20]) || 0;

    // Skip rows without outcomes (not yet back-filled)
    if (!parts[18] && !parts[19] && !parts[20]) continue;

    rows.push({
      timestamp: parseInt(parts[0]),
      product: parts[1],
      price: parseFloat(parts[2]),
      rsi: parseFloat(parts[3]),
      ema9: parseFloat(parts[4]),
      ema21: parseFloat(parts[5]),
      atr: parseFloat(parts[6]),
      atrPct: parseFloat(parts[7]),
      bbLower: parseFloat(parts[8]),
      bbUpper: parseFloat(parts[9]),
      trend: parts[10],
      ofi: parseFloat(parts[11]),
      arbSpread: parseFloat(parts[12]),
      socialScore: parseFloat(parts[13]),
      btcPrice: parseFloat(parts[14]),
      btcRsi: parseFloat(parts[15]),
      action: parts[16],
      confidence: parseFloat(parts[17]),
      outcome5m,
      outcome15m,
      outcome1h,
    });
  }

  return rows;
}

function runBacktest(rows: DataRow[], config: {
  stopPct: number;
  tpPct: number;
  minConfidence: number;
  minRsi: number;
  maxRsi: number;
  positionSizeUsd: number;
}): { trades: TradeResult[]; summary: any } {
  const trades: TradeResult[] = [];
  const openPositions: Record<string, SimPosition> = {};
  let cashUsd = 100;

  for (const row of rows) {
    // Check existing positions against outcomes
    for (const [product, pos] of Object.entries(openPositions)) {
      if (row.product !== product) continue;

      const priceDelta15m = row.outcome15m / 100; // % → fraction
      const simExitPrice = pos.entryPrice * (1 + priceDelta15m);

      // Stop hit?
      if (priceDelta15m <= -config.stopPct) {
        const exitPrice = pos.entryPrice * (1 - config.stopPct);
        const pnlPct = -config.stopPct * 100;
        const pnlUsd = pos.sizeUsd * (-config.stopPct);
        trades.push({ product, entryPrice: pos.entryPrice, exitPrice, pnlPct, pnlUsd, reason: 'STOP' });
        cashUsd += pos.sizeUsd + pnlUsd;
        delete openPositions[product];
        continue;
      }

      // TP hit?
      if (priceDelta15m >= config.tpPct) {
        const exitPrice = pos.entryPrice * (1 + config.tpPct);
        const pnlPct = config.tpPct * 100;
        const pnlUsd = pos.sizeUsd * config.tpPct;
        trades.push({ product, entryPrice: pos.entryPrice, exitPrice, pnlPct, pnlUsd, reason: 'TP' });
        cashUsd += pos.sizeUsd + pnlUsd;
        delete openPositions[product];
        continue;
      }

      // Time-decay exit after 1h
      if (row.timestamp - pos.entryTime > 60 * 60 * 1000) {
        const pnlUsd = pos.sizeUsd * priceDelta15m;
        trades.push({ product, entryPrice: pos.entryPrice, exitPrice: simExitPrice, pnlPct: priceDelta15m * 100, pnlUsd, reason: 'TIME' });
        cashUsd += pos.sizeUsd + pnlUsd;
        delete openPositions[product];
      }
    }

    // New entries
    if (row.action === 'BUY' && row.confidence >= config.minConfidence && !openPositions[row.product]) {
      if (row.rsi < config.minRsi || row.rsi > config.maxRsi) continue;
      if (cashUsd < config.positionSizeUsd) continue;

      const size = Math.min(config.positionSizeUsd, cashUsd * 0.25);
      openPositions[row.product] = {
        product: row.product,
        entryPrice: row.price,
        entryTime: row.timestamp,
        sizeUsd: size,
        stopPct: config.stopPct,
        tpPct: config.tpPct,
      };
      cashUsd -= size;
    }
  }

  // Close remaining positions at last known price
  for (const [product, pos] of Object.entries(openPositions)) {
    const lastRow = rows.filter(r => r.product === product).pop();
    if (lastRow) {
      const pnlPct = ((lastRow.price - pos.entryPrice) / pos.entryPrice) * 100;
      const pnlUsd = pos.sizeUsd * (pnlPct / 100);
      trades.push({ product, entryPrice: pos.entryPrice, exitPrice: lastRow.price, pnlPct, pnlUsd, reason: 'EOD' });
    }
  }

  // Summary stats
  const wins = trades.filter(t => t.pnlUsd > 0);
  const losses = trades.filter(t => t.pnlUsd <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlUsd, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlUsd, 0) / losses.length : 0;
  const profitFactor = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? Infinity : 0;

  // Max drawdown
  let peak = 100;
  let maxDrawdown = 0;
  let equity = 100;
  for (const t of trades) {
    equity += t.pnlUsd;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe ratio (simplified — annualized from per-trade returns)
  const returns = trades.map(t => t.pnlPct / 100);
  const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  const summary = {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: parseFloat(winRate.toFixed(1)),
    totalPnlUsd: parseFloat(totalPnl.toFixed(2)),
    avgWinUsd: parseFloat(avgWin.toFixed(2)),
    avgLossUsd: parseFloat(avgLoss.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    maxDrawdownPct: parseFloat((maxDrawdown * 100).toFixed(1)),
    sharpeRatio: parseFloat(sharpe.toFixed(2)),
    finalEquity: parseFloat((100 + totalPnl).toFixed(2)),
    config,
  };

  return { trades, summary };
}

// ─── MAIN ──────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) || 7 : 7;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  📊 QUANT BACKTESTING ENGINE');
  console.log(`  📅 Lookback: ${days} days`);
  console.log('═══════════════════════════════════════════════════════════\n');

  let rows = parseCSV();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  rows = rows.filter(r => r.timestamp >= cutoff);

  console.log(`📈 Loaded ${rows.length} data points with outcomes\n`);

  if (rows.length < 20) {
    console.error('❌ Not enough data points to run a meaningful backtest.');
    console.error('   Need at least 20 rows with filled outcomes. Keep the bot running!');
    process.exit(1);
  }

  // Run with current config
  const currentConfig = {
    stopPct: 0.035,
    tpPct: 0.055,
    minConfidence: 0.65,
    minRsi: 0,
    maxRsi: 65,
    positionSizeUsd: 10,
  };

  // Run parameter sweep
  const configs = [
    { ...currentConfig, label: 'Current Settings' },
    { ...currentConfig, stopPct: 0.025, tpPct: 0.04, label: 'Tighter (2.5% SL / 4% TP)' },
    { ...currentConfig, stopPct: 0.05, tpPct: 0.08, label: 'Wider (5% SL / 8% TP)' },
    { ...currentConfig, minConfidence: 0.70, label: 'Higher Confidence (70%)' },
    { ...currentConfig, minConfidence: 0.80, label: 'Ultra-High Confidence (80%)' },
    { ...currentConfig, maxRsi: 55, label: 'RSI < 55 Filter' },
  ];

  const results: any[] = [];
  for (const cfg of configs) {
    const { label, ...config } = cfg;
    const { summary } = runBacktest(rows, config);
    results.push({ label, ...summary });

    console.log(`─── ${label} ───────────────────────────────`);
    console.log(`  Trades: ${summary.totalTrades} │ Win Rate: ${summary.winRatePct}% │ PnL: $${summary.totalPnlUsd}`);
    console.log(`  Avg Win: $${summary.avgWinUsd} │ Avg Loss: $${summary.avgLossUsd} │ PF: ${summary.profitFactor}`);
    console.log(`  Max DD: ${summary.maxDrawdownPct}% │ Sharpe: ${summary.sharpeRatio} │ Final: $${summary.finalEquity}\n`);
  }

  // Save results
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\n✅ Results saved to ${RESULTS_FILE}`);
}

main();
