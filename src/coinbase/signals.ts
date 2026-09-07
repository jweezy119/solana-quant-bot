/**
 * Coinbase Technical Analysis Signal Generator
 * ───────────────────────────────────────────
 * Computes RSI, EMA(9/21) trend filters, ATR volatility bands,
 * and Bollinger Band mean-reversion signals from Coinbase candles.
 */

import { getCandles, getTicker } from './client';

export interface TechnicalSignal {
  productId: string;
  currentPrice: number;
  direction: 'BUY' | 'SELL' | 'NEUTRAL';
  confidence: number; // 0.0 to 1.0
  rsi: number;
  emaFast: number;
  emaSlow: number;
  atr: number;
  atrPct: number;
  bollingerLower: number;
  bollingerUpper: number;
  trend: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
  reasoning: string;
  timestamp: number;
}

// ─── MATH HELPERS ─────────────────────────────────────────────

export function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const emaValues: number[] = [prices[0]];

  for (let i = 1; i < prices.length; i++) {
    const val = prices[i] * k + emaValues[i - 1] * (1 - k);
    emaValues.push(val);
  }
  return emaValues;
}

export function calculateRSI(prices: number[], period = 14): number {
  if (prices.length <= period) return 50; // default neutral if not enough candles

  let gains = 0;
  let losses = 0;

  // Initial average
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothed RSI for remaining periods
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calculateATR(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (highs.length < 2) return 0;
  const trs: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }

  if (trs.length < period) {
    return trs.reduce((a, b) => a + b, 0) / (trs.length || 1);
  }

  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

export function calculateBollinger(prices: number[], period = 20, multiplier = 2) {
  if (prices.length < period) {
    const p = prices[prices.length - 1] || 0;
    return { middle: p, upper: p * 1.02, lower: p * 0.98 };
  }

  const slice = prices.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);

  return {
    middle: mean,
    upper: mean + multiplier * std,
    lower: mean - multiplier * std,
  };
}

/**
 * Generate comprehensive technical signal for a Coinbase product
 */
