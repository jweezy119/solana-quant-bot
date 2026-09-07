/**
 * Solana Quant Bot v3 — Core Type Definitions
 * ─────────────────────────────────────────────
 * Every module imports types from here. No circular deps.
 */

// ============================================================
//  TOKEN
// ============================================================
export interface TokenInfo {
  symbol: string;
  mint: string;
  decimals: number;
}

// ============================================================
//  PRICE & MARKET DATA
// ============================================================
export interface PriceTick {
  token: string;
  price: number;
  timestamp: number;
  volume?: number;
  source: 'jupiter' | 'helius' | 'manual';
}

export interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface PriceHistory {
  prices: number[];
  volumes: number[];
  timestamps: number[];
  emaFast: number;
  emaSlow: number;
  ema8: number;
  ema13: number;
  ema21: number;
  ema55: number;
  atr: number;
  atrSmoothed: number; // Wilder's smoothed ATR
  rollingHigh: number;
  rollingLow: number;
  vwap: number;
  vwapVolume: number;  // cumulative volume for VWAP calc
  vwapPV: number;      // cumulative price×volume for VWAP calc
}

// ============================================================
//  SIGNALS
// ============================================================
export type SignalSource =
  | 'ema-atr'
  | 'cross-dex'
  | 'ml-predictor'
  | 'order-flow'
  | 'vwap'
  | 'bollinger'
  | 'regime'
  | 'whale-monitor'
  | 'vpin-toxicity'
  | 'dtw-pattern';

export type SignalDirection = 'LONG' | 'SHORT' | 'NEUTRAL';

export interface Signal {
  source: SignalSource;
  direction: SignalDirection;
  confidence: number;  // 0.0 – 1.0
  token: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

// ============================================================
//  TRADE DECISIONS
// ============================================================
export type TradeAction = 'BUY' | 'SELL' | 'PARTIAL_SELL' | 'HOLD';

export interface TradeDecision {
  action: TradeAction;
  token: string;
  tokenInfo: TokenInfo;
  positionSizeUsdc: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  confidence: number;
  entropy: number;
  signals: Signal[];
  regime: MarketRegime;
  reason: string;
  partialFraction?: number;
}

// ============================================================
//  MARKET REGIME
// ============================================================
export enum MarketRegime {
  TRENDING_UP = 'TRENDING_UP',
  TRENDING_DOWN = 'TRENDING_DOWN',
  MEAN_REVERTING = 'MEAN_REVERTING',
  HIGH_VOLATILITY = 'HIGH_VOLATILITY',
  LOW_VOLATILITY = 'LOW_VOLATILITY',
  RANDOM_WALK = 'RANDOM_WALK',
}

export interface RegimeState {
  regime: MarketRegime;
  hurstExponent: number;     // H > 0.6 trending, H < 0.4 mean-reverting
  atrPercentile: number;     // 0–100, where ATR sits vs last 200 samples
  emaAlignment: number;      // +1 fully bullish alignment, -1 fully bearish
  confidence: number;        // how confident we are in this regime classification
  since: number;             // timestamp when current regime started
}

// ============================================================
//  POSITIONS
// ============================================================
export interface Position {
  id: string;
  symbol: string;
  mint: string;
  decimals: number;
  entryPrice: number;
  tokenAmount: number;
  investedUsdc: number;
  openedAt: number;
  stopPrice: number;
  targetPrice: number;
  peakPrice: number;
  troughPrice: number;
  partialDone: boolean;
  partialPnl: number;
  regime: MarketRegime;
  entrySignals: string[];     // signal sources that triggered entry
  entryConfidence: number;
  pyramidLevel?: number;
}

// ============================================================
//  PORTFOLIO STATE
// ============================================================
export interface PortfolioState {
  totalValue: number;         // USDC value of all positions + cash
  cashAvailable: number;      // USDC available for new trades
  positionsCount: number;
  totalExposurePct: number;   // % of portfolio in open positions
  unrealizedPnl: number;
  realizedPnl: number;
  dailyPnl: number;
  weeklyPnl: number;
  drawdownPct: number;        // current drawdown from peak
  peakValue: number;          // highest portfolio value ever
}

// ============================================================
//  RISK LIMITS
// ============================================================
export interface RiskLimits {
  maxPositions: number;
  maxExposurePct: number;       // max % of portfolio in trades
  maxPerPositionPct: number;    // max % of portfolio in single trade
  maxDailyDrawdownPct: number;
  maxWeeklyDrawdownPct: number;
  maxSingleTradeLossPct: number;
  consecutiveLossLimit: number; // reduce size after N losses
  entropyThreshold: number;     // reduce size when entropy > this
  pauseDurationMs: number;      // how long to pause after circuit breaker
  minTradeUsdc: number;
  maxTradeUsdc: number;
}

// ============================================================
//  TRADE JOURNAL
// ============================================================
export interface JournalEntry {
  id: string;
  symbol: string;
  action: TradeAction;
  entryPrice: number;
  exitPrice?: number;
  positionSize: number;
  tokenAmount: number;
  pnl: number;
  pnlPct: number;
  slippage: number;           // actual vs expected price
  fees: number;
  executionMs: number;        // latency from decision to confirmation
  signals: Signal[];          // exit signals
  entrySignals?: string[];    // sources of signals that triggered entry
  regime: MarketRegime;
  kellyFraction: number;
  portfolioValueBefore: number;
  portfolioValueAfter: number;
  timestamp: number;
  txSignature?: string;
}

// ============================================================
//  METRICS
// ============================================================
export interface MetricsSnapshot {
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  expectancyPerTrade: number;  // avg $ expectancy
  totalTrades: number;
  totalPnl: number;
  period: 'session' | '24h' | '7d' | '30d' | 'all';
}

// ============================================================
//  DATA BUS EVENTS
// ============================================================
export type DataBusEvent =
  | 'price:update'
  | 'signal:generated'
  | 'trade:executed'
  | 'regime:change'
  | 'whale:alert'
  | 'risk:circuit-breaker'
  | 'position:opened'
  | 'position:closed'
  | 'metrics:updated'
  | 'engine:tick';

// ============================================================
//  ORDER FLOW
// ============================================================
export interface OrderFlowState {
  buyVolume1m: number;
  sellVolume1m: number;
  buyVolume5m: number;
  sellVolume5m: number;
  buyVolume15m: number;
  sellVolume15m: number;
  ofi1m: number;   // order flow imbalance: (buy - sell) / total
  ofi5m: number;
  ofi15m: number;
  lastUpdate: number;
}

// ============================================================
//  BOLLINGER BANDS
// ============================================================
export interface BollingerState {
  upper: number;
  middle: number;  // SMA
  lower: number;
  percentB: number; // (price - lower) / (upper - lower)
  bandwidth: number; // (upper - lower) / middle
}

// ============================================================
//  WHALE EVENTS
// ============================================================
export interface WhaleEvent {
  wallet: string;
  token: string;
  direction: 'BUY' | 'SELL';
  amountUsd: number;
  timestamp: number;
  txSignature: string;
}

export interface SmartMoneyFlow {
  token: string;
  netFlowUsd: number;      // positive = net buying
  buyCount: number;
  sellCount: number;
  distinctWallets: number;
  window: '30m' | '1h' | '4h';
  isClusterBuy: boolean;   // 3+ wallets buying within window
  isClusterSell: boolean;
}
