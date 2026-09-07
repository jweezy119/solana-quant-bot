/**
 * Enhanced EMA / ATR / Momentum Signal
 * ─────────────────────────────────────
 * Upgraded from v2:
 *   - Multi-period EMA alignment (8/13/21/55)
 *   - Wilder's smoothed ATR (more stable)
 *   - Multi-window momentum (3, 5, 8 bars)
 *   - Confidence score based on indicator agreement
 */

import { PriceHistory, Signal, MarketRegime } from '../core/types';
import { EMA, ATR, EXITS } from '../core/config';
import { createSignal } from './signal-types';
import { getPosition } from '../persistence/position-store';
import { getPositionExitAction } from '../strategy/risk-manager';

// ============================================================
//  MATH
// ============================================================
export function computeEMA(prev: number, price: number, period: number): number {
  const k = 2 / (period + 1);
  return prev === 0 ? price : price * k + prev * (1 - k);
}

/**
 * Wilder's Smoothed ATR — more stable than simple average.
 * ATR_t = ((ATR_{t-1} × (n-1)) + TR_t) / n
 */
export function computeWildersATR(
  prevATR: number,
  trueRange: number,
  period: number,
): number {
  if (prevATR === 0) return trueRange;
  return (prevATR * (period - 1) + trueRange) / period;
}

/**
 * True Range as percentage of price.
 */
export function trueRangePct(high: number, low: number, prevClose: number): number {
  const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  return (tr / prevClose) * 100;
}

/**
 * Simple ATR % from price array (fallback when we don't have OHLCV)
 */
