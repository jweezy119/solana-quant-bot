/**
 * DexScreener Solana Meme Scanner & Momentum Engine
 * ──────────────────────────────────────────────────
 * Continuously tracks boosted & viral tokens on Solana,
 * filtering for early-stage breakout momentum, buy-to-sell ratios,
 * and liquidity thresholds to prevent rugpulls.
 */

export interface MemeTokenOpportunity {
  tokenAddress: string;
  name: string;
  symbol: string;
  priceUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  volume5m: number;
  volume1h: number;
  buys5m: number;
  sells5m: number;
  buyRatio5m: number;
  liquidityUsd: number;
  fdv: number;
  pairUrl: string;
  dexId: string;
  isPumpFun: boolean;
  score: number; // 0 to 100 quant breakout score
  timestamp: number;
  description?: string;
  socialsString?: string;
}

export interface MemeScannerFilters {
  minLiquidityUsd?: number;
  minVolume5m?: number;
  minBuyRatio5m?: number;
  maxFdvUsd?: number;
}

const DEFAULT_FILTERS: MemeScannerFilters = {
  minLiquidityUsd: 3_000,    // "No box" micro-cap liquidity loop hole (catches Pump.fun mid-curve)
  minVolume5m: 500,          // Detect early momentum before crowd
  minBuyRatio5m: 2.5,        // Enforce overwhelming buy-pressure (evades rug pulls early)
  maxFdvUsd: 3_000_000,      // Keep FDV low for max 100x asymmetry
};

let cachedOpportunities: MemeTokenOpportunity[] = [];
let lastFetchTime = 0;
const CACHE_TTL_MS = 6000; // 6s cache

/**
 * Fetch top boosted & trending Solana tokens from DexScreener
 */
export async function scanTrendingMemeCoins(
  customFilters?: Partial<MemeScannerFilters>
): Promise<MemeTokenOpportunity[]> {
  const now = Date.now();
  if (cachedOpportunities.length > 0 && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedOpportunities;
  }

  const filters = { ...DEFAULT_FILTERS, ...customFilters };

  try {
    // 1. Fetch top boosted and newest token profiles in parallel
    const [boostRes, profileRes] = await Promise.all([
      fetch('https://api.dexscreener.com/token-boosts/top/v1', {
        headers: { 'User-Agent': 'QuantRadar/1.0' },
        signal: AbortSignal.timeout(4500),
      }).catch(() => null),
      fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
        headers: { 'User-Agent': 'QuantRadar/1.0' },
        signal: AbortSignal.timeout(4500),
      }).catch(() => null),
    ]);

    const mintSet = new Set<string>();

    if (boostRes && boostRes.ok) {
      const boosts = (await boostRes.json()) as any[];
      for (const b of boosts) {
        if (b.chainId === 'solana' && b.tokenAddress) mintSet.add(b.tokenAddress);
      }
    }

    if (profileRes && profileRes.ok) {
      const profiles = (await profileRes.json()) as any[];
      for (const p of profiles) {
        if (p.chainId === 'solana' && p.tokenAddress) mintSet.add(p.tokenAddress);
      }
    }

    const solanaTokens = Array.from(mintSet).slice(0, 30);
    if (solanaTokens.length === 0) return cachedOpportunities;

    // 2. Fetch live metrics in batch
    const tokensParam = solanaTokens.join(',');
    const detailsRes = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokensParam}`,
      {
        headers: { 'User-Agent': 'QuantRadar/1.0' },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!detailsRes.ok) return cachedOpportunities;
    const data = (await detailsRes.json()) as any;
    const pairs: any[] = data.pairs || [];

    const opportunities: MemeTokenOpportunity[] = [];
    const seenMints = new Set<string>();

    for (const p of pairs) {
      if (p.chainId !== 'solana' || !p.baseToken?.address) continue;
      const mint = p.baseToken.address;
      if (seenMints.has(mint)) continue;
      seenMints.add(mint);

      const price = parseFloat(p.priceUsd || '0');
      const liq = parseFloat(p.liquidity?.usd || '0');
      const vol5m = parseFloat(p.volume?.m5 || '0');
      const vol1h = parseFloat(p.volume?.h1 || '0');
      const buys5m = p.txns?.m5?.buys || 0;
      const sells5m = p.txns?.m5?.sells || 0;
      const buyRatio = sells5m > 0 ? buys5m / sells5m : buys5m > 0 ? 2.5 : 1.0;
      const fdv = parseFloat(p.fdv || '0');
      const change5m = parseFloat(p.priceChange?.m5 || '0');
      const change1h = parseFloat(p.priceChange?.h1 || '0');
      const isPump = mint.toLowerCase().endsWith('pump') || p.dexId === 'pumpfun';

      // Apply safety & momentum filters
      if (liq < (filters.minLiquidityUsd || 15_000)) continue;
      if (vol5m < (filters.minVolume5m || 1_000)) continue;
      if (buyRatio < (filters.minBuyRatio5m || 1.3)) continue;
      if (filters.maxFdvUsd && fdv > filters.maxFdvUsd) continue;

      // Anti-Spam / Rug Filter: Require at least one social link or website
      const hasSocials = p.info?.socials && p.info.socials.length > 0;
      const hasWebsites = p.info?.websites && p.info.websites.length > 0;
      if (!hasSocials && !hasWebsites) continue;
      
      let socialsString = '';
      if (hasSocials) {
        socialsString += p.info.socials.map((s: any) => `${s.type}: ${s.url}`).join(', ');
      }
      if (hasWebsites) {
        socialsString += ' ' + p.info.websites.map((w: any) => `website: ${w.url}`).join(', ');
      }
      
      const description = p.info?.imageUrl || ''; // Pump.fun Dexscreener api doesn't reliably put description in root info but we can pass whatever metadata we find, or maybe `p.info?.description` if they add it. wait DexScreener info object doesn't actually have `description` field for Pump.fun coins? Sometimes they do. Let's try `p.info?.description || p.info?.header || ''`
      const actualDescription = p.info?.header || p.info?.description || p.baseToken?.name || '';

      // Calculate Breakout Score (0 - 100)
      let score = 50;
      if (buyRatio >= 2.5) score += 20;
      else if (buyRatio >= 1.8) score += 10;

      if (vol5m >= 10_000) score += 15;
      else if (vol5m >= 3_000) score += 10;

      if (change5m > 3 && change5m < 50) score += 10; // Positive traction without vertical blow-off top
      if (liq >= 50_000) score += 5;

      opportunities.push({
        tokenAddress: mint,
        name: p.baseToken.name || 'Unknown',
        symbol: p.baseToken.symbol || 'MEME',
        priceUsd: price,
        priceChange5m: change5m,
        priceChange1h: change1h,
        volume5m: vol5m,
        volume1h: vol1h,
        buys5m,
        sells5m,
        buyRatio5m: parseFloat(buyRatio.toFixed(2)),
        liquidityUsd: liq,
        fdv,
        pairUrl: p.url,
        dexId: p.dexId,
        isPumpFun: isPump,
        score: Math.min(100, score),
        timestamp: now,
        description: actualDescription,
        socialsString: socialsString.trim(),
      });
    }

    // Sort by breakout score descending
    opportunities.sort((a, b) => b.score - a.score);

    cachedOpportunities = opportunities;
    lastFetchTime = now;
    return opportunities;
  } catch (err) {
    return cachedOpportunities;
  }
}
