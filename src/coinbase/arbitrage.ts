/**
 * Coinbase Cross-Exchange & Lead-Lag Arbitrage Engine (Multi-Venue Consensus)
 * ───────────────────────────────────────────────────────────────────────────
 * UPGRADED:
 * 1. Kalman Filter & Z-Score Co-Integration (Math)
 * 2. Micro-Price Order Flow Imbalance (OFI)
 */

import { getTicker } from './client';

export interface ArbitrageSignal {
  productId: string;
  coinbasePrice: number;
  benchmarkPrice: number;
  spreadPct: number;          // ((CB - Benchmark) / Benchmark) * 100
  spreadBps: number;          // spread in basis points (1 bp = 0.01%)
  direction: 'BUY_DISCOUNT' | 'SELL_PREMIUM' | 'FAIR';
  confidence: number;         // 0.0 to 1.0
  reasoning: string;
  benchmarkVenue: string;
  timestamp: number;
}

// Mapping of base symbols to Kraken pair symbols
const KRAKEN_PAIR_MAP: Record<string, string> = {
  'BTC': 'XBTUSD',
  'ETH': 'ETHUSD',
  'SOL': 'SOLUSD',
  'DOGE': 'DOGEUSD',
  'PEPE': 'PEPEUSD',
  'BONK': 'BONKUSD',
  'SHIB': 'SHIBUSD',
  'SUI': 'SUIUSD',
  'SEI': 'SEIUSD',
  'ZEC': 'ZECUSD',
  'RENDER': 'RENDERUSD',
};

// In-memory cache for composite benchmarks (2 second TTL for faster Micro-Price)
interface BenchmarkCacheEntry {
  price: number;
  venue: string;
  timestamp: number;
}
const benchmarkCache: Record<string, BenchmarkCacheEntry> = {};
const BENCHMARK_CACHE_MS = 2000;

// Kalman Filter State Memory
interface KalmanState {
  estimate: number;
  estimateError: number;
  variance: number;
}
const kalmanStates: Record<string, KalmanState> = {};
const PROCESS_NOISE = 1e-4; // Q (How fast the true spread changes)
const MEASURE_NOISE = 1e-2; // R (Measurement noise)
const VAR_ALPHA = 0.05;     // EWMA decay for variance

/**
 * Fetch Micro-Price from Kraken (OFI Weighted)
 */
