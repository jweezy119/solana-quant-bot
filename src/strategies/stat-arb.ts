import { IStrategy } from './base-strategy';
import { AIOrderProposal } from '../coinbase/risk-manager';
import { getCandles } from '../coinbase/client';

export class StatArbStrategy implements IStrategy {
  name = 'STAT_ARB';
  description = 'Statistical Arbitrage via Cointegration Z-Score';

  private pairs: Record<string, string> = {
    'ETH-USDC': 'BTC-USDC',
    'AVAX-USDC': 'SOL-USDC',
    'SHIB-USDC': 'PEPE-USDC',
    'DOGE-USDC': 'SHIB-USDC',
    'AERO-USDC': 'UNI-USDC'
  };

  async evaluate(productId: string): Promise<AIOrderProposal | null> {
    const peerId = this.pairs[productId];
    if (!peerId) return null; // Not a trackable pair

    try {
      const now = Math.floor(Date.now() / 1000);
      const start = now - (3600 * 24 * 7); // 7 days of 1-hour candles
      
      const [targetRes, peerRes] = await Promise.all([
        getCandles(productId, start, now, 'ONE_HOUR'),
        getCandles(peerId, start, now, 'ONE_HOUR')
      ]);

      const targetCandles = (targetRes as any).candles || [];
      const peerCandles = (peerRes as any).candles || [];

      if (targetCandles.length < 50 || peerCandles.length < 50) return null;

      // Align candles by time (rough alignment is fine since both use ONE_HOUR)
      const ratios: number[] = [];
      let currentRatio = 0;
      
      // Iterate backwards since Coinbase returns newest first
      for (let i = 0; i < Math.min(targetCandles.length, peerCandles.length); i++) {
        const tClose = parseFloat(targetCandles[i].close);
        const pClose = parseFloat(peerCandles[i].close);
        if (tClose > 0 && pClose > 0) {
          ratios.push(tClose / pClose);
          if (i === 0) currentRatio = tClose / pClose;
        }
      }

      if (ratios.length < 50) return null;

      const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      const squaredDiffs = ratios.map(r => Math.pow(r - mean, 2));
      const variance = squaredDiffs.reduce((a, b) => a + b, 0) / ratios.length;
      const stdDev = Math.sqrt(variance);

      if (stdDev === 0) return null;

      const zScore = (currentRatio - mean) / stdDev;

      // Z-Score thresholds:
      // < -1.5 means the target is oversold relative to the peer (BUY signal)
      // > 1.5 means target is overbought (SELL signal)

      if (zScore < -1.5) {
        return {
          productId,
          action: 'BUY',
          confidence: parseFloat(Math.min(0.95, 0.70 + (Math.abs(zScore) * 0.05)).toFixed(2)),
          reasoning: `[STAT-ARB] Z-Score ${zScore.toFixed(2)} vs ${peerId}. Historically oversold.`,
          strategy: this.name,
        };
      } else if (zScore > 1.5) {
        return {
          productId,
          action: 'SELL',
          confidence: parseFloat(Math.min(0.95, 0.70 + (zScore * 0.05)).toFixed(2)),
          reasoning: `[STAT-ARB] Z-Score ${zScore.toFixed(2)} vs ${peerId}. Historically overbought.`,
          strategy: this.name,
        };
      }

      return null;
    } catch (err: any) {
      return null;
    }
  }
}
