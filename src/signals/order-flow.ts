/**
 * Order Flow Imbalance Signal
 * ───────────────────────────
 * OFI = (buy_vol - sell_vol) / total_vol
 * Divergence: price↓ + OFI↑ = hidden accumulation → strong buy
 */

import { OrderFlowState, Signal, MarketRegime } from '../core/types';
import { ORDER_FLOW } from '../core/config';
import { createSignal } from './signal-types';

export function initOrderFlow(): OrderFlowState {
  return {
    buyVolume1m: 0, sellVolume1m: 0,
    buyVolume5m: 0, sellVolume5m: 0,
    buyVolume15m: 0, sellVolume15m: 0,
    ofi1m: 0, ofi5m: 0, ofi15m: 0,
    lastUpdate: Date.now(),
  };
}

function computeOFI(buyVol: number, sellVol: number): number {
  const total = buyVol + sellVol;
  return total > 0 ? (buyVol - sellVol) / total : 0;
}

export function updateOrderFlow(
  state: OrderFlowState,
  isBuy: boolean,
  volumeUsd: number,
): OrderFlowState {
  if (isBuy) {
    state.buyVolume1m += volumeUsd;
    state.buyVolume5m += volumeUsd;
    state.buyVolume15m += volumeUsd;
  } else {
    state.sellVolume1m += volumeUsd;
    state.sellVolume5m += volumeUsd;
    state.sellVolume15m += volumeUsd;
  }
  state.ofi1m = computeOFI(state.buyVolume1m, state.sellVolume1m);
  state.ofi5m = computeOFI(state.buyVolume5m, state.sellVolume5m);
  state.ofi15m = computeOFI(state.buyVolume15m, state.sellVolume15m);
  state.lastUpdate = Date.now();
  return state;
}

/** Reset rolling windows periodically */
export function decayOrderFlow(state: OrderFlowState, now: number): void {
  const elapsed = now - state.lastUpdate;
  if (elapsed > 60_000) {
    state.buyVolume1m *= 0.5;
    state.sellVolume1m *= 0.5;
  }
  if (elapsed > 300_000) {
    state.buyVolume5m *= 0.5;
    state.sellVolume5m *= 0.5;
  }
  if (elapsed > 900_000) {
    state.buyVolume15m *= 0.5;
    state.sellVolume15m *= 0.5;
  }
}

export function generateOrderFlowSignal(
  symbol: string, price: number,
  ofi: OrderFlowState, priceChange5m: number,
  hasPosition: boolean, regime?: MarketRegime,
): Signal | null {
  const totalTrades = ofi.buyVolume5m + ofi.sellVolume5m;
  if (totalTrades < ORDER_FLOW.MIN_SAMPLES) return null;

  // ── Divergence detection ──
  // Price falling but OFI rising = hidden accumulation
  const isDivergenceBuy = priceChange5m < -1 && ofi.ofi5m > ORDER_FLOW.DIVERGENCE_THRESHOLD;
  // Price rising but OFI falling = hidden distribution
  const isDivergenceSell = priceChange5m > 1 && ofi.ofi5m < -ORDER_FLOW.DIVERGENCE_THRESHOLD;

  if (!hasPosition && isDivergenceBuy) {
    let c = 0.6 + Math.min(Math.abs(ofi.ofi5m), 0.3);
    if (regime === MarketRegime.TRENDING_UP) c += 0.05;
    return createSignal('order-flow', 'LONG', Math.min(c, 0.9), symbol, {
      reason: 'divergence-accumulation', ofi5m: ofi.ofi5m,
      priceChange5m, ofi1m: ofi.ofi1m,
    });
  }

  if (hasPosition && isDivergenceSell) {
    let c = 0.6 + Math.min(Math.abs(ofi.ofi5m), 0.3);
    return createSignal('order-flow', 'SHORT', Math.min(c, 0.85), symbol, {
      reason: 'divergence-distribution', ofi5m: ofi.ofi5m,
      priceChange5m,
    });
  }

  // ── Strong directional OFI ──
  if (!hasPosition && ofi.ofi5m > 0.5 && ofi.ofi1m > 0.4) {
    return createSignal('order-flow', 'LONG', 0.55, symbol, {
      reason: 'strong-buying-pressure', ofi5m: ofi.ofi5m, ofi1m: ofi.ofi1m,
    });
  }

  if (hasPosition && ofi.ofi5m < -0.5 && ofi.ofi1m < -0.4) {
    return createSignal('order-flow', 'SHORT', 0.55, symbol, {
      reason: 'strong-selling-pressure', ofi5m: ofi.ofi5m, ofi1m: ofi.ofi1m,
    });
  }

  return null;
}