async function fetchKrakenPrice(baseSymbol: string): Promise<number | null> {
  const pair = KRAKEN_PAIR_MAP[baseSymbol];
  if (!pair) return null;
  try {
    const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`, {
      headers: { 'User-Agent': 'CoinbaseQuantBot/2.0' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (data.error && data.error.length > 0) return null;
    const key = Object.keys(data.result || {})[0];
    if (!key) return null;
    
    // a = ask [price, whole lot, lot], b = bid [price, whole lot, lot]
    const askPrice = parseFloat(data.result[key].a[0]);
    const askSize = parseFloat(data.result[key].a[2]);
    const bidPrice = parseFloat(data.result[key].b[0]);
    const bidSize = parseFloat(data.result[key].b[2]);
    
    // OFI Micro-Price Calculation
    const totalSize = bidSize + askSize;
    if (totalSize === 0) return parseFloat(data.result[key].c[0]);
    const imbalance = bidSize / totalSize;
    const microPrice = (askPrice * imbalance) + (bidPrice * (1 - imbalance));
    return microPrice > 0 ? microPrice : null;
  } catch {
    return null;
  }
}

/**
 * Fetch Micro-Price from KuCoin (OFI Weighted)
 */
async function fetchKucoinPrice(baseSymbol: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${baseSymbol}-USDT`, {
      headers: { 'User-Agent': 'CoinbaseQuantBot/2.0' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    
    const askPrice = parseFloat(data.data?.bestAsk || '0');
    const askSize = parseFloat(data.data?.bestAskSize || '0');
    const bidPrice = parseFloat(data.data?.bestBid || '0');
    const bidSize = parseFloat(data.data?.bestBidSize || '0');
    
    const totalSize = bidSize + askSize;
    if (totalSize === 0) return parseFloat(data.data?.price || '0');
    
    const imbalance = bidSize / totalSize;
    const microPrice = (askPrice * imbalance) + (bidPrice * (1 - imbalance));
    return microPrice > 0 ? microPrice : null;
  } catch {
    return null;
  }
}

/**
 * Fetch Micro-Price from OKX (OFI Weighted)
 */
async function fetchOkxPrice(baseSymbol: string): Promise<number | null> {
  try {
    const res = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${baseSymbol}-USDT`, {
      headers: { 'User-Agent': 'CoinbaseQuantBot/2.0' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    
    const askPrice = parseFloat(data.data?.[0]?.askPx || '0');
    const askSize = parseFloat(data.data?.[0]?.askSz || '0');
    const bidPrice = parseFloat(data.data?.[0]?.bidPx || '0');
    const bidSize = parseFloat(data.data?.[0]?.bidSz || '0');
    
    const totalSize = bidSize + askSize;
    if (totalSize === 0) return parseFloat(data.data?.[0]?.last || '0');
    
    const imbalance = bidSize / totalSize;
    const microPrice = (askPrice * imbalance) + (bidPrice * (1 - imbalance));
    return microPrice > 0 ? microPrice : null;
  } catch {
    return null;
  }
}

/**
 * Fetch Micro-Price from Binance US (OFI Weighted)
 */
async function fetchBinanceUsPrice(baseSymbol: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.binance.us/api/v3/ticker/bookTicker?symbol=${baseSymbol}USDT`, {
      headers: { 'User-Agent': 'CoinbaseQuantBot/2.0' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    
    const askPrice = parseFloat(data.askPrice || '0');
    const askSize = parseFloat(data.askQty || '0');
    const bidPrice = parseFloat(data.bidPrice || '0');
    const bidSize = parseFloat(data.bidQty || '0');
    
    const totalSize = bidSize + askSize;
    if (totalSize === 0) return null;
    
    const imbalance = bidSize / totalSize;
    const microPrice = (askPrice * imbalance) + (bidPrice * (1 - imbalance));
    return microPrice > 0 ? microPrice : null;
  } catch {
    return null;
  }
}

/**
 * Fetch Multi-Venue Composite Benchmark Price (Median across OFI Micro-Prices)
 */
export async function fetchCompositeBenchmark(baseSymbol: string): Promise<{ price: number; venue: string } | null> {
  const now = Date.now();
  if (benchmarkCache[baseSymbol] && (now - benchmarkCache[baseSymbol].timestamp) < BENCHMARK_CACHE_MS) {
    return {
      price: benchmarkCache[baseSymbol].price,
      venue: benchmarkCache[baseSymbol].venue,
    };
  }

  // Query external exchanges in parallel
  const [kraken, kucoin, okx, binanceUs] = await Promise.all([
    fetchKrakenPrice(baseSymbol),
    fetchKucoinPrice(baseSymbol),
    fetchOkxPrice(baseSymbol),
    fetchBinanceUsPrice(baseSymbol),
  ]);

  const venues: { name: string; price: number }[] = [];
  if (kraken) venues.push({ name: 'Kraken_Micro', price: kraken });
  if (kucoin) venues.push({ name: 'KuCoin_Micro', price: kucoin });
  if (okx) venues.push({ name: 'OKX_Micro', price: okx });
  if (binanceUs) venues.push({ name: 'BinanceUS_Micro', price: binanceUs });

  if (venues.length === 0) return null;

  // Calculate Median Price to eliminate outliers
  venues.sort((a, b) => a.price - b.price);
  let medianPrice: number;
  const mid = Math.floor(venues.length / 2);

  if (venues.length % 2 === 1) {
    medianPrice = venues[mid].price;
  } else {
    medianPrice = (venues[mid - 1].price + venues[mid].price) / 2;
  }

  const venueLabel = venues.length > 1
    ? `Consensus (${venues.map((v) => v.name).join('+')})`
    : venues[0].name;

  benchmarkCache[baseSymbol] = {
    price: medianPrice,
    venue: venueLabel,
    timestamp: now,
  };

  return { price: medianPrice, venue: venueLabel };
}

/**
 * Compute cross-exchange lead-lag arbitrage using Kalman Filter & Z-Scores
 */
export async function checkArbitrage(productId: string, coinbaseLivePrice?: number): Promise<ArbitrageSignal> {
  const base = productId.split('-')[0];
  const now = Date.now();

  let cbPrice = coinbaseLivePrice;
  if (!cbPrice) {
    try {
      const tickerRes = (await getTicker(productId)) as any;
      cbPrice = parseFloat(tickerRes.trades?.[0]?.price || '0');
    } catch {
      cbPrice = 0;
    }
  }

  if (cbPrice <= 0) {
    return {
      productId, coinbasePrice: 0, benchmarkPrice: 0, spreadPct: 0, spreadBps: 0,
      direction: 'FAIR', confidence: 0.5, reasoning: 'Coinbase ticker unavailable',
      benchmarkVenue: 'none', timestamp: now,
    };
  }

  const composite = await fetchCompositeBenchmark(base);
  if (!composite || composite.price <= 0) {
    return {
      productId, coinbasePrice: cbPrice, benchmarkPrice: cbPrice, spreadPct: 0, spreadBps: 0,
      direction: 'FAIR', confidence: 0.5, reasoning: 'Global benchmarks offline',
      benchmarkVenue: 'none', timestamp: now,
    };
  }

  const benchmarkPrice = composite.price;
  const spreadPct = ((cbPrice - benchmarkPrice) / benchmarkPrice) * 100;
  
  // Initialize or retrieve Kalman state
  if (!kalmanStates[productId]) {
    kalmanStates[productId] = { estimate: spreadPct, estimateError: 1, variance: 0.1 };
  }
  const state = kalmanStates[productId];

  // 1. Prediction Step
  const predError = state.estimateError + PROCESS_NOISE;

  // 2. Update Step
  const kalmanGain = predError / (predError + MEASURE_NOISE);
  state.estimate = state.estimate + kalmanGain * (spreadPct - state.estimate);
  state.estimateError = (1 - kalmanGain) * predError;

  // 3. Update Variance (EWMA) & Calculate Z-Score
  const diff = spreadPct - state.estimate;
  state.variance = VAR_ALPHA * (diff * diff) + (1 - VAR_ALPHA) * state.variance;
  const stdDev = Math.sqrt(state.variance) || 0.01;
  const zScore = (spreadPct - state.estimate) / stdDev;

  // Decision logic: Requires BOTH a minimum absolute spread to clear fees (1.20% round trip)
  // AND a strong statistical Z-Score dislocation (> 2.0 std devs)
  const MIN_FEE_HURDLE = 1.30; 
  const Z_SCORE_HURDLE = 2.0;

  let direction: 'BUY_DISCOUNT' | 'SELL_PREMIUM' | 'FAIR' = 'FAIR';
  let confidence = 0.50;
  let reasoning = `Kalman Spread: ${spreadPct.toFixed(2)}% │ Z-Score: ${zScore.toFixed(2)}`;

  if (spreadPct <= -MIN_FEE_HURDLE && zScore <= -Z_SCORE_HURDLE) {
    direction = 'BUY_DISCOUNT';
    confidence = Math.min(0.99, 0.70 + (Math.abs(zScore) - 2.0) * 0.1);
    reasoning = `⚡ ARB MATH PROOF: Z-Score ${zScore.toFixed(2)} │ OFI Micro-Price Discount ${Math.abs(spreadPct).toFixed(2)}% vs ${composite.venue}`;
  } else if (spreadPct >= MIN_FEE_HURDLE && zScore >= Z_SCORE_HURDLE) {
    direction = 'SELL_PREMIUM';
    confidence = Math.min(0.99, 0.70 + (zScore - 2.0) * 0.1);
    reasoning = `⚡ ARB MATH PROOF: Z-Score ${zScore.toFixed(2)} │ OFI Micro-Price Premium ${spreadPct.toFixed(2)}% vs ${composite.venue}`;
  }

  return {
    productId,
    coinbasePrice: cbPrice,
    benchmarkPrice,
    spreadPct: parseFloat(spreadPct.toFixed(4)),
    spreadBps: parseFloat((spreadPct * 100).toFixed(1)),
    direction,
    confidence: parseFloat(confidence.toFixed(2)),
    reasoning,
    benchmarkVenue: composite.venue,
    timestamp: now,
  };
}
