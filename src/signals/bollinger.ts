/**
 * Bollinger Band %B Signal
 * ────────────────────────
 * %B = (price - lower) / (upper - lower)
 *   < 0.1 → oversold (buy in uptrend)
 *   > 0.9 → overbought (sell/reduce)
 * Bandwidth = (upper - lower) / middle → volatility measure
 */

import { PriceHistory, BollingerState, Signal, MarketRegime } from '../core/types';
import { BOLLINGER } from '../core/config';
import { createSignal, sma, stdDev } from './signal-types';

// ============================================================
//  BOLLINGER BAND COMPUTATION
// ============================================================
export function computeBollinger(prices: number[], period = BOLLINGER.PERIOD, numStdDev = BOLLINGER.STD_DEV): BollingerState {
  if (prices.length < period) {
    // Not enough data — return neutral state
    const p = prices[prices.length - 1] || 0;
    return { upper: p, middle: p, lower: p, percentB: 0.5, bandwidth: 0 };
  }

  const slice = prices.slice(-period);
  const middle = sma(slice);
  const sd = stdDev(slice);
  const upper = middle + numStdDev * sd;
  const lower = middle - numStdDev * sd;

  const price = prices[prices.length - 1];
  const range = upper - lower;
  const percentB = range > 0 ? (price - lower) / range : 0.5;
  const bandwidth = middle > 0 ? range / middle : 0;

  return { upper, middle, lower, percentB, bandwidth };
}

// ============================================================
//  SIGNAL GENERATION
// ============================================================
export function generateBollingerSignal(
  symbol: string,
  price: number,
  h: PriceHistory,
  hasPosition: boolean,
  regime?: MarketRegime,
): Signal | null {
  const bb = computeBollinger(h.prices);

  // Not enough data for meaningful signal
  if (h.prices.length < BOLLINGER.PERIOD) return null;

  // ── SELL signals ──
  if (hasPosition && bb.percentB > BOLLINGER.OVERBOUGHT_THRESHOLD) {
    const confidence = 0.5 + (bb.percentB - BOLLINGER.OVERBOUGHT_THRESHOLD) * 2;
    return createSignal('bollinger', 'SHORT', Math.min(confidence, 0.85), symbol, {
      reason: 'overbought',
      percentB: bb.percentB,
      bandwidth: bb.bandwidth,
    });
  }

  // ── BUY signals ──
  if (!hasPosition && bb.percentB < BOLLINGER.OVERSOLD_THRESHOLD) {
    // Only buy oversold in mean-reverting or trending-up regimes
    if (regime === MarketRegime.TRENDING_DOWN) {
      return createSignal('bollinger', 'NEUTRAL', 0.2, symbol, {
        reason: 'oversold-but-downtrend',
        percentB: bb.percentB,
      });
    }

    let confidence = 0.5 + (BOLLINGER.OVERSOLD_THRESHOLD - bb.percentB) * 3;

    // Regime bonus
    if (regime === MarketRegime.MEAN_REVERTING) confidence += 0.15;
    if (regime === MarketRegime.TRENDING_UP) confidence += 0.1;

    // Squeeze detection: very low bandwidth + oversold = spring loading
    if (bb.bandwidth < 0.02) confidence += 0.1;

    return createSignal('bollinger', 'LONG', Math.min(confidence, 0.9), symbol, {
      reason: 'oversold',
      percentB: bb.percentB,
      bandwidth: bb.bandwidth,
      squeeze: bb.bandwidth < 0.02,
    });
  }

  return null;
}
