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
import { AIOrderProposal } from './risk-manager';

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

  const reasons: string[] = [];
  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let fusedConfidence = 0.5;

  // Weightings updated to include Order Flow Imbalance (OFI)
  const TECH_WEIGHT = 0.40;
  const SOCIAL_WEIGHT = 0.20;
  const ARB_WEIGHT = 0.20;
  const OFI_WEIGHT = 0.20;

  const ofiImbalance = liveMetrics?.imbalance || 0;
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
