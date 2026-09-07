/**
 * Bayesian Signal Fusion Engine
 * ─────────────────────────────
 * Combines all signal sources into a single TradeDecision.
 * Uses regime-dependent weights, exponential decay, and minimum confluence.
 */

import {
  Signal, TradeDecision, TradeAction, MarketRegime,
  TokenInfo, RegimeState, SignalSource,
} from '../core/types';
import {
  FUSION_WEIGHTS, FUSION_MIN_AGREEING_SIGNALS,
  FUSION_MIN_CONFIDENCE, FEATURES, RegimeWeights,
} from '../core/config';
import { bayesianUpdate, decayWeight, shannonEntropy } from '../signals/signal-types';

/**
 * Fuse multiple signals into a single trade decision.
 */
export function fuseSignals(
  signals: Signal[],
  token: TokenInfo,
  regime: MarketRegime,
  hasPosition: boolean,
  entryPrice?: number,
): TradeDecision | null {
  if (signals.length === 0) return null;

  // Get regime-specific weights
  const weights = FUSION_WEIGHTS[regime];

  // Separate by direction
  const longSignals = signals.filter(s => s.direction === 'LONG');
  const shortSignals = signals.filter(s => s.direction === 'SHORT');
  const neutralSignals = signals.filter(s => s.direction === 'NEUTRAL');

  // ── Compute weighted confidence per direction ──
  const longScore = computeDirectionalScore(longSignals, weights);
  const shortScore = computeDirectionalScore(shortSignals, weights);

  // ── Confluence gate: minimum agreeing signals ──
  const longCount = longSignals.length;
  const shortCount = shortSignals.length;

  // ── Shannon Entropy: measure uncertainty ──
  const totalSignals = signals.length;
  const pLong = longCount / totalSignals;
  const pShort = shortCount / totalSignals;
  const pNeutral = neutralSignals.length / totalSignals;
  const entropy = shannonEntropy([pLong, pShort, pNeutral].filter(p => p > 0));
  const maxEntropy = Math.log2(3); // max for 3 outcomes
  const normalizedEntropy = entropy / maxEntropy; // 0 = certain, 1 = max uncertainty

  // ── Decision logic ──
  let action: TradeAction = 'HOLD';
  let confidence = 0;
  let relevantSignals: Signal[] = [];
  let reason = '';

  // ── Hard Exit Override (Stop Loss / Take Profit / Pyramiding) ──
  if (hasPosition) {
    const pyramidAdd = longSignals.find(s => s.metadata?.isAdd);
    if (pyramidAdd) {
      return {
        action: 'BUY',
        token: token.symbol,
        tokenInfo: token,
        positionSizeUsdc: 0,
        stopLossPct: 0,
        takeProfitPct: 0,
        trailingStopPct: 0,
        confidence: pyramidAdd.confidence,
        entropy: 0,
        signals: [pyramidAdd],
        regime,
        reason: (pyramidAdd.metadata?.reason as string) || 'Pyramid Add',
      } as any;
    }

    const hardExit = shortSignals.find(s => {
      const reason = (s.metadata?.reason as string || '').toLowerCase();
      return reason.includes('risk-manager') || reason.includes('stop') || s.metadata?.isPartial;
    });
    if (hardExit) {
      action = hardExit.metadata?.isPartial ? 'PARTIAL_SELL' : 'SELL';
      return {
        action,
        token: token.symbol,
        tokenInfo: token,
        positionSizeUsdc: 0,
        stopLossPct: 0,
        takeProfitPct: 0,
        trailingStopPct: 0,
        confidence: hardExit.confidence,
        entropy: 0, // Hard exits don't care about entropy
        signals: [hardExit],
        regime,
        reason: (hardExit.metadata?.reason as string) || 'Hard Exit',
        partialFraction: hardExit.metadata?.partialFraction as number,
      } as any;
    }
  }

  if (!hasPosition && longScore > shortScore && longCount >= FUSION_MIN_AGREEING_SIGNALS) {
    action = 'BUY';
    confidence = longScore * (1 - normalizedEntropy * 0.3); // penalize uncertain environments
    relevantSignals = longSignals;
    reason = `${longCount} signals agree LONG (entropy: ${normalizedEntropy.toFixed(2)})`;
  } else if (hasPosition && shortScore > longScore && shortCount >= 2) {
    // Lower bar for exits (2 signals enough)
    action = 'SELL';
    confidence = shortScore;
    relevantSignals = shortSignals;
    reason = `${shortCount} signals agree SHORT`;
  }

  // ── Minimum confidence gate ──
  if (confidence < FUSION_MIN_CONFIDENCE && action === 'BUY') {
    return null; // not confident enough to enter
  }

  // ── Volatility Gate (Do not buy if ATR > 8%) ──
  if (action === 'BUY') {
    const emaSignal = signals.find(s => s.source === 'ema-atr');
    const currentAtr = (emaSignal?.metadata?.atr as number) ?? 2.0;
    if (currentAtr > 8.0) {
      return null;
    }
  }

  if (action === 'HOLD') return null;

  // ── Build decision ──
  return {
    action,
    token: token.symbol,
    tokenInfo: token,
    positionSizeUsdc: 0, // filled by Kelly sizer
    stopLossPct: 2.0,    // filled by risk manager
    takeProfitPct: 4.0,
    trailingStopPct: 1.5,
    confidence,
    entropy: normalizedEntropy,
    signals: relevantSignals,
    regime,
    reason,
  };
}

/**
 * Compute weighted confidence score for a set of directional signals.
 * Uses Bayesian updating: start with 0.5 prior, update with each signal.
 */
function computeDirectionalScore(
  signals: Signal[],
  weights: RegimeWeights,
): number {
  if (signals.length === 0) return 0;

  let posterior = 0.5; // neutral prior

  for (const signal of signals) {
    const weight = weights[signal.source] ?? 0.1;
    const decay = decayWeight(signal.timestamp, 30_000); // 30s half-life
    const adjustedConfidence = signal.confidence * weight * decay;

    // Bayesian update: if signal says LONG with confidence c,
    // likelihood ratio is c : (1-c)
    const likelihoodTrue = 0.5 + adjustedConfidence;
    const likelihoodFalse = 0.5 - adjustedConfidence * 0.3;

    posterior = bayesianUpdate(posterior, likelihoodTrue, likelihoodFalse);
  }

  return posterior;
}
