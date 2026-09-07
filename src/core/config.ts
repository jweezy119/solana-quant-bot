/**
 * Solana Quant Bot v3 — Centralized Configuration
 * ─────────────────────────────────────────────────
 * All tunable parameters in one place.
 * Every value can be overridden via environment variable.
 */

import 'dotenv/config';
import { TokenInfo, RiskLimits, MarketRegime } from './types';

// ============================================================
//  HELPERS
// ============================================================
const env = (key: string, fallback: string): string => process.env[key] ?? fallback;
const envNum = (key: string, fallback: number): number => {
  const v = process.env[key];
  return v !== undefined ? parseFloat(v) : fallback;
};
const envBool = (key: string, fallback: boolean): boolean => {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
};

// ============================================================
//  WALLET
// ============================================================
export const PRIVATE_KEY_BASE58 = env('PRIVATE_KEY', 'YOUR_PRIVATE_KEY_HERE');
export const IS_SIMULATION = PRIVATE_KEY_BASE58 === 'YOUR_PRIVATE_KEY_HERE';

// ============================================================
//  NETWORK / ENDPOINTS
// ============================================================
export const RPC_ENDPOINT = env('RPC_ENDPOINT', 'https://api.mainnet-beta.solana.com');
export const RPC_FALLBACK = env('RPC_FALLBACK', 'https://api.mainnet-beta.solana.com');
export const HELIUS_API_KEY = env('HELIUS_API_KEY', '');
export const HELIUS_RPC = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : '';
export const HELIUS_WS = HELIUS_API_KEY
  ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : '';

// Jupiter API (fully free, no key needed)
export const JUPITER_QUOTE_URL = env('JUPITER_QUOTE_URL', 'https://public.jupiterapi.com/quote');
export const JUPITER_SWAP_URL = env('JUPITER_SWAP_URL', 'https://public.jupiterapi.com/swap');
export const JUPITER_PRICE_URL = env('JUPITER_PRICE_URL', 'https://api.jup.ag/price/v2');

// Jito (free to submit, tips per bundle)
export const JITO_BLOCK_ENGINE = env('JITO_BLOCK_ENGINE', 'https://mainnet.block-engine.jito.wtf');
export const JITO_TIP_LAMPORTS = envNum('JITO_TIP_LAMPORTS', 3_000_000); // 0.003 SOL default

// ============================================================
//  FEATURE FLAGS
// ============================================================
export const FEATURES = {
  ML_PREDICTOR: envBool('ENABLE_ML', false),
  JITO_BUNDLES: envBool('ENABLE_JITO', false),
  WHALE_MONITOR: envBool('ENABLE_WHALE_MONITOR', false),
  CROSS_DEX: envBool('ENABLE_CROSS_DEX', true),
  ORDER_FLOW: envBool('ENABLE_ORDER_FLOW', true),
  REGIME_DETECTION: envBool('ENABLE_REGIME', true),
  HELIUS_WS: envBool('ENABLE_HELIUS_WS', false),
};

