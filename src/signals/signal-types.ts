/**
 * Signal Types & Helpers
 * ──────────────────────
 * Shared signal interface and confidence math.
 */

import { Signal, SignalSource, SignalDirection } from '../core/types';

/**
 * Create a signal with standardized shape
 */
export function createSignal(
  source: SignalSource,
  direction: SignalDirection,
  confidence: number,
  token: string,
  metadata: Record<string, unknown> = {},
): Signal {
  return {
    source,
    direction,
    confidence: Math.max(0, Math.min(1, confidence)), // clamp 0–1
    token,
    timestamp: Date.now(),
    metadata,
  };
}

/**
 * Exponential decay weighting: recent signals matter more.
 * halfLifeMs = time after which a signal's weight drops to 50%.
 */
export function decayWeight(signalTimestamp: number, halfLifeMs = 30_000): number {
  const age = Date.now() - signalTimestamp;
  return Math.pow(0.5, age / halfLifeMs);
}

/**
 * Bayesian confidence update.
 * Given a prior probability and new evidence (likelihood ratio),
 * compute the posterior probability.
 *
 * P(H|E) = P(E|H) × P(H) / [P(E|H) × P(H) + P(E|¬H) × P(¬H)]
 */
export function bayesianUpdate(
  prior: number,
  likelihoodIfTrue: number,
  likelihoodIfFalse: number,
): number {
  const numerator = likelihoodIfTrue * prior;
  const denominator = numerator + likelihoodIfFalse * (1 - prior);
  if (denominator === 0) return prior;
  return numerator / denominator;
}

/**
 * Shannon entropy of a probability distribution.
 * High entropy = high uncertainty = reduce position size.
 * H = -Σ p_i × log2(p_i)
 */
export function shannonEntropy(probabilities: number[]): number {
  let h = 0;
  for (const p of probabilities) {
    if (p > 0 && p < 1) {
      h -= p * Math.log2(p);
    }
  }
  return h;
}

/**
 * Z-score: how many standard deviations a value is from the mean.
 */
export function zScore(value: number, mean: number, stdDev: number): number {
  if (stdDev === 0) return 0;
  return (value - mean) / stdDev;
}

/**
 * Standard deviation of an array
 */
export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Simple moving average
 */
export function sma(values: number[], period?: number): number {
  const slice = period ? values.slice(-period) : values;
  if (slice.length === 0) return 0;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}
