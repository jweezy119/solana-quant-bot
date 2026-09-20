import { IStrategy } from './base-strategy';
import { AIOrderProposal } from '../coinbase/risk-manager';
import { getTechnicalSignal } from '../coinbase/signals';
import { getLiveMetrics } from '../coinbase/websocket';

export class MeanReversionStrategy implements IStrategy {
  name = 'MEAN_REVERSION';
  description = 'Bollinger Bands + RSI + Live Order Flow Imbalance';

  async evaluate(productId: string): Promise<AIOrderProposal | null> {
    try {
      const tech = await getTechnicalSignal(productId);
      const liveMetrics = getLiveMetrics(productId);
      const currentPrice = liveMetrics && liveMetrics.price > 0 ? liveMetrics.price : tech.currentPrice;
      const ofiImbalance = liveMetrics?.imbalance || 0;

      const bbLower = tech.bollingerLower;
      const bbUpper = tech.bollingerUpper;
      
      if (!bbLower || !bbUpper) return null;

      // BUY Logic
      const isPiercingLowerBB = currentPrice <= bbLower * 1.005; // Within 0.5% or below
      const isOversoldRSI = tech.rsi < 35;
      const isBidSteppingIn = ofiImbalance > 0.05; // Bid-side OFI means buyers are stepping in

      if (isPiercingLowerBB && isOversoldRSI && isBidSteppingIn) {
        return {
          productId,
          action: 'BUY',
          confidence: 0.88,
          reasoning: `[MEAN-REVERSION] Pierced lower BB ($${bbLower.toFixed(4)}), RSI oversold (${tech.rsi.toFixed(1)}), OFI bid-side surge (+${(ofiImbalance * 100).toFixed(0)}%). Reversal imminent.`,
          strategy: this.name,
          atrPct: tech.atrPct
        };
      }

      // SELL Logic
      const isPiercingUpperBB = currentPrice >= bbUpper * 0.995;
      const isOverboughtRSI = tech.rsi > 65;
      const isAskSteppingIn = ofiImbalance < -0.05;

      if (isPiercingUpperBB && isOverboughtRSI && isAskSteppingIn) {
        return {
          productId,
          action: 'SELL',
          confidence: 0.88,
          reasoning: `[MEAN-REVERSION] Pierced upper BB ($${bbUpper.toFixed(4)}), RSI overbought (${tech.rsi.toFixed(1)}), OFI ask-side surge (${(ofiImbalance * 100).toFixed(0)}%). Reversing down.`,
          strategy: this.name,
          atrPct: tech.atrPct
        };
      }

      return null;
    } catch (err: any) {
      return null;
    }
  }
}
