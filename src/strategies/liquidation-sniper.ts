import { IStrategy } from './base-strategy';
import { AIOrderProposal } from '../coinbase/risk-manager';
import { getTechnicalSignal } from '../coinbase/signals';

export class LiquidationSniperStrategy implements IStrategy {
  name = 'LIQUIDATION_SNIPER';
  description = 'Catches massive flash-crash wicks by providing liquidity during capitulation cascades';

  async evaluate(productId: string): Promise<AIOrderProposal | null> {
    try {
      const tech = await getTechnicalSignal(productId);
      
      // We look for absolute blood in the streets.
      // 1. RSI must be completely flushed (< 22)
      // 2. Price must be deeply pierced through the lower Bollinger Band (> 3% below the band)
      
      const pierceDepthPct = ((tech.bollingerLower - tech.currentPrice) / tech.bollingerLower) * 100;

      if (tech.rsi < 22 && pierceDepthPct > 3.0) {
        return {
          productId,
          action: 'BUY',
          confidence: 0.98, // Massive confidence to hijack the capital router
          reasoning: `[LIQUIDATION-SNIPER] Flash crash detected! RSI flushed to ${tech.rsi.toFixed(1)}. Price pierced lower BB by ${pierceDepthPct.toFixed(1)}%. Buying the blood.`,
          strategy: this.name,
          atrPct: tech.atrPct, // Pass volatility to risk manager for stop placement
        };
      }

      return null;
    } catch (err) {
      return null;
    }
  }
}
