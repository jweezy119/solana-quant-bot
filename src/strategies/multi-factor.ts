import { IStrategy } from './base-strategy';
import { AIOrderProposal } from '../coinbase/risk-manager';
import { fuseSignals } from '../coinbase/signal-fusion';

export class MultiFactorStrategy implements IStrategy {
  name = 'MULTI_FACTOR';
  description = 'Legacy fusion of Technicals, Social Sentiment, ML, and Arbitrage';

  async evaluate(productId: string): Promise<AIOrderProposal | null> {
    try {
      const result = await fuseSignals(productId);
      if (result && result.proposal) {
        // Tag the proposal with this strategy's name
        result.proposal.strategy = this.name;
        return result.proposal;
      }
      return null;
    } catch (err: any) {
      if (!err.message.includes('Insufficient candle data')) {
        console.error(`  ⚠️ [MULTI-FACTOR] Error scanning ${productId}:`, err.message);
      }
      return null;
    }
  }
}
