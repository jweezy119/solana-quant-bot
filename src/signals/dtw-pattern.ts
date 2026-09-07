/**
 * Dynamic Time Warping (DTW) Pattern Recognition
 * ──────────────────────────────────────────────
 * Measures the geometric distance between live price action
 * and known toxic or explosive fractals.
 */

import { PriceHistory, Signal } from '../core/types';
import { createSignal } from './signal-types';

// Normalized patterns (length 10)
// Values range roughly from 0 to 1
const PATTERNS = {
  // Classic Bart Simpson / Pump and Dump
  BLOW_OFF_TOP: [0.1, 0.2, 0.4, 0.8, 1.0, 0.9, 0.8, 0.4, 0.2, 0.1],
  // Gradual accumulation followed by a sharp breakout
  ACCUMULATION_BREAKOUT: [0.1, 0.15, 0.12, 0.18, 0.15, 0.2, 0.25, 0.5, 0.8, 1.0],
};

const DTW_WINDOW_SIZE = 20;

/**
 * Normalizes a time series to [0, 1] range
 */
function minMaxNormalize(series: number[]): number[] {
  if (series.length === 0) return [];
  let min = series[0];
  let max = series[0];
  for (let i = 1; i < series.length; i++) {
    if (series[i] < min) min = series[i];
    if (series[i] > max) max = series[i];
  }
  const range = max - min;
  if (range === 0) return series.map(() => 0.5);
  return series.map(val => (val - min) / range);
}

/**
 * Computes the Dynamic Time Warping distance between two sequences.
 * Smaller distance = more similar.
 */
function computeDTW(s1: number[], s2: number[]): number {
  const n = s1.length;
  const m = s2.length;
  const dtw: number[][] = Array(n + 1).fill(0).map(() => Array(m + 1).fill(Infinity));

  dtw[0][0] = 0;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = Math.abs(s1[i - 1] - s2[j - 1]);
      dtw[i][j] = cost + Math.min(
        dtw[i - 1][j],    // insertion
        dtw[i][j - 1],    // deletion
        dtw[i - 1][j - 1] // match
      );
    }
  }

  return dtw[n][m];
}

export function generateDtwSignal(
  symbol: string,
  h: PriceHistory,
  hasPosition: boolean
): Signal | null {
  if (h.prices.length < DTW_WINDOW_SIZE) return null;

  // Get the most recent window of prices and normalize
  const recentPrices = h.prices.slice(-DTW_WINDOW_SIZE);
  const normalizedLive = minMaxNormalize(recentPrices);

  let bestMatch = '';
  let minDistance = Infinity;

  for (const [name, pattern] of Object.entries(PATTERNS)) {
    const dist = computeDTW(normalizedLive, pattern);
    // Normalize distance by path length roughly
    const avgDist = dist / Math.max(normalizedLive.length, pattern.length);
    
    if (avgDist < minDistance) {
      minDistance = avgDist;
      bestMatch = name;
    }
  }

  // Thresholds for matching
  const MATCH_THRESHOLD = 0.15; // Requires a very tight geometric match

  if (minDistance < MATCH_THRESHOLD) {
    const confidence = 1.0 - (minDistance / MATCH_THRESHOLD); // 0 to 1 scaling based on how tight the match is

    if (bestMatch === 'BLOW_OFF_TOP' && hasPosition) {
      return createSignal('dtw-pattern', 'SHORT', Math.min(0.9, 0.6 + confidence * 0.3), symbol, {
        reason: 'dtw-blow-off-top-detected',
        distance: minDistance,
      });
    }

    if (bestMatch === 'ACCUMULATION_BREAKOUT' && !hasPosition) {
      return createSignal('dtw-pattern', 'LONG', Math.min(0.85, 0.5 + confidence * 0.35), symbol, {
        reason: 'dtw-accumulation-breakout',
        distance: minDistance,
      });
    }
  }

  return null;
}
