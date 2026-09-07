/**
 * Modified Kelly Criterion Position Sizer
 * ────────────────────────────────────────
 * f* = (bp - q) / b  ← standard Kelly
 * f_safe = f* × fraction × confidence × regime_mult × (1 - corr_penalty)
 * position = portfolio × f_safe, clamped to [MIN, MAX]
 *
 * Compounds: uses CURRENT portfolio value, not starting capital.
 */

import { TradeDecision, MarketRegime, Position } from '../core/types';
import {
  KELLY, MIN_TRADE_USDC, MAX_TRADE_USDC,
  REGIME_MULTIPLIERS, RISK,
} from '../core/config';

// ============================================================
//  KELLY MATH
// ============================================================
/**
 * Standard Kelly fraction.
 * f* = (b × p - q) / b
 * where b = win/loss ratio, p = win probability, q = 1-p
 */
export function kellyFraction(winRate: number, winLossRatio: number): number {
  const p = winRate;
  const q = 1 - p;
  const b = winLossRatio;
  const f = (b * p - q) / b;
  return Math.max(0, f); // never negative
}

/**
 * Correlation penalty: reduce size when existing positions are correlated.
 * Simple heuristic: if we already hold N positions, each additional one
 * gets a penalty because crypto assets are generally correlated.
 *
 * penalty = 1 - (existingPositions × correlationFactor)
 */
export function correlationPenalty(
  existingPositions: number,
  correlationFactor = 0.15,
): number {
  return Math.max(0.3, 1 - existingPositions * correlationFactor);
}

// ============================================================
//  POSITION SIZING
// ============================================================
export interface SizingResult {
  positionUsdc: number;
  kellyRaw: number;
  kellySafe: number;
  regimeMult: number;
  corrPenalty: number;
  portfolioPct: number;
}

/**
 * Calculate position size for a trade decision.
 *
 * @param decision - The trade decision from signal fusion
 * @param portfolioValue - Current total portfolio value in USDC
 * @param existingPositions - Number of currently open positions
 * @param historicalWinRate - Actual win rate from trade journal (or default)
 * @param historicalWLR - Actual win/loss ratio from journal (or default)
 */
export function calculatePositionSize(
  decision: TradeDecision,
  portfolioValue: number,
  existingPositions: number,
  currentExposureUsdc: number,
  historicalWinRate?: number,
  historicalWLR?: number,
): SizingResult {
  // Use historical data if available, otherwise use configured defaults
  const winRate = historicalWinRate ?? KELLY.WIN_RATE;
  const winLossRatio = historicalWLR ?? KELLY.WIN_LOSS_RATIO;

  // Step 1: Raw Kelly fraction
  const kellyRaw = kellyFraction(winRate, winLossRatio);

  // Step 2: Regime multiplier
  const regimeMult = REGIME_MULTIPLIERS[decision.regime] ?? 1.0;

  // Step 3: Correlation penalty
  const corrPenalty = correlationPenalty(existingPositions);

  // Step 4: Confidence scaling
  const confidenceScale = KELLY.CONFIDENCE_SCALE ? decision.confidence : 1.0;

  // Step 5: Entropy Penalty
  // High entropy means signals are highly conflicted. Reduce size up to 80% if maximum uncertainty.
  const entropyPenalty = 1 - (decision.entropy * 0.8);

  // Step 6: Apply all multipliers
  const kellySafe = kellyRaw
    * KELLY.FRACTION        // half-Kelly for safety
    * confidenceScale       // scale by signal confidence
    * regimeMult            // regime adjustment
    * corrPenalty           // correlation penalty
    * entropyPenalty;       // entropy penalty

  // Step 7: Convert to USDC
  let positionUsdc = portfolioValue * kellySafe;

  // Step 7: Apply hard limits
  // Max per position as % of portfolio
  const maxFromPct = portfolioValue * (RISK.maxPerPositionPct / 100);
  positionUsdc = Math.min(positionUsdc, maxFromPct);

  // Max total exposure check
  const maxTotalExposure = portfolioValue * (RISK.maxExposurePct / 100);
  if (currentExposureUsdc + positionUsdc > maxTotalExposure) {
    positionUsdc = Math.max(0, maxTotalExposure - currentExposureUsdc);
  }

  // Absolute limits — dynamically scale max trade ceiling with portfolio growth for true compounding
  const effectiveMaxTrade = Math.max(RISK.maxTradeUsdc, maxFromPct);
  const minTrade = RISK.minTradeUsdc;
  positionUsdc = Math.max(minTrade, Math.min(effectiveMaxTrade, positionUsdc));

  // Don't trade if position would be too small relative to portfolio
  if (positionUsdc < minTrade) {
    positionUsdc = 0;
  }

  return {
    positionUsdc,
    kellyRaw,
    kellySafe,
    regimeMult,
    corrPenalty,
    portfolioPct: portfolioValue > 0 ? (positionUsdc / portfolioValue) * 100 : 0,
  };
}
