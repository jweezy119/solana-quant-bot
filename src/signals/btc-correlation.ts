/**
 * BTC Correlation Filter
 * ──────────────────────
 * Monitors BTC's real-time 15m trend. When BTC is in active decline
 * (EMA9 < EMA21 AND RSI < 45), all alt BUYs are blocked.
 * BTC-USDC itself is exempt from this filter.
 */

import { getCandles } from '../coinbase/client';
import { calculateRSI, calculateEMA } from '../coinbase/signals';

export interface BtcCorrelationState {
  btcPrice: number;
  btcRsi: number;
  btcTrend: 'UP' | 'DOWN' | 'NEUTRAL';
  isSafe: boolean;       // true = alts can buy; false = BTC dumping, block alt buys
  reason: string;
}

// Cache — refresh every 45s (fast enough to catch dumps, slow enough to not spam)
let BTC_STATE_CACHE: { ts: number; data: BtcCorrelationState } | null = null;
const BTC_CACHE_TTL_MS = 45_000;

export async function getBtcCorrelationState(): Promise<BtcCorrelationState> {
  if (BTC_STATE_CACHE && Date.now() - BTC_STATE_CACHE.ts < BTC_CACHE_TTL_MS) {
    return BTC_STATE_CACHE.data;
  }

  const now = Math.floor(Date.now() / 1000);

  try {
    const res = (await getCandles('BTC-USDC', now - 3600 * 12, now, 'FIFTEEN_MINUTE')) as any;
    const candles = (res?.candles || []).slice().reverse(); // chronological
    const closes = candles.map((c: any) => parseFloat(c.close));

    if (closes.length < 21) {
      const safe: BtcCorrelationState = {
        btcPrice: closes.length > 0 ? closes[closes.length - 1] : 0,
        btcRsi: 50,
        btcTrend: 'NEUTRAL',
        isSafe: true,
        reason: 'Insufficient BTC candle data — fail-open',
      };
      BTC_STATE_CACHE = { ts: Date.now(), data: safe };
      return safe;
    }

    const btcPrice = closes[closes.length - 1];
    const btcRsi = calculateRSI(closes);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const fast = ema9[ema9.length - 1];
    const slow = ema21[ema21.length - 1];

    let btcTrend: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    const diff = (fast - slow) / slow;
    if (diff > 0.001) btcTrend = 'UP';
    if (diff < -0.001) btcTrend = 'DOWN';

    // BTC is "unsafe" for alt buys when:
    // 1. EMA9 < EMA21 (short-term trend below long-term) AND
    // 2. RSI < 45 (confirming weakness, not just a brief cross)
    const isDumping = btcTrend === 'DOWN' && btcRsi < 45;

    const state: BtcCorrelationState = {
      btcPrice,
      btcRsi,
      btcTrend,
      isSafe: !isDumping,
      reason: isDumping
        ? `BTC dumping: RSI ${btcRsi.toFixed(1)}, EMA9 < EMA21 (${fast.toFixed(0)} < ${slow.toFixed(0)})`
        : `BTC stable: RSI ${btcRsi.toFixed(1)}, trend ${btcTrend}`,
    };

    BTC_STATE_CACHE = { ts: Date.now(), data: state };
    return state;
  } catch {
    // Fail-open: a BTC API error should not halt all trading
    const safe: BtcCorrelationState = {
      btcPrice: 0,
      btcRsi: 50,
      btcTrend: 'NEUTRAL',
      isSafe: true,
      reason: 'BTC candle fetch failed — fail-open',
    };
    BTC_STATE_CACHE = { ts: Date.now(), data: safe };
    return safe;
  }
}

/**
 * Quick check: is it safe to buy alts right now?
 * BTC-USDC itself is always exempt.
 */
export async function isBtcCorrelationSafe(productId: string): Promise<{ safe: boolean; reason: string }> {
  // BTC itself is exempt from the BTC correlation filter
  if (productId.startsWith('BTC-')) {
    return { safe: true, reason: 'BTC exempt from correlation filter' };
  }

  const state = await getBtcCorrelationState();
  return { safe: state.isSafe, reason: state.reason };
}
