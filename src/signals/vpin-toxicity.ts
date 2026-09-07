/**
 * VPIN (Volume-Synchronized Probability of Informed Trading)
 * ──────────────────────────────────────────────────────────
 * Measures order flow toxicity by analyzing trade imbalance
 * across constant volume buckets instead of time periods.
 * High VPIN indicates informed traders (whales) are aggressively
 * taking liquidity, foreshadowing a sharp price move.
 */

import { Signal, MarketRegime } from '../core/types';
import { createSignal } from './signal-types';

const VPIN_BUCKET_VOLUME_USD = 10_000; // $10k per bucket
const VPIN_NUM_BUCKETS = 10;           // Rolling window of 10 buckets

interface VpinBucket {
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
}

export interface VpinState {
  currentBucket: VpinBucket;
  history: VpinBucket[];
  vpinValue: number;
}

export function initVpin(): VpinState {
  return {
    currentBucket: { buyVolume: 0, sellVolume: 0, totalVolume: 0 },
    history: [],
    vpinValue: 0,
  };
}

/**
 * Update VPIN state with new volume data
 */
export function updateVpin(state: VpinState, buyVolume: number, sellVolume: number): VpinState {
  const total = buyVolume + sellVolume;
  if (total === 0) return state;

  state.currentBucket.buyVolume += buyVolume;
  state.currentBucket.sellVolume += sellVolume;
  state.currentBucket.totalVolume += total;

  // If bucket is full, push to history and create new bucket
  if (state.currentBucket.totalVolume >= VPIN_BUCKET_VOLUME_USD) {
    state.history.push({ ...state.currentBucket });
    if (state.history.length > VPIN_NUM_BUCKETS) {
      state.history.shift();
    }
    
    // Calculate VPIN
    // VPIN = SUM(|Buy - Sell|) / SUM(Total)
    let sumImbalance = 0;
    let sumTotal = 0;
    for (const b of state.history) {
      sumImbalance += Math.abs(b.buyVolume - b.sellVolume);
      sumTotal += b.totalVolume;
    }
    
    state.vpinValue = sumTotal > 0 ? sumImbalance / sumTotal : 0;
    
    // Reset current bucket (carry over excess if necessary, but simple reset is fine for approximation)
    state.currentBucket = { buyVolume: 0, sellVolume: 0, totalVolume: 0 };
  }

  return state;
}

/**
 * Generate VPIN Toxicity Signal
 */
export function generateVpinSignal(
  symbol: string,
  state: VpinState,
  hasPosition: boolean,
): Signal | null {
  // Wait until we have enough history
  if (state.history.length < Math.floor(VPIN_NUM_BUCKETS / 2)) {
    return null;
  }

  const vpin = state.vpinValue;

  // VPIN > 0.7 means 70% of the volume in the last N buckets was completely one-sided.
  // This is highly toxic order flow.
  const TOXICITY_THRESHOLD = 0.75;
  const EXTREME_TOXICITY = 0.85;

  if (vpin >= EXTREME_TOXICITY) {
    // If toxicity is extreme, get out regardless of direction (market is about to snap)
    if (hasPosition) {
      return createSignal('vpin-toxicity', 'SHORT', 0.95, symbol, {
        reason: 'extreme-toxicity-detected',
        vpin,
      });
    } else {
      // Don't enter during extreme toxicity
      return createSignal('vpin-toxicity', 'NEUTRAL', 0.8, symbol, {
        reason: 'market-too-toxic-to-enter',
        vpin,
      });
    }
  }

  if (vpin >= TOXICITY_THRESHOLD) {
    // Determine the direction of the toxicity
    const recentImbalance = state.history.reduce((acc, b) => acc + (b.buyVolume - b.sellVolume), 0);
    
    if (recentImbalance < 0 && hasPosition) {
      // Toxic selling
      return createSignal('vpin-toxicity', 'SHORT', 0.8, symbol, {
        reason: 'toxic-distribution',
        vpin,
        recentImbalance,
      });
    }
    
    if (recentImbalance > 0 && !hasPosition) {
      // Toxic buying (institutional accumulation)
      return createSignal('vpin-toxicity', 'LONG', 0.7, symbol, {
        reason: 'toxic-accumulation',
        vpin,
        recentImbalance,
      });
    }
  }

  return null;
}
