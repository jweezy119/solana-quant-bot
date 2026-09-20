import { AIOrderProposal } from '../coinbase/risk-manager';

export interface IStrategy {
  name: string;
  description: string;
  
  /**
   * Evaluate a given product and return a trading proposal if criteria are met.
   * Returns null if the strategy abstains from trading this product right now.
   */
  evaluate(productId: string): Promise<AIOrderProposal | null>;
}
