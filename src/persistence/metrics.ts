/**
 * Performance Metrics
 * ───────────────────
 * Real-time computation of Sharpe, Sortino, drawdown, win rate, etc.
 */

import { MetricsSnapshot, JournalEntry } from '../core/types';

/**
 * Compute metrics from trade journal entries.
 */
export function computeMetrics(
  entries: JournalEntry[],
  period: MetricsSnapshot['period'] = 'all',
): MetricsSnapshot {
  const closed = entries.filter(e => e.exitPrice !== undefined);

  if (closed.length === 0) {
    return emptyMetrics(period);
  }

  const pnls = closed.map(e => e.pnl);
  const pnlPcts = closed.map(e => e.pnlPct);
  const wins = closed.filter(e => e.pnl > 0);
  const losses = closed.filter(e => e.pnl < 0);

  const totalPnl = pnls.reduce((s, v) => s + v, 0);
  const avgReturn = pnlPcts.reduce((s, v) => s + v, 0) / pnlPcts.length;

  // Standard deviation of returns
  const variance = pnlPcts.reduce((s, v) => s + (v - avgReturn) ** 2, 0) / pnlPcts.length;
  const stdDev = Math.sqrt(variance);

  // Downside deviation (for Sortino)
  const negReturns = pnlPcts.filter(r => r < 0);
  const downsideVariance = negReturns.length > 0
    ? negReturns.reduce((s, v) => s + v ** 2, 0) / negReturns.length
    : 0;
  const downsideDev = Math.sqrt(downsideVariance);

  // Sharpe ratio (annualized, assuming ~10 trades/day × 365 days)
  const annualFactor = Math.sqrt(10 * 365);
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * annualFactor : 0;

  // Sortino ratio
  const sortinoRatio = downsideDev > 0 ? (avgReturn / downsideDev) * annualFactor : 0;

  // Max drawdown from equity curve
  let peak = 0;
  let maxDD = 0;
  let cumPnl = 0;
  for (const pnl of pnls) {
    cumPnl += pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak > 0 ? ((peak - cumPnl) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Current drawdown
  const currentDD = peak > 0 ? ((peak - cumPnl) / peak) * 100 : 0;

  const avgWin = wins.length > 0 ? wins.reduce((s, e) => s + e.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, e) => s + e.pnl, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0
    ? (wins.reduce((s, e) => s + e.pnl, 0)) / Math.abs(losses.reduce((s, e) => s + e.pnl, 0))
    : wins.length > 0 ? Infinity : 0;

  return {
    sharpeRatio,
    sortinoRatio,
    maxDrawdownPct: maxDD,
    currentDrawdownPct: currentDD,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    profitFactor,
    avgWin,
    avgLoss,
    expectancyPerTrade: totalPnl / closed.length,
    totalTrades: closed.length,
    totalPnl,
    period,
  };
}

function emptyMetrics(period: MetricsSnapshot['period']): MetricsSnapshot {
  return {
    sharpeRatio: 0, sortinoRatio: 0,
    maxDrawdownPct: 0, currentDrawdownPct: 0,
    winRate: 0, profitFactor: 0,
    avgWin: 0, avgLoss: 0,
    expectancyPerTrade: 0, totalTrades: 0,
    totalPnl: 0, period,
  };
}

/**
 * Format metrics for display.
 */
export function formatMetrics(m: MetricsSnapshot): string {
  return [
    `📊 Performance [${m.period}]`,
    `   Trades: ${m.totalTrades} | Win Rate: ${(m.winRate * 100).toFixed(1)}%`,
    `   PnL: $${m.totalPnl.toFixed(4)} | Expectancy: $${m.expectancyPerTrade.toFixed(4)}/trade`,
    `   Avg Win: $${m.avgWin.toFixed(4)} | Avg Loss: $${m.avgLoss.toFixed(4)}`,
    `   Profit Factor: ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}`,
    `   Sharpe: ${m.sharpeRatio.toFixed(2)} | Sortino: ${m.sortinoRatio.toFixed(2)}`,
    `   Max DD: ${m.maxDrawdownPct.toFixed(1)}% | Current DD: ${m.currentDrawdownPct.toFixed(1)}%`,
  ].join('\n');
}