export function computeATRPctFromPrices(prices: number[], period = 14): number {
  if (prices.length < 2) return 2.0;
  let sum = 0;
  const n = Math.min(prices.length - 1, period);
  for (let i = prices.length - 1; i >= prices.length - n; i--) {
    sum += Math.abs(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
  }
  return sum / n;
}

const pct = (a: number, b: number) => ((a - b) / b) * 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ============================================================
//  HISTORY MANAGEMENT
// ============================================================
export function initHistory(price: number): PriceHistory {
  return {
    prices: [price],
    volumes: [0],
    timestamps: [Date.now()],
    emaFast: price,
    emaSlow: price,
    ema8: price,
    ema13: price,
    ema21: price,
    ema55: price,
    atr: 2.0,
    atrSmoothed: 2.0,
    rollingHigh: price,
    rollingLow: price,
    vwap: price,
    vwapVolume: 0,
    vwapPV: 0,
  };
}

export function updateHistory(
  h: PriceHistory,
  price: number,
  volume = 0,
  inPosition = false,
): PriceHistory {
  h.prices.push(price);
  h.volumes.push(volume);
  h.timestamps.push(Date.now());
  if (h.prices.length > 200) {
    h.prices.shift();
    h.volumes.shift();
    h.timestamps.shift();
  }

  // EMAs
  h.emaFast = computeEMA(h.emaFast, price, EMA.FAST);
  h.emaSlow = computeEMA(h.emaSlow, price, EMA.SLOW);
  h.ema8 = computeEMA(h.ema8, price, 8);
  h.ema13 = computeEMA(h.ema13, price, 13);
  h.ema21 = computeEMA(h.ema21, price, 21);
  h.ema55 = computeEMA(h.ema55, price, 55);

  // ATR (Wilder's smoothed from price-only TR proxy)
  if (h.prices.length >= 2) {
    const prevPrice = h.prices[h.prices.length - 2];
    const tr = Math.abs(pct(price, prevPrice));
    h.atrSmoothed = computeWildersATR(h.atrSmoothed, tr, ATR.PERIOD);
  }
  h.atr = computeATRPctFromPrices(h.prices, ATR.PERIOD);

  // Rolling high/low (only update when not in position)
  if (!inPosition) {
    if (price > h.rollingHigh) h.rollingHigh = price;
    if (price < h.rollingLow || h.rollingLow === 0) h.rollingLow = price;
  }

  // VWAP
  if (volume > 0) {
    h.vwapVolume += volume;
    h.vwapPV += price * volume;
    h.vwap = h.vwapPV / h.vwapVolume;
  }

  return h;
}

// ============================================================
//  EMA ALIGNMENT SCORE
// ============================================================
/**
 * Returns a score from -1.0 (fully bearish) to +1.0 (fully bullish)
 * based on EMA ribbon alignment: EMA8 > EMA13 > EMA21 > EMA55
 */
export function emaAlignment(h: PriceHistory): number {
  let score = 0;
  const pairs = [
    [h.ema8, h.ema13],
    [h.ema13, h.ema21],
    [h.ema21, h.ema55],
    [h.emaFast, h.emaSlow],
  ];
  for (const [fast, slow] of pairs) {
    score += fast > slow ? 1 : -1;
  }
  return score / pairs.length; // normalized to [-1, 1]
}

// ============================================================
//  MOMENTUM (multi-window)
// ============================================================
/**
 * Returns momentum score: positive = rising, negative = falling.
 * Checks 3, 5, and 8 bars back and averages.
 */
export function momentumScore(prices: number[]): number {
  if (prices.length < 9) return 0;
  const current = prices[prices.length - 1];
  const windows = [3, 5, 8];
  let score = 0;

  for (const w of windows) {
    const past = prices[prices.length - 1 - w];
    const change = pct(current, past);
    score += change > 0 ? 1 : change < 0 ? -1 : 0;
  }

  return score / windows.length; // normalized to [-1, 1]
}

// ============================================================
//  SIGNAL GENERATION
// ============================================================
export function getDynamicThresholds(atr: number): {
  dipPct: number;
  sellPct: number;
  stopPct: number;
} {
  return {
    dipPct: clamp(atr * ATR.DIP_MULT, ATR.MIN_DIP_PCT, ATR.MAX_DIP_PCT),
    sellPct: clamp(atr * ATR.SELL_MULT, EXITS.BASE_SELL_PCT, 8.0),
    stopPct: clamp(atr * ATR.STOP_MULT, EXITS.BASE_STOP_PCT, 3.5),
  };
}

/**
 * Generate EMA/ATR signal for a token.
 * Returns BUY, SELL, or null.
 */
export function generateEmaAtrSignal(
  symbol: string,
  price: number,
  h: PriceHistory,
  hasPosition: boolean,
  entryPrice?: number,
  regime?: MarketRegime,
): Signal | null {
  if (h.prices.length < EMA.MIN_SAMPLES) return null;

  const alignment = emaAlignment(h);
  const momentum = momentumScore(h.prices);
  const { dipPct } = getDynamicThresholds(h.atr);

  // ── SELL signals ──
  if (hasPosition) {
    const pos = getPosition(symbol);
    if (pos) {
      // 1. Check Trailing Stops and Partial Take Profits via Risk Manager
      const exitAction = getPositionExitAction(pos, price, h);
      
      if (exitAction.action === 'SELL') {
        return createSignal('ema-atr', 'SHORT', 0.9, symbol, {
          reason: exitAction.reason ?? 'risk-manager-exit',
          gainPct: pct(price, pos.entryPrice),
        });
      }
      
      if (exitAction.action === 'PARTIAL_SELL') {
        return createSignal('ema-atr', 'SHORT', 0.8, symbol, {
          reason: exitAction.reason ?? 'partial-take-profit',
          isPartial: true,
          partialFraction: exitAction.partialFraction,
          gainPct: pct(price, pos.entryPrice),
        });
      }

      if (exitAction.action === 'ADD_TO_POSITION') {
        return createSignal('ema-atr', 'LONG', 1.0, symbol, {
          reason: exitAction.reason ?? 'pyramid-add',
          isAdd: true,
        });
      }
    }

    // 2. Trend reversal while in position
    if (alignment < -0.5 && momentum < -0.5) {
      return createSignal('ema-atr', 'SHORT', 0.6, symbol, {
        reason: 'trend-reversal',
        alignment,
        momentum,
      });
    }

    return null; // hold
  }

  // ── BUY signals ──
  // Uptrend filter
  if (alignment <= 0) return createSignal('ema-atr', 'NEUTRAL', 0.2, symbol, {
    reason: 'no-uptrend',
    alignment,
  });

  // Dip from rolling high
  const dipFromHigh = pct(price, h.rollingHigh);
  if (dipFromHigh > -dipPct) return null; // not enough dip

  // Momentum must be rising (no falling knives)
  if (momentum <= 0) return createSignal('ema-atr', 'NEUTRAL', 0.3, symbol, {
    reason: 'no-momentum',
    momentum,
  });

  // Calculate confidence based on indicator agreement
  let confidence = 0.5; // base
  confidence += alignment * 0.15;              // up to +0.15 for full alignment
  confidence += Math.min(momentum, 1) * 0.15;  // up to +0.15 for strong momentum
  // Bigger dip = higher confidence (capped)
  const dipStrength = Math.min(Math.abs(dipFromHigh) / dipPct, 2) * 0.1;
  confidence += dipStrength;

  // Regime bonus
  if (regime === MarketRegime.TRENDING_UP) confidence += 0.1;
  if (regime === MarketRegime.HIGH_VOLATILITY) confidence -= 0.1;

  return createSignal('ema-atr', 'LONG', confidence, symbol, {
    reason: 'dip-buy',
    dipPct: Math.abs(dipFromHigh),
    alignment,
    momentum,
    atr: h.atr,
  });
}
