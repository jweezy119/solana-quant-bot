import { IStrategy } from './base-strategy';
import { AIOrderProposal } from '../coinbase/risk-manager';
import { getTechnicalSignal } from '../coinbase/signals';
import { getCandles } from '../coinbase/client';

export class MomentumStrategy implements IStrategy {
  name = 'MOMENTUM_ENGINE';
  description = 'Rides strong cross-sectional bull trends with wide trailing stops';

  async evaluate(productId: string): Promise<AIOrderProposal | null> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const start = now - (3600 * 24); // 24 hours ago
      
      // Fetch 1h candles for 24h return calculation
      const res = await getCandles(productId, start, now, 'ONE_HOUR');
      const candles = (res as any).candles || [];
      
      if (candles.length < 20) return null; // Need enough history

      // Coinbase returns newest first
      const oldestClose = parseFloat(candles[candles.length - 1].close);
      const newestClose = parseFloat(candles[0].close);
      
      if (oldestClose <= 0) return null;
      const return24h = ((newestClose - oldestClose) / oldestClose) * 100;

      // Get latest 15m indicators
      const tech = await getTechnicalSignal(productId);

      // Criteria for Momentum breakout:
      // 1. Asset is strongly trending up on the day (> 2.5% return)
      // 2. Short-term trend is UPTREND (EMA9 > EMA21)
      // 3. RSI is healthy but not exhausted (between 50 and 80)
      
      if (return24h > 2.5 && tech.trend === 'UPTREND' && tech.rsi > 50 && tech.rsi < 80) {
        return {
          productId,
          action: 'BUY',
          confidence: 0.85, // Strong confidence, overrides standard stat-arb
          reasoning: `[MOMENTUM-ENGINE] 24h Return +${return24h.toFixed(1)}%. EMA Uptrend confirmed. RSI healthy at ${tech.rsi.toFixed(1)}. Riding the trend.`,
          strategy: this.name,
          atrPct: tech.atrPct, // Wide trailing stop managed by risk manager
        };
      }

      return null;
    } catch (err) {
      return null;
    }
  }
}
