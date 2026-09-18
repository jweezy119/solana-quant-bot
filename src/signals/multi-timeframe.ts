/**
 * Multi-Timeframe Confluence Engine
 * ──────────────────────────────────
 * Fetches 5m, 15m, and 1h candles for a product and computes
 * RSI + EMA trend on each timeframe. Returns a confluence score
 * that boosts or blocks trades based on alignment.
 */

import { getCandles } from '../coinbase/client';
import { calculateRSI, calculateEMA } from '../coinbase/signals';

export interface MTFConfluence {
  timeframes: {
    '5m':  { rsi: number; trend: 'UP' | 'DOWN' | 'NEUTRAL' };
    '15m': { rsi: number; trend: 'UP' | 'DOWN' | 'NEUTRAL' };
    '1h':  { rsi: number; trend: 'UP' | 'DOWN' | 'NEUTRAL' };
  };
  alignedCount: number;       // 0-3: how many timeframes agree on direction
  direction: 'BULLISH' | 'BEARISH' | 'MIXED';
  strength: 'STRONG' | 'MODERATE' | 'CONFLICTING';
  confidenceBoost: number;    // -0.20 to +0.20
}

// Cache to avoid hammering the API — refresh every 60s
const MTF_CACHE: Record<string, { ts: number; data: MTFConfluence }> = {};
const CACHE_TTL_MS = 60_000;

function deriveTrend(closes: number[]): 'UP' | 'DOWN' | 'NEUTRAL' {
  if (closes.length < 21) return 'NEUTRAL';
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const fast = ema9[ema9.length - 1];
  const slow = ema21[ema21.length - 1];
  const diff = (fast - slow) / slow;
  if (diff > 0.001) return 'UP';
  if (diff < -0.001) return 'DOWN';
  return 'NEUTRAL';
}

export async function getMultiTimeframeConfluence(productId: string): Promise<MTFConfluence> {
  const cached = MTF_CACHE[productId];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const now = Math.floor(Date.now() / 1000);

  // Fetch candles for 3 timeframes concurrently
  const [res5m, res15m, res1h] = await Promise.all([
    getCandles(productId, now - 3600 * 6, now, 'FIVE_MINUTE') as any,    // 6h of 5m = 72 candles
    getCandles(productId, now - 3600 * 12, now, 'FIFTEEN_MINUTE') as any, // 12h of 15m = 48 candles
    getCandles(productId, now - 3600 * 48, now, 'ONE_HOUR') as any,       // 48h of 1h = 48 candles
  ]);

  const parseCloses = (res: any): number[] => {
    const candles = (res?.candles || []).slice().reverse(); // chronological
    return candles.map((c: any) => parseFloat(c.close));
  };

  const closes5m = parseCloses(res5m);
  const closes15m = parseCloses(res15m);
  const closes1h = parseCloses(res1h);

  const tf5m = {
    rsi: closes5m.length > 14 ? calculateRSI(closes5m) : 50,
    trend: deriveTrend(closes5m),
  };
  const tf15m = {
    rsi: closes15m.length > 14 ? calculateRSI(closes15m) : 50,
    trend: deriveTrend(closes15m),
  };
  const tf1h = {
    rsi: closes1h.length > 14 ? calculateRSI(closes1h) : 50,
    trend: deriveTrend(closes1h),
  };

  // Count how many timeframes are bullish vs bearish
  const trends = [tf5m.trend, tf15m.trend, tf1h.trend];
  const bullCount = trends.filter(t => t === 'UP').length;
  const bearCount = trends.filter(t => t === 'DOWN').length;

  let direction: MTFConfluence['direction'] = 'MIXED';
  let alignedCount = 0;
  if (bullCount >= 2) {
    direction = 'BULLISH';
    alignedCount = bullCount;
  } else if (bearCount >= 2) {
    direction = 'BEARISH';
    alignedCount = bearCount;
  } else {
    alignedCount = Math.max(bullCount, bearCount);
  }

  let strength: MTFConfluence['strength'] = 'MODERATE';
  let confidenceBoost = 0;
  if (alignedCount === 3) {
    strength = 'STRONG';
    confidenceBoost = 0.15;
  } else if (alignedCount === 2) {
    strength = 'MODERATE';
    confidenceBoost = 0;
  } else {
    strength = 'CONFLICTING';
    confidenceBoost = -0.15;
  }

  const result: MTFConfluence = {
    timeframes: { '5m': tf5m, '15m': tf15m, '1h': tf1h },
    alignedCount,
    direction,
    strength,
    confidenceBoost,
  };

  MTF_CACHE[productId] = { ts: Date.now(), data: result };
  return result;
}
