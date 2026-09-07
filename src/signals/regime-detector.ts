/**
 * Market Regime Detector
 * ──────────────────────
 * State machine that classifies the market into regimes using:
 *   - Hurst Exponent (R/S analysis): trending vs mean-reverting
 *   - ATR percentile: volatility regime
 *   - EMA alignment: directional bias
 * Each regime activates different strategy parameters.
 */

import { MarketRegime, RegimeState, PriceHistory } from '../core/types';
import { REGIME } from '../core/config';
import { emaAlignment } from './ema-atr';
import { createSignal } from './signal-types';
import { Signal } from '../core/types';

// ============================================================
//  HURST EXPONENT (Rescaled Range method)
// ============================================================
/**
 * Compute the Hurst exponent using R/S (Rescaled Range) analysis.
 *
 * H > 0.6 → persistent (trending)
 * H ≈ 0.5 → random walk
 * H < 0.4 → anti-persistent (mean-reverting)
 *
 * This is an approximation using a single scale.
 * For production, you'd use multiple scales and linear regression.
 */
export function computeHurstExponent(prices: number[]): number {
  const n = Math.min(prices.length, REGIME.HURST_WINDOW);
  if (n < 20) return 0.5; // not enough data

  // Compute log returns
  const returns: number[] = [];
  for (let i = prices.length - n; i < prices.length - 1; i++) {
    if (prices[i] > 0) {
      returns.push(Math.log(prices[i + 1] / prices[i]));
    }
  }

  if (returns.length < 10) return 0.5;

  // Split into sub-series and compute R/S for multiple chunk sizes
  const chunkSizes = [8, 16, 32, 64].filter(s => s <= returns.length);
  if (chunkSizes.length < 2) return 0.5;

  const logN: number[] = [];
  const logRS: number[] = [];

  for (const chunkSize of chunkSizes) {
    const numChunks = Math.floor(returns.length / chunkSize);
    if (numChunks === 0) continue;

    let rsSum = 0;
    for (let c = 0; c < numChunks; c++) {
      const chunk = returns.slice(c * chunkSize, (c + 1) * chunkSize);

      // Mean of chunk
      const mean = chunk.reduce((s, v) => s + v, 0) / chunk.length;

      // Cumulative deviation from mean
      const cumDev: number[] = [];
      let cum = 0;
      for (const r of chunk) {
        cum += r - mean;
        cumDev.push(cum);
      }

      // Range
      const range = Math.max(...cumDev) - Math.min(...cumDev);

      // Standard deviation
      const variance = chunk.reduce((s, v) => s + (v - mean) ** 2, 0) / chunk.length;
      const sd = Math.sqrt(variance);

      // R/S
      rsSum += sd > 0 ? range / sd : 0;
    }

    const avgRS = rsSum / numChunks;
    if (avgRS > 0) {
      logN.push(Math.log(chunkSize));
      logRS.push(Math.log(avgRS));
    }
  }

  // Linear regression: log(R/S) = H × log(n) + c
  if (logN.length < 2) return 0.5;

  const n2 = logN.length;
  const sumX = logN.reduce((s, v) => s + v, 0);
  const sumY = logRS.reduce((s, v) => s + v, 0);
  const sumXY = logN.reduce((s, v, i) => s + v * logRS[i], 0);
  const sumX2 = logN.reduce((s, v) => s + v * v, 0);

  const hurst = (n2 * sumXY - sumX * sumY) / (n2 * sumX2 - sumX * sumX);

  // Clamp to valid range
  return Math.max(0.01, Math.min(0.99, hurst));
}

// ============================================================
//  ATR PERCENTILE
// ============================================================
/**
 * Where does the current ATR sit relative to historical ATR values?
 * Returns 0–100 percentile.
 */
export function atrPercentile(currentATR: number, historicalATRs: number[]): number {
  if (historicalATRs.length === 0) return 50;
  const sorted = [...historicalATRs].sort((a, b) => a - b);
  let count = 0;
  for (const v of sorted) {
    if (v <= currentATR) count++;
  }
  return (count / sorted.length) * 100;
}

// ============================================================
//  REGIME CLASSIFICATION
// ============================================================
const atrHistory: Record<string, number[]> = {};

export function classifyRegime(symbol: string, h: PriceHistory): RegimeState {
  // Track ATR history
  if (!atrHistory[symbol]) atrHistory[symbol] = [];
  atrHistory[symbol].push(h.atr);
  if (atrHistory[symbol].length > REGIME.ATR_HISTORY_SIZE) atrHistory[symbol].shift();

  const hurst = computeHurstExponent(h.prices);
  const atrPctl = atrPercentile(h.atr, atrHistory[symbol]);
  const alignment = emaAlignment(h);

  let regime: MarketRegime;

  // Decision tree
  if (atrPctl > REGIME.ATR_HIGH_VOL_PCT) {
    regime = MarketRegime.HIGH_VOLATILITY;
  } else if (atrPctl < REGIME.ATR_LOW_VOL_PCT) {
    regime = MarketRegime.LOW_VOLATILITY;
  } else if (hurst > REGIME.HURST_TRENDING) {
    regime = alignment > 0 ? MarketRegime.TRENDING_UP : MarketRegime.TRENDING_DOWN;
  } else if (hurst < REGIME.HURST_MEAN_REVERT) {
    regime = MarketRegime.MEAN_REVERTING;
  } else {
    regime = MarketRegime.RANDOM_WALK;
  }

  // Confidence based on how clearly we can classify
  const hurstClarity = Math.abs(hurst - 0.5) * 2; // 0 = random, 1 = very clear
  const atrClarity = Math.abs(atrPctl - 50) / 50;  // 0 = middle, 1 = extreme
  const confidence = Math.min((hurstClarity + atrClarity) / 2 + 0.3, 1);

  return {
    regime,
    hurstExponent: hurst,
    atrPercentile: atrPctl,
    emaAlignment: alignment,
    confidence,
    since: Date.now(),
  };
}

export function generateRegimeSignal(
  symbol: string, regimeState: RegimeState,
): Signal | null {
  // Regime signal provides contextual direction
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  if (regimeState.regime === MarketRegime.TRENDING_UP) direction = 'LONG';
  else if (regimeState.regime === MarketRegime.TRENDING_DOWN) direction = 'SHORT';
  else direction = 'NEUTRAL';

  return createSignal('regime', direction, regimeState.confidence, symbol, {
    regime: regimeState.regime,
    hurst: regimeState.hurstExponent,
    atrPctl: regimeState.atrPercentile,
    alignment: regimeState.emaAlignment,
  });
}