export async function getTechnicalSignal(productId: string): Promise<TechnicalSignal> {
  const now = Math.floor(Date.now() / 1000);
  const candleLookback = 3600 * 12; // 12 hours of 15m candles (approx 48 candles)

  // Fetch recent candles and ticker
  const [candlesRes, tickerRes] = await Promise.all([
    getCandles(productId, now - candleLookback, now, 'FIFTEEN_MINUTE') as any,
    getTicker(productId) as any,
  ]);

  const rawCandles = candlesRes.candles || [];
  if (rawCandles.length < 15) {
    throw new Error(`Insufficient candle data for ${productId}`);
  }

  // Coinbase returns candles newest-first: reverse so chronological (oldest to newest)
  const sorted = rawCandles.slice().reverse();

  const closes = sorted.map((c: any) => parseFloat(c.close));
  const highs = sorted.map((c: any) => parseFloat(c.high));
  const lows = sorted.map((c: any) => parseFloat(c.low));

  const livePrice = tickerRes.trades?.[0]?.price
    ? parseFloat(tickerRes.trades[0].price)
    : closes[closes.length - 1];

  // Append current live price to closes for real-time reactivity
  const activeCloses = [...closes, livePrice];

  // Indicators
  const rsi = calculateRSI(activeCloses, 14);
  const ema9Series = calculateEMA(activeCloses, 9);
  const ema21Series = calculateEMA(activeCloses, 21);
  const emaFast = ema9Series[ema9Series.length - 1];
  const emaSlow = ema21Series[ema21Series.length - 1];

  const atr = calculateATR(highs, lows, closes, 14);
  const atrPct = (atr / livePrice) * 100;
  const bollinger = calculateBollinger(activeCloses, 20, 2);

  // Trend determination
  let trend: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' = 'SIDEWAYS';
  if (emaFast > emaSlow * 1.001) {
    trend = 'UPTREND';
  } else if (emaFast < emaSlow * 0.999) {
    trend = 'DOWNTREND';
  }

  // Signal scoring
  let score = 0; // Positive for BUY, Negative for SELL
  const reasons: string[] = [];
  const isBearRegime = process.env.COINBASE_REGIME !== 'BULL'; // Default to Bear / Defensive Sniper mode

  // 1. RSI Capitulation / Exhaustion Filter
  // In bear mode "deep oversold" alone is a falling knife — the flush often
  // continues. Only bank the full capitulation score when the last closed 15m
  // candle has turned green (bid re-engaged), otherwise treat as unconfirmed.
  const lastClose = closes[closes.length - 1];
  const priorClose = closes[closes.length - 2];
  const barReversal = lastClose > priorClose && livePrice >= lastClose * 0.999;
  if (rsi < 28) {
    if (barReversal) {
      score += 0.50;
      reasons.push(`🔥 Capitulation reversed: RSI ${rsi.toFixed(1)} < 28 + renewed bid (green candle)`);
    } else {
      score += 0.15;
      reasons.push(`⚠️ Capitulation tick (RSI ${rsi.toFixed(1)} < 28) — awaiting reversal confirmation`);
    }
  } else if (!isBearRegime && rsi < 36) {
    score += 0.30;
    reasons.push(`RSI oversold dip (${rsi.toFixed(1)})`);
  } else if (isBearRegime && rsi < 36) {
    // In bear markets, RSI 28-36 is often a bull trap: suppress buying until < 28
    reasons.push(`⚠️ Mild dip (RSI ${rsi.toFixed(1)}), awaiting full panic flush (< 28)`);
  } else if (rsi > 68) {
    score -= 0.45;
    reasons.push(`RSI overbought relief exhaustion (${rsi.toFixed(1)} > 68)`);
  } else if (rsi > 58 && isBearRegime) {
    score -= 0.20;
    reasons.push(`RSI relief rally approaching resistance (${rsi.toFixed(1)})`);
  }

  // 2. EMA Trend Filter
  if (trend === 'UPTREND') {
    score += 0.20;
    reasons.push(`EMA(9/21) uptrend`);
  } else if (trend === 'DOWNTREND') {
    score -= 0.20;
    reasons.push(`EMA(9/21) macro downtrend`);
  }

  // 3. Bollinger Band Capitulation Piercing
  if (livePrice <= bollinger.lower) {
    score += 0.35;
    reasons.push(`Price pierced lower Bollinger Band ($${bollinger.lower.toFixed(4)})`);
  } else if (livePrice >= bollinger.upper) {
    score -= 0.35;
    reasons.push(`Price at upper Bollinger Band ($${bollinger.upper.toFixed(4)})`);
  }

  // Direction & Confidence
  let direction: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let confidence = 0.5;

  if (score >= 0.40) {
    direction = 'BUY';
    confidence = Math.min(0.95, 0.55 + score * 0.45);
  } else if (score <= -0.35) {
    direction = 'SELL';
    confidence = Math.min(0.95, 0.55 + Math.abs(score) * 0.45);
  } else {
    direction = 'NEUTRAL';
    confidence = 0.5;
    reasons.push(`Awaiting high-conviction setup`);
  }

  return {
    productId,
    currentPrice: livePrice,
    direction,
    confidence: parseFloat(confidence.toFixed(2)),
    rsi: parseFloat(rsi.toFixed(1)),
    emaFast: parseFloat(emaFast.toFixed(2)),
    emaSlow: parseFloat(emaSlow.toFixed(2)),
    atr: parseFloat(atr.toFixed(2)),
    atrPct: parseFloat(atrPct.toFixed(2)),
    bollingerLower: parseFloat(bollinger.lower.toFixed(2)),
    bollingerUpper: parseFloat(bollinger.upper.toFixed(2)),
    trend,
    reasoning: reasons.join(' | '),
    timestamp: Date.now(),
  };
}