// ============================================================
//  TOKENS
// ============================================================
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const TOKENS: TokenInfo[] = [
  { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
  { symbol: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', decimals: 6 },
  { symbol: 'MOODENG', mint: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Qp8M3eYipump', decimals: 6 },
  { symbol: 'FARTCOIN', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', decimals: 6 },
];

// ============================================================
//  CAPITAL & POSITION SIZING
// ============================================================
export const STARTING_CAPITAL_USDC = envNum('STARTING_CAPITAL', 42);
export const MIN_TRADE_USDC = envNum('MIN_TRADE_USDC', 5);        // absolute minimum
export const MAX_TRADE_USDC = envNum('MAX_TRADE_USDC', 21);       // absolute maximum per trade

// ============================================================
//  KELLY CRITERION
// ============================================================
export const KELLY = {
  WIN_RATE: envNum('KELLY_WIN_RATE', 0.55),                       // initial estimate
  WIN_LOSS_RATIO: envNum('KELLY_WIN_LOSS_RATIO', 2.0),            // +4% win / -2% loss
  FRACTION: envNum('KELLY_FRACTION', 0.5),                        // half-Kelly for safety
  CONFIDENCE_FLOOR: envNum('KELLY_CONFIDENCE_FLOOR', 0.3),        // minimum confidence to trade
  CONFIDENCE_SCALE: envBool('KELLY_CONFIDENCE_SCALE', true),      // scale size by confidence
};

// ============================================================
//  RISK LIMITS
// ============================================================
export const RISK: RiskLimits = {
  maxPositions: envNum('MAX_POSITIONS', 4),
  maxExposurePct: envNum('MAX_EXPOSURE_PCT', 80),
  maxPerPositionPct: envNum('MAX_PER_POSITION_PCT', 50),
  maxDailyDrawdownPct: envNum('MAX_DAILY_DRAWDOWN_PCT', 8),
  maxWeeklyDrawdownPct: envNum('MAX_WEEKLY_DRAWDOWN_PCT', 15),
  maxSingleTradeLossPct: envNum('MAX_SINGLE_TRADE_LOSS_PCT', 3),
  consecutiveLossLimit: envNum('CONSECUTIVE_LOSS_LIMIT', 3),
  entropyThreshold: envNum('ENTROPY_THRESHOLD', 0.85),
  pauseDurationMs: envNum('PAUSE_DURATION_MS', 2 * 60 * 60 * 1000), // 2 hours
  minTradeUsdc: envNum('MIN_TRADE_USDC', 5),
  maxTradeUsdc: envNum('MAX_TRADE_USDC', 21),
};

// ============================================================
//  SIGNAL PARAMETERS
// ============================================================

// EMA
export const EMA = {
  FAST: envNum('EMA_FAST', 10),
  SLOW: envNum('EMA_SLOW', 20),
  PERIODS: [8, 13, 21, 55],          // multi-timeframe confluence
  MIN_SAMPLES: envNum('MIN_SAMPLES', 20),
};

// ATR
export const ATR = {
  PERIOD: envNum('ATR_PERIOD', 14),
  DIP_MULT: envNum('ATR_DIP_MULT', 1.2),
  SELL_MULT: envNum('ATR_SELL_MULT', 2.0),
  STOP_MULT: envNum('ATR_STOP_MULT', 1.0),
  MIN_DIP_PCT: envNum('MIN_DIP_PCT', 1.5),
  MAX_DIP_PCT: envNum('MAX_DIP_PCT', 4.5),
};

// Take profit / Stop loss
export const EXITS = {
  BASE_SELL_PCT: envNum('BASE_SELL_PCT', 4.0),
  BASE_STOP_PCT: envNum('BASE_STOP_PCT', 2.0),
  PARTIAL_SELL_FRAC: envNum('PARTIAL_SELL_FRAC', 0.60),
  TRAIL_ACTIVATION_PCT: envNum('TRAIL_ACTIVATION_PCT', 2.0),
  TRAIL_DISTANCE_PCT: envNum('TRAIL_DISTANCE_PCT', 1.5),
  EXTENDED_TARGET_MULT: envNum('EXTENDED_TARGET_MULT', 1.5),
};

// Bollinger Bands
export const BOLLINGER = {
  PERIOD: envNum('BB_PERIOD', 20),
  STD_DEV: envNum('BB_STD_DEV', 2.0),
  OVERSOLD_THRESHOLD: envNum('BB_OVERSOLD', 0.1),
  OVERBOUGHT_THRESHOLD: envNum('BB_OVERBOUGHT', 0.9),
};

// VWAP
export const VWAP = {
  RESET_INTERVAL_MS: envNum('VWAP_RESET_MS', 24 * 60 * 60 * 1000), // daily reset
  MIN_DEVIATION_PCT: envNum('VWAP_MIN_DEV', 0.5),
};

// Order Flow
export const ORDER_FLOW = {
  DIVERGENCE_THRESHOLD: envNum('OFI_DIVERGENCE', 0.3),
  MIN_SAMPLES: envNum('OFI_MIN_SAMPLES', 10),
};

// Cross-DEX
export const CROSS_DEX = {
  MIN_SPREAD_PCT: envNum('MIN_SPREAD_PCT', 0.6),
  CHECK_AMOUNT_RAW: envNum('CROSS_DEX_AMOUNT', 12_000_000), // $12 USDC
  DEX_LABELS: ['Raydium', 'Orca', 'Meteora'],
};

// Regime Detection
export const REGIME = {
  HURST_WINDOW: envNum('HURST_WINDOW', 100),
  HURST_TRENDING: envNum('HURST_TRENDING', 0.6),
  HURST_MEAN_REVERT: envNum('HURST_MEAN_REVERT', 0.4),
  ATR_HISTORY_SIZE: envNum('ATR_HISTORY_SIZE', 200),
  ATR_HIGH_VOL_PCT: envNum('ATR_HIGH_VOL_PCT', 75),
  ATR_LOW_VOL_PCT: envNum('ATR_LOW_VOL_PCT', 25),
};

// ============================================================
//  SIGNAL FUSION WEIGHTS (regime-dependent)
// ============================================================
export interface RegimeWeights {
  'ema-atr': number;
  'cross-dex': number;
  'ml-predictor': number;
  'order-flow': number;
  'vwap': number;
  'bollinger': number;
  'regime': number;
  'whale-monitor': number;
  'vpin-toxicity'?: number;
  'dtw-pattern'?: number;
}

export const FUSION_WEIGHTS: Record<MarketRegime, RegimeWeights> = {
  [MarketRegime.TRENDING_UP]: {
    'ema-atr': 0.20, 'cross-dex': 0.05, 'ml-predictor': 0.15,
    'order-flow': 0.15, 'vwap': 0.05, 'bollinger': 0.05,
    'regime': 0.05, 'whale-monitor': 0.05, 'vpin-toxicity': 0.15, 'dtw-pattern': 0.10
  },
  [MarketRegime.TRENDING_DOWN]: {
    'ema-atr': 0.15, 'cross-dex': 0.05, 'ml-predictor': 0.15,
    'order-flow': 0.15, 'vwap': 0.05, 'bollinger': 0.10,
    'regime': 0.05, 'whale-monitor': 0.05, 'vpin-toxicity': 0.15, 'dtw-pattern': 0.10
  },
  [MarketRegime.MEAN_REVERTING]: {
    'ema-atr': 0.10, 'cross-dex': 0.10, 'ml-predictor': 0.10,
    'order-flow': 0.10, 'vwap': 0.15, 'bollinger': 0.20,
    'regime': 0.05, 'whale-monitor': 0.05, 'vpin-toxicity': 0.10, 'dtw-pattern': 0.05
  },
  [MarketRegime.HIGH_VOLATILITY]: {
    'ema-atr': 0.10, 'cross-dex': 0.10, 'ml-predictor': 0.10,
    'order-flow': 0.15, 'vwap': 0.05, 'bollinger': 0.10,
    'regime': 0.05, 'whale-monitor': 0.05, 'vpin-toxicity': 0.15, 'dtw-pattern': 0.15
  },
  [MarketRegime.LOW_VOLATILITY]: {
    'ema-atr': 0.20, 'cross-dex': 0.10, 'ml-predictor': 0.15,
    'order-flow': 0.10, 'vwap': 0.15, 'bollinger': 0.10,
    'regime': 0.05, 'whale-monitor': 0.05, 'vpin-toxicity': 0.05, 'dtw-pattern': 0.05
  },
  [MarketRegime.RANDOM_WALK]: {
    'ema-atr': 0.10, 'cross-dex': 0.10, 'ml-predictor': 0.20,
    'order-flow': 0.15, 'vwap': 0.10, 'bollinger': 0.10,
    'regime': 0.10, 'whale-monitor': 0.05, 'vpin-toxicity': 0.05, 'dtw-pattern': 0.05
  },
};

// Minimum signals that must agree for entry
export const FUSION_MIN_AGREEING_SIGNALS = envNum('FUSION_MIN_SIGNALS', 3);
export const FUSION_MIN_CONFIDENCE = envNum('FUSION_MIN_CONFIDENCE', 0.55);

// ============================================================
//  REGIME MULTIPLIERS (for Kelly sizing)
// ============================================================
export const REGIME_MULTIPLIERS: Record<MarketRegime, number> = {
  [MarketRegime.TRENDING_UP]: 1.2,
  [MarketRegime.TRENDING_DOWN]: 0.6,
  [MarketRegime.MEAN_REVERTING]: 0.9,
  [MarketRegime.HIGH_VOLATILITY]: 0.5,
  [MarketRegime.LOW_VOLATILITY]: 1.0,
  [MarketRegime.RANDOM_WALK]: 0.7,
};

// ============================================================
//  POLLING / TIMING
// ============================================================
export const TIMING = {
  BASE_POLL_MS: envNum('POLL_INTERVAL_MS', 3000),
  HIGH_VOL_POLL_MS: envNum('HIGH_VOL_POLL_MS', 1500),
  LOW_VOL_POLL_MS: envNum('LOW_VOL_POLL_MS', 5000),
  API_TIMEOUT_MS: envNum('API_TIMEOUT_MS', 8000),
  SWAP_TIMEOUT_MS: envNum('SWAP_TIMEOUT_MS', 15000),
};

// ============================================================
//  SLIPPAGE
// ============================================================
export const SLIPPAGE_BPS = envNum('SLIPPAGE_BPS', 50);

// ============================================================
//  PERSISTENCE
// ============================================================
export const DATA_DIR = env('DATA_DIR', './data');
export const DB_PATH = env('DB_PATH', `${DATA_DIR}/quant-bot.db`);
export const POSITIONS_FILE = env('POSITIONS_FILE', `${DATA_DIR}/positions.json`);

// ============================================================
//  WHALE MONITOR
// ============================================================
export const WHALE = {
  MIN_TX_USD: envNum('WHALE_MIN_TX_USD', 50_000),
  CLUSTER_WINDOW_MS: envNum('WHALE_CLUSTER_WINDOW_MS', 30 * 60 * 1000), // 30 min
  CLUSTER_MIN_WALLETS: envNum('WHALE_CLUSTER_MIN_WALLETS', 3),
  TRACKED_WALLETS: (env('WHALE_WALLETS', '')).split(',').filter(Boolean),
};
