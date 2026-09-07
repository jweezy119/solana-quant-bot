import { PriceHistory, OrderFlowState, BollingerState, RegimeState } from '../core/types';

/**
 * Transforms raw market data into normalized feature vectors
 * for the ML predictor model.
 */
export class FeatureEngine {
  
  /**
   * Generates a unified feature vector from current state
   */
  public generateFeatureVector(
    history: PriceHistory,
    orderFlow: OrderFlowState,
    bollinger: BollingerState,
    regime: RegimeState
  ): number[] {
    // We need at least some price history to generate features
    if (history.prices.length < 20) {
      return [];
    }

    const currentPrice = history.prices[history.prices.length - 1];
    
    // Normalize features to range [-1, 1] or [0, 1] where possible
    const features = [
      // 1. Price Momentum (normalized by ATR)
      this.normalize(history.ema8 - history.ema21, history.atrSmoothed),
      this.normalize(history.ema21 - history.ema55, history.atrSmoothed),
      this.normalize(currentPrice - history.vwap, history.atrSmoothed),
      
      // 2. Volatility
      this.normalizePositive(history.atrSmoothed, currentPrice),
      bollinger.bandwidth,
      bollinger.percentB,
      
      // 3. Order Flow Imbalance
      orderFlow.ofi1m,
      orderFlow.ofi5m,
      orderFlow.ofi15m,
      
      // 4. Regime Context
      regime.hurstExponent,
      regime.atrPercentile / 100, // Normalize 0-100 to 0-1
      regime.emaAlignment
    ];
    
    return features;
  }

  /**
   * Normalizes a value (like a price diff) against a scale (like ATR)
   * Caps at [-3, 3] standard deviations/scale
   */
  private normalize(value: number, scale: number): number {
    if (scale === 0) return 0;
    const z = value / scale;
    return Math.max(-3, Math.min(3, z)) / 3; // Normalize to [-1, 1]
  }

  /**
   * Normalizes a strictly positive value
   */
  private normalizePositive(value: number, scale: number): number {
    if (scale === 0) return 0;
    const z = value / scale;
    return Math.min(1, z * 10); // Heuristic scaling
  }
}
