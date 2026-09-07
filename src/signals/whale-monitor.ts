/**
 * Whale Monitor Signal
 * ────────────────────
 * Tracks large wallet transactions via Helius webhooks.
 * Detects cluster buys/sells from smart money wallets.
 * Feature-flagged: disabled when HELIUS_API_KEY not set.
 */

import { Signal, WhaleEvent, SmartMoneyFlow } from '../core/types';
import { WHALE } from '../core/config';
import { createSignal } from './signal-types';

// ============================================================
//  STATE
// ============================================================
const recentEvents: WhaleEvent[] = [];
const MAX_EVENTS = 500;

export function recordWhaleEvent(event: WhaleEvent): void {
  recentEvents.push(event);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
}

// ============================================================
//  SMART MONEY FLOW
// ============================================================
export function computeSmartMoneyFlow(
  token: string,
  windowMs: number,
): SmartMoneyFlow {
  const now = Date.now();
  const cutoff = now - windowMs;
  const relevant = recentEvents.filter(
    e => e.token === token && e.timestamp > cutoff,
  );

  let netFlow = 0;
  let buyCount = 0;
  let sellCount = 0;
  const wallets = new Set<string>();

  for (const e of relevant) {
    wallets.add(e.wallet);
    if (e.direction === 'BUY') {
      netFlow += e.amountUsd;
      buyCount++;
    } else {
      netFlow -= e.amountUsd;
      sellCount++;
    }
  }

  const windowLabel = windowMs <= 30 * 60 * 1000 ? '30m'
    : windowMs <= 60 * 60 * 1000 ? '1h' : '4h';

  return {
    token,
    netFlowUsd: netFlow,
    buyCount,
    sellCount,
    distinctWallets: wallets.size,
    window: windowLabel as '30m' | '1h' | '4h',
    isClusterBuy: buyCount >= WHALE.CLUSTER_MIN_WALLETS && wallets.size >= WHALE.CLUSTER_MIN_WALLETS,
    isClusterSell: sellCount >= WHALE.CLUSTER_MIN_WALLETS && wallets.size >= WHALE.CLUSTER_MIN_WALLETS,
  };
}

// ============================================================
//  SIGNAL
// ============================================================
export function generateWhaleSignal(
  symbol: string, hasPosition: boolean,
): Signal | null {
  const flow = computeSmartMoneyFlow(symbol, WHALE.CLUSTER_WINDOW_MS);

  if (flow.isClusterBuy && !hasPosition) {
    const confidence = 0.6 + Math.min(flow.distinctWallets / 10, 0.3);
    return createSignal('whale-monitor', 'LONG', confidence, symbol, {
      reason: 'cluster-buy',
      netFlowUsd: flow.netFlowUsd,
      distinctWallets: flow.distinctWallets,
      buyCount: flow.buyCount,
    });
  }

  if (flow.isClusterSell && hasPosition) {
    const confidence = 0.6 + Math.min(flow.distinctWallets / 10, 0.3);
    return createSignal('whale-monitor', 'SHORT', confidence, symbol, {
      reason: 'cluster-sell',
      netFlowUsd: flow.netFlowUsd,
      distinctWallets: flow.distinctWallets,
      sellCount: flow.sellCount,
    });
  }

  return null;
}
