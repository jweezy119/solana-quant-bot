/**
 * Portfolio Risk Manager
 * ──────────────────────
 * Circuit breakers, drawdown limits, and exposure management.
 * Protects the $20 bankroll from ruin.
 */

import { PortfolioState, Position, RiskLimits, MarketRegime, PriceHistory } from '../core/types';
import { RISK, STARTING_CAPITAL_USDC, EXITS } from '../core/config';
import { dataBus } from '../data/data-bus';

// ============================================================
//  STATE
// ============================================================
import fs from 'fs';
import { DATA_DIR } from '../core/config';

let portfolioState: PortfolioState = {
  totalValue: STARTING_CAPITAL_USDC,
  cashAvailable: STARTING_CAPITAL_USDC,
  positionsCount: 0,
  totalExposurePct: 0,
  unrealizedPnl: 0,
  realizedPnl: 0,
  dailyPnl: 0,
  weeklyPnl: 0,
  drawdownPct: 0,
  peakValue: STARTING_CAPITAL_USDC,
};

const PORTFOLIO_FILE = `${DATA_DIR}/portfolio-state.json`;

export function loadPortfolioState(): void {
  try {
    if (fs.existsSync(PORTFOLIO_FILE)) {
      const data = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf-8'));
      portfolioState = { ...portfolioState, ...data };
      if (data.maxTradeUsdc) RISK.maxTradeUsdc = data.maxTradeUsdc;
      console.log(`💼  Loaded portfolio state. Peak: $${portfolioState.peakValue.toFixed(2)}`);
    }
  } catch { /* ignore */ }
}

export function savePortfolioState(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const dataToSave = { ...portfolioState, maxTradeUsdc: RISK.maxTradeUsdc };
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(dataToSave, null, 2));
  } catch { /* ignore */ }
}

let consecutiveLosses = 0;
let pausedUntil = 0;
let lossSizeReduction = 1.0; // 1.0 = normal, 0.5 = halved after consecutive losses
let dailyPnlResetTime = Date.now();
let weeklyPnlResetTime = Date.now();

// ============================================================
//  PORTFOLIO UPDATE
// ============================================================
export function updatePortfolio(
  positions: Record<string, Position>,
  currentPrices: Record<string, number>,
): PortfolioState {
  let totalInvested = 0;
  let unrealizedPnl = 0;

  for (const [sym, pos] of Object.entries(positions)) {
    totalInvested += pos.investedUsdc;
    const currentPrice = currentPrices[sym] ?? pos.entryPrice;
    const currentValue = pos.tokenAmount * currentPrice;
    unrealizedPnl += currentValue - pos.investedUsdc;
  }

  const posCount = Object.keys(positions).length;
  const totalValue = portfolioState.cashAvailable + totalInvested + unrealizedPnl;

  // Peak tracking
  if (totalValue > portfolioState.peakValue) {
    portfolioState.peakValue = totalValue;
  }

  // Drawdown
  const drawdown = portfolioState.peakValue > 0
    ? ((portfolioState.peakValue - totalValue) / portfolioState.peakValue) * 100
    : 0;

  // Reset daily/weekly PnL
  const now = Date.now();
  if (now - dailyPnlResetTime > 24 * 60 * 60 * 1000) {
    portfolioState.dailyPnl = 0;
    dailyPnlResetTime = now;
  }
  if (now - weeklyPnlResetTime > 7 * 24 * 60 * 60 * 1000) {
    portfolioState.weeklyPnl = 0;
    weeklyPnlResetTime = now;
  }

  portfolioState = {
    ...portfolioState,
    totalValue,
    positionsCount: posCount,
    totalExposurePct: totalValue > 0 ? (totalInvested / totalValue) * 100 : 0,
    unrealizedPnl,
    drawdownPct: drawdown,
  };

  return portfolioState;
}

// ============================================================
//  TRADE RECORDING
// ============================================================
export function recordTradeResult(pnl: number): void {
  portfolioState.realizedPnl += pnl;
  portfolioState.dailyPnl += pnl;
  portfolioState.weeklyPnl += pnl;

  if (pnl < 0) {
    consecutiveLosses++;
    if (consecutiveLosses >= RISK.consecutiveLossLimit) {
      lossSizeReduction = 0.5;
      console.log(`  ⚠️  ${consecutiveLosses} consecutive losses → position sizes halved for next 5 trades`);
    }
  } else {
    consecutiveLosses = 0;
    lossSizeReduction = 1.0;
  }
}

export function deductCash(amount: number): void {
  portfolioState.cashAvailable -= amount;
}

export function addCash(amount: number): void {
  portfolioState.cashAvailable += amount;
}

// ============================================================
//  RISK CHECKS (Circuit Breakers)
// ============================================================
export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
  sizeMultiplier: number; // 1.0 = normal, <1 = reduce size
}

