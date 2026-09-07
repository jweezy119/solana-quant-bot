/**
 * Cross-Platform Alpha Radar Orchestrator
 * ───────────────────────────────────────
 * Unifies:
 * 1. DexScreener viral Solana meme momentum & breakout signals
 * 2. Helius on-chain Smart Money & Famous Trader wallet swaps
 * 3. Coinbase Advanced Trade new listing & roadmap detection
 *
 * Provides actionable quantitative alpha to both the Coinbase CEX bot
 * and the Solana DEX meme sniper.
 */

import { scanTrendingMemeCoins, MemeTokenOpportunity } from './dexscreener';
import { scanWhaleActivity, WhaleAlert, getCachedWhaleAlerts, getTrackedWallets } from './whale-tracker';
import { checkCoinbaseNewListings, CoinbaseListingAlert, getTotalMonitoredCoinbaseProducts } from './coinbase-listing';

export interface AlphaRadarState {
  score: number;                     // -1.0 (extreme dump/fear) to +1.0 (extreme meme/whale accumulation)
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;                // 0.0 to 1.0
  topMeme: MemeTokenOpportunity | null;
  activeMemeCount: number;
  latestWhaleAlert: WhaleAlert | null;
  trackedWalletsCount: number;
  coinbaseMonitoredCount: number;
  newListings: CoinbaseListingAlert[];
  summary: string;
  timestamp: number;
}

let currentState: AlphaRadarState = {
  score: 0.1,
  direction: 'NEUTRAL',
  confidence: 0.5,
  topMeme: null,
  activeMemeCount: 0,
  latestWhaleAlert: null,
  trackedWalletsCount: getTrackedWallets().length,
  coinbaseMonitoredCount: 0,
  newListings: [],
  summary: 'Initializing Alpha Radar...',
  timestamp: Date.now(),
};

let lastPoll = 0;
const RADAR_POLL_INTERVAL_MS = 10000; // 10s refresh

/**
 * Poll all three alpha feeds and update state
 */
export async function pollAlphaRadar(): Promise<AlphaRadarState> {
  const now = Date.now();
  if (now - lastPoll < RADAR_POLL_INTERVAL_MS) {
    return currentState;
  }
  lastPoll = now;

  try {
    const [memes, whaleAlerts, listings] = await Promise.all([
      scanTrendingMemeCoins({ minLiquidityUsd: 12000, minBuyRatio5m: 1.3 }),
      scanWhaleActivity(3),
      checkCoinbaseNewListings(),
    ]);

    const topMeme = memes.length > 0 ? memes[0] : null;
    const latestWhale = whaleAlerts.length > 0 ? whaleAlerts[0] : getCachedWhaleAlerts()[0] || null;

    // Calculate aggregated sentiment score (-1.0 to +1.0)
    let score = 0;
    let factors = 0;

    // 1. Meme Momentum Factor
    if (topMeme) {
      const memeFactor = (topMeme.buyRatio5m - 1.0) / 2.0; // e.g. 2.0x ratio -> +0.5
      score += Math.max(-1, Math.min(1, memeFactor));
      factors++;
    }

    // 2. Whale Movement Factor
    if (latestWhale) {
      if (latestWhale.action === 'BUY') score += 0.6;
      else if (latestWhale.action === 'SELL') score -= 0.6;
      factors++;
    }

    // 3. New Coinbase Listing Boost
    if (listings.length > 0) {
      score += 0.8;
      factors++;
    }

    const finalScore = factors > 0 ? parseFloat((score / factors).toFixed(2)) : 0.05;
    const direction = finalScore > 0.15 ? 'BULLISH' : finalScore < -0.15 ? 'BEARISH' : 'NEUTRAL';
    const confidence = Math.min(0.95, 0.5 + Math.abs(finalScore) * 0.4);

    let summary = '';
    if (listings.length > 0) {
      summary = `🚀 NEW LISTING: ${listings[0].productId} active on Coinbase!`;
    } else if (topMeme && topMeme.score >= 70) {
      summary = `🔥 Viral Meme $${topMeme.symbol} (${topMeme.buyRatio5m}x buy ratio, $${(topMeme.volume5m/1000).toFixed(1)}k 5m vol)`;
    } else if (latestWhale && latestWhale.action === 'BUY') {
      summary = `🐋 Whale Buy: ${latestWhale.walletLabel} accumulated $${latestWhale.amountUsd.toFixed(0)}`;
    } else {
      summary = `⚡ Monitored: ${memes.length} memes, ${getTrackedWallets().length} whales, ${getTotalMonitoredCoinbaseProducts()} CB pairs`;
    }

    currentState = {
      score: finalScore,
      direction,
      confidence: parseFloat(confidence.toFixed(2)),
      topMeme,
      activeMemeCount: memes.length,
      latestWhaleAlert: latestWhale,
      trackedWalletsCount: getTrackedWallets().length,
      coinbaseMonitoredCount: getTotalMonitoredCoinbaseProducts(),
      newListings: listings,
      summary,
      timestamp: now,
    };

    return currentState;
  } catch (err: any) {
    return currentState;
  }
}

export function getAlphaRadarState(): AlphaRadarState {
  return currentState;
}
