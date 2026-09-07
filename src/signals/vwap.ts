/**
 * VWAP Deviation Signal
 * ─────────────────────
 * Buy below VWAP (discount), sell above (premium).
 */

import { PriceHistory, Signal, MarketRegime } from '../core/types';
import { VWAP as VWAP_CFG } from '../core/config';
import { createSignal } from './signal-types';

export function computeVWAP(prices: number[], volumes: number[]): number {
  let totalPV = 0, totalV = 0;
  for (let i = 0; i < prices.length; i++) {
    const v = volumes[i] || 1;
    totalPV += prices[i] * v;
    totalV += v;
  }
  return totalV > 0 ? totalPV / totalV : prices[prices.length - 1];
}

function vwapStdDev(prices: number[], vwap: number): number {
  if (prices.length < 2) return 0;
  const meanSq = prices.reduce((s, p) => s + (p - vwap) ** 2, 0) / prices.length;
  return Math.sqrt(meanSq);
}

export function generateVwapSignal(
  symbol: string, price: number, h: PriceHistory,
  hasPosition: boolean, regime?: MarketRegime,
): Signal | null {
  if (h.prices.length < 10) return null;
  const vwap = computeVWAP(h.prices, h.volumes);
  const dev = ((price - vwap) / vwap) * 100;
  const absDev = Math.abs(dev);
  if (absDev < VWAP_CFG.MIN_DEVIATION_PCT) return null;

  const sd = vwapStdDev(h.prices, vwap);
  const devSigma = sd > 0 ? (price - vwap) / sd : 0;

  if (hasPosition && dev > VWAP_CFG.MIN_DEVIATION_PCT) {
    let c = 0.4 + Math.min(absDev / 4, 0.4);
    if (devSigma > 2) c += 0.1;
    return createSignal('vwap', 'SHORT', Math.min(c, 0.85), symbol,
      { reason: 'above-vwap', dev, devSigma, vwap });
  }

  if (!hasPosition && dev < -VWAP_CFG.MIN_DEVIATION_PCT) {
    let c = 0.4 + Math.min(absDev / 4, 0.4);
    if (devSigma < -2) c += 0.15;
    if (regime === MarketRegime.TRENDING_DOWN) c -= 0.15;
    if (regime === MarketRegime.MEAN_REVERTING) c += 0.1;
    return createSignal('vwap', 'LONG', Math.min(c, 0.9), symbol,
      { reason: 'below-vwap', dev, devSigma, vwap });
  }
  return null;
}