export function checkRisk(regime: MarketRegime): RiskCheckResult {
  const now = Date.now();

  // 1. Pause check
  if (now < pausedUntil) {
    const remaining = Math.ceil((pausedUntil - now) / 60_000);
    return { allowed: false, reason: `⏸️  Paused (${remaining}m remaining)`, sizeMultiplier: 0 };
  }

  // 2. Daily drawdown circuit breaker
  const dailyDrawdown = portfolioState.dailyPnl < 0
    ? (Math.abs(portfolioState.dailyPnl) / portfolioState.totalValue) * 100
    : 0;
  if (dailyDrawdown > RISK.maxDailyDrawdownPct) {
    pausedUntil = now + RISK.pauseDurationMs;
    dataBus.emit('risk:circuit-breaker', {
      reason: `Daily drawdown ${dailyDrawdown.toFixed(1)}% > ${RISK.maxDailyDrawdownPct}%`,
      pauseMs: RISK.pauseDurationMs,
    });
    return { allowed: false, reason: `🚨 Daily drawdown limit hit`, sizeMultiplier: 0 };
  }

  // 3. Weekly drawdown circuit breaker
  const weeklyDrawdown = portfolioState.weeklyPnl < 0
    ? (Math.abs(portfolioState.weeklyPnl) / portfolioState.totalValue) * 100
    : 0;
  if (weeklyDrawdown > RISK.maxWeeklyDrawdownPct) {
    pausedUntil = now + RISK.pauseDurationMs * 6; // 12 hours
    return { allowed: false, reason: `🚨 Weekly drawdown limit hit`, sizeMultiplier: 0 };
  }

  // 4. Max positions
  if (portfolioState.positionsCount >= RISK.maxPositions) {
    return { allowed: false, reason: `Max positions (${RISK.maxPositions}) reached`, sizeMultiplier: 0 };
  }

  // 5. Max exposure
  if (portfolioState.totalExposurePct >= RISK.maxExposurePct) {
    return { allowed: false, reason: `Max exposure (${RISK.maxExposurePct}%) reached`, sizeMultiplier: 0 };
  }

  // 6. Consecutive loss reduction
  let multiplier = lossSizeReduction;

  // 7. High volatility regime → extra caution
  if (regime === MarketRegime.HIGH_VOLATILITY) {
    multiplier *= 0.7;
  }

  return { allowed: true, reason: 'OK', sizeMultiplier: multiplier };
}

export function getPortfolioState(): PortfolioState {
  return { ...portfolioState };
}

export function getConsecutiveLosses(): number {
  return consecutiveLosses;
}

// ============================================================
//  POSITION EXITS (Trailing Stop & Partial TP)
// ============================================================
export function getPositionExitAction(
  pos: Position,
  currentPrice: number,
  h: PriceHistory
): { action: 'HOLD' | 'SELL' | 'PARTIAL_SELL' | 'ADD_TO_POSITION'; reason?: string; partialFraction?: number } {
  const atr = h.atr;
  
  let trailMult = 1.5;
  let targetMult = 1.0;
  let partialFrac = 0.6;
  
  switch (pos.regime) {
    case MarketRegime.TRENDING_UP:
      partialFrac = 0.4; trailMult = 1.0; break;
    case MarketRegime.TRENDING_DOWN:
      partialFrac = 0.8; trailMult = 2.0; targetMult = 0.8; break;
    case MarketRegime.MEAN_REVERTING:
      partialFrac = 0.7; trailMult = 1.5; break;
    case MarketRegime.HIGH_VOLATILITY:
      partialFrac = 0.5; trailMult = 2.5; break;
    case MarketRegime.LOW_VOLATILITY:
      partialFrac = 1.0; break;
  }
  
  const trailingStopDist = atr * trailMult;
  
  // Fix: Only activate trailing stop once gain exceeds activation threshold
  let activeStop = pos.stopPrice;
  const gainPct = ((pos.peakPrice - pos.entryPrice) / pos.entryPrice) * 100;
  
  if (gainPct >= EXITS.TRAIL_ACTIVATION_PCT) {
    const dynamicStop = pos.peakPrice * (1 - trailingStopDist / 100);
    activeStop = Math.max(pos.stopPrice, dynamicStop);
  }
  if (pos.partialDone) {
    activeStop = Math.max(activeStop, pos.entryPrice);
  }

  if (currentPrice <= activeStop) {
    return { action: 'SELL', reason: `Trailing Stop Hit (Stop: $${activeStop.toFixed(6)})` };
  }

  const effectiveTarget = pos.entryPrice + (pos.targetPrice - pos.entryPrice) * targetMult;
  
  if (currentPrice >= effectiveTarget && !pos.partialDone) {
    if (partialFrac >= 1.0) {
      return { action: 'SELL', reason: `Full Target Hit in Low Volatility ($${effectiveTarget.toFixed(6)})` };
    }
    return { action: 'PARTIAL_SELL', reason: `Target Hit ($${effectiveTarget.toFixed(6)})`, partialFraction: partialFrac };
  }
  
  if (pos.regime === MarketRegime.TRENDING_UP) {
    const pLevel = pos.pyramidLevel ?? 0;
    if (pLevel === 0 && currentPrice >= pos.entryPrice + atr) {
      return { action: 'ADD_TO_POSITION', reason: 'Pyramid +1 ATR' };
    }
    if (pLevel === 1 && currentPrice >= pos.entryPrice + atr * 2) {
      return { action: 'ADD_TO_POSITION', reason: 'Pyramid +2 ATR' };
    }
  }

  return { action: 'HOLD' };
}
