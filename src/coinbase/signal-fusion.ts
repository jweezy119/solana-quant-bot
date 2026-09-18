/**
 * Signal Fusion & AI Proposal Engine
 * ──────────────────────────────────
 * Fuses Technical Indicators (RSI, EMA, ATR, Bollinger),
 * Social Media & Twitter sentiment, and Cross-Exchange Arbitrage
 * into a single high-conviction order proposal.
 */

import { TechnicalSignal, getTechnicalSignal } from './signals';
import { SocialSentiment, getSocialSentiment } from './social-feed';
import { ArbitrageSignal, checkArbitrage } from './arbitrage';
import { AIOrderProposal, getSocialEfficacy, QUANT_CONFIG } from './risk-manager';
import { initMLPredictor, generateMLSignal } from '../signals/ml-predictor';
import { getMultiTimeframeConfluence } from '../signals/multi-timeframe';
import { isBtcCorrelationSafe } from '../signals/btc-correlation';

let mlInitialized = false;

export interface FusedSignalResult {
  proposal: AIOrderProposal;
  technical: TechnicalSignal;
  social: SocialSentiment;
  arbitrage: ArbitrageSignal;
}

import { getLiveMetrics } from './websocket';

/**
 * Fuse Technical, Social, and Arbitrage signals for a Coinbase product
 */
export async function fuseSignals(productId: string): Promise<FusedSignalResult> {
  const token = productId.split('-')[0];

  // Concurrently fetch technical indicators, social sentiment, and arbitrage
  const [tech, social] = await Promise.all([
    getTechnicalSignal(productId),
    getSocialSentiment(token),
  ]);

  // If websocket is live, use the websocket price, else use REST price
  const liveMetrics = getLiveMetrics(productId);
  if (liveMetrics && liveMetrics.price > 0) {
    tech.currentPrice = liveMetrics.price;
  }
  
  // Check arbitrage using the live price
  const arbitrage = await checkArbitrage(productId, tech.currentPrice);

  if (!mlInitialized) {
    await initMLPredictor();
    mlInitialized = true;
  }

  const ofiImbalance = liveMetrics?.imbalance || 0;
  
  // Get ML Prediction
  const mlSignal = generateMLSignal(token, tech.currentPrice, tech.history, false, undefined, 0.5, ofiImbalance);

  const reasons: string[] = [];
  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let fusedConfidence = 0.5;

  // Weightings updated to include Order Flow Imbalance (OFI) and Dynamic Social Efficacy
  const TECH_WEIGHT = 0.40;
  const socialEfficacy = getSocialEfficacy();
  const SOCIAL_WEIGHT = 0.20 * socialEfficacy.multiplier;
  const ARB_WEIGHT = 0.20;
  const OFI_WEIGHT = 0.20;

  const isBearRegime = process.env.COINBASE_REGIME !== 'BULL';

  // Map directions to numeric scores (-1.0 to +1.0)
  const techScore = tech.direction === 'BUY' ? 1.0 : tech.direction === 'SELL' ? -1.0 : 0.0;
  const arbScore = arbitrage.direction === 'BUY_DISCOUNT' ? 1.0 : arbitrage.direction === 'SELL_PREMIUM' ? -1.0 : 0.0;

  // 1. Triple Confluence (Tech BUY + Social BULLISH + Arb DISCOUNT)
  if (tech.direction === 'BUY' && social.direction === 'BULLISH' && arbitrage.direction === 'BUY_DISCOUNT') {
    action = 'BUY';
    fusedConfidence = 0.95;
    reasons.push(`🔥 TRIPLE CONFLUENCE: Tech Buy + Twitter/Social Bullish (${social.score.toFixed(2)}) + Arb Discount (${arbitrage.spreadPct}%)`);
  }
  // 2. Tech BUY + Social BULLISH (Strong momentum setup)
  else if (tech.direction === 'BUY' && social.direction === 'BULLISH') {
    action = 'BUY';
    fusedConfidence = Math.min(0.92, (tech.confidence * TECH_WEIGHT + social.confidence * SOCIAL_WEIGHT) + 0.15);
    reasons.push(`🚀 Bullish Confluence: Tech Buy (${tech.reasoning}) + Social Bullish (${social.score.toFixed(2)})`);
  }
  // 3. Mathematical Lead-Lag Arbitrage (Kalman Filter Z-Score & Micro-Price OFI)
  else if (arbitrage.direction === 'BUY_DISCOUNT' && tech.direction !== 'SELL') {
    action = 'BUY';
    fusedConfidence = Math.min(0.95, arbitrage.confidence);
    reasons.push(arbitrage.reasoning);
  }
  // 4. Extreme Order Flow Imbalance (Front-running the tape)
  // Bear-regime trap filter: buying a bid-side order-flow surge into a product with
  // NEUTRAL technicals is how you catch bull-traps (TROLL class). In bear mode the
  // OFI surge alone is not enough — technicals must also be BUY.
  else if (ofiImbalance >= 0.45 && (isBearRegime ? tech.direction === 'BUY' : tech.direction !== 'SELL')) {
    action = 'BUY';
    fusedConfidence = 0.88;
    reasons.push(`🌊 ORDER FLOW SURGE: Massive bid-side limit order imbalance (${(ofiImbalance * 100).toFixed(1)}%) detected on L2 orderbook`);
  }
  else if (ofiImbalance <= -0.45 && tech.direction !== 'BUY') {
    action = 'SELL';
    fusedConfidence = 0.88;
    reasons.push(`🚨 ORDER FLOW DUMP: Massive ask-side limit order imbalance (${(ofiImbalance * 100).toFixed(1)}%) detected on L2 orderbook`);
  }
  // 5. Tech BUY but Social is BEARISH (Trap / FUD filter)
  else if (tech.direction === 'BUY' && social.direction === 'BEARISH') {
    action = 'HOLD';
    fusedConfidence = Math.max(0.40, tech.confidence - 0.25);
    reasons.push(`⚠️ Tech buy suppressed: Twitter/Social sentiment is Bearish (${social.score.toFixed(2)})`);
  }
  // 6. Tech SELL + Social BEARISH (Confluent breakdown / exit)
  else if (tech.direction === 'SELL' && social.direction === 'BEARISH') {
    action = 'SELL';
    fusedConfidence = Math.min(0.95, (tech.confidence * TECH_WEIGHT + social.confidence * SOCIAL_WEIGHT) + 0.15);
    reasons.push(`🔻 Bearish Confluence: Tech Breakdown (${tech.reasoning}) + Social Bearish (${social.score.toFixed(2)})`);
  }
  // 7. Overpriced Lead-Lag Premium (Mathematical Kalman Z-Score)
  else if (arbitrage.direction === 'SELL_PREMIUM') {
    action = 'SELL';
    fusedConfidence = Math.min(0.95, arbitrage.confidence);
    reasons.push(arbitrage.reasoning);
  }
  // 8. High Conviction Technical Setup with neutral sentiment
  else if (tech.direction === 'BUY' && tech.confidence >= 0.70) {
    action = 'BUY';
    fusedConfidence = tech.confidence * 0.88;
    reasons.push(`📈 Technical Dip/Breakout (${tech.reasoning}) | Social & Arb Neutral`);
  }
  // 9. High Conviction Technical Breakdown
  else if (tech.direction === 'SELL' && tech.confidence >= 0.70) {
    action = 'SELL';
    fusedConfidence = tech.confidence * 0.88;
    reasons.push(`📉 Technical Overbought/Breakdown (${tech.reasoning}) | Social & Arb Neutral`);
  }
  // 10. Default HOLD
  else {
    action = 'HOLD';
    fusedConfidence = 0.50;
    reasons.push(`⚖️ Rangebound. RSI: ${tech.rsi}, Trend: ${tech.trend}, Arb: ${arbitrage.spreadPct}%, Social: ${social.score.toFixed(2)}`);
  }

  // Adjust confidence dynamically using live OFI flow (pure math)
  if (action === 'BUY' && ofiImbalance > 0.15) {
    fusedConfidence = Math.min(1.0, fusedConfidence + (ofiImbalance * 0.2));
    reasons[0] += ` [+OFI Boost]`;
  } else if (action === 'SELL' && ofiImbalance < -0.15) {
    fusedConfidence = Math.min(1.0, fusedConfidence + (Math.abs(ofiImbalance) * 0.2));
    reasons[0] += ` [+OFI Boost]`;
  }

  // 11. War Panic / Liquidation Cascade Freeze
  if (action === 'BUY' && social.isWarPanicCascade) {
    action = 'HOLD';
    fusedConfidence = 0.40;
    reasons.unshift('🛑 WAR PANIC FREEZE: Active geopolitical conflict/escalation headlines — knife-catch frozen');
  }

  // 12. ATR Volatility Filter (Must move enough to cover fees)
  const minAtrPct = QUANT_CONFIG.makerFeeRate * 100 * 3.0; // Need 3x the maker fee in volatility
  if (action === 'BUY' && tech.atrPct < minAtrPct) {
    action = 'HOLD';
    fusedConfidence = 0.40;
    reasons.unshift(`🛑 VOLATILITY FILTER: ATR (${tech.atrPct.toFixed(2)}%) < Minimum required (${minAtrPct.toFixed(2)}%) to clear fees`);
  }

  // 13. RSI Overbought Filter (Prevent buying the absolute top)
  if (action === 'BUY' && tech.rsi > 65) {
    action = 'HOLD';
    fusedConfidence = 0.40;
    reasons.unshift(`🛑 OVERBOUGHT FILTER: RSI (${tech.rsi.toFixed(2)}) > 65. Refusing to buy local top.`);
  }

  // 14. ML Predictor Override
  if (mlSignal) {
    if (action === 'BUY' && mlSignal.direction === 'SHORT') {
      action = 'HOLD';
      fusedConfidence = 0.40;
      reasons.unshift(`🛑 ML OVERRIDE: TensorFlow model predicts dump (P_Down: ${mlSignal.metadata.pDown}). Cancelling BUY.`);
    } else if (action === 'HOLD' && mlSignal.direction === 'LONG' && tech.direction === 'BUY') {
      action = 'BUY';
      fusedConfidence = Math.min(1.0, fusedConfidence + 0.2);
      reasons.unshift(`🤖 ML BOOST: TensorFlow model confirms pump (P_Up: ${mlSignal.metadata.pUp}).`);
    }
  }

  // 15. BTC Correlation Gate — block alt buys when BTC is dumping
  if (action === 'BUY') {
    const btcCheck = await isBtcCorrelationSafe(productId);
    if (!btcCheck.safe) {
      action = 'HOLD';
      fusedConfidence = 0.35;
      reasons.unshift(`🛑 BTC CORRELATION: ${btcCheck.reason}. Blocking alt BUY.`);
    }
  }

  // 16. Multi-Timeframe Confluence — boost or block based on 5m/15m/1h alignment
  if (action === 'BUY' || action === 'SELL') {
    try {
      const mtf = await getMultiTimeframeConfluence(productId);
      const mtfTag = `📊 MTF: ${mtf.alignedCount}/3 ${mtf.strength} (5m:${mtf.timeframes['5m'].trend} 15m:${mtf.timeframes['15m'].trend} 1h:${mtf.timeframes['1h'].trend})`;

      if (action === 'BUY' && mtf.strength === 'CONFLICTING') {
        action = 'HOLD';
        fusedConfidence = 0.40;
        reasons.unshift(`🛑 ${mtfTag} — Timeframes disagree, blocking BUY.`);
      } else if (action === 'BUY' && mtf.direction === 'BEARISH') {
        action = 'HOLD';
        fusedConfidence = 0.40;
        reasons.unshift(`🛑 ${mtfTag} — Higher timeframes bearish, blocking BUY.`);
      } else if (mtf.strength === 'STRONG') {
        fusedConfidence = Math.min(1.0, fusedConfidence + mtf.confidenceBoost);
        reasons.push(`✅ ${mtfTag}`);
      } else {
        reasons.push(mtfTag);
      }
    } catch {
      // Fail-open: MTF fetch failure should not block trading
      reasons.push('📊 MTF: unavailable (fail-open)');
    }
  }

  const proposal: AIOrderProposal = {
    productId,
    action,
    confidence: parseFloat(fusedConfidence.toFixed(2)),
    reasoning: reasons.join('; '),
    atrPct: tech.atrPct,
  };

  return {
    proposal,
    technical: tech,
    social,
    arbitrage,
  };
}
