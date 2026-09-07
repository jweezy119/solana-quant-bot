/**
 * Coinbase Risk Manager & Quant Compounding Engine
 * ────────────────────────────────────────────────
 * Implements fractional Kelly Criterion position sizing with
 * geometric compounding, bankroll scaling for $100+ capital,
 * correlation penalties, trailing stops, sound alerts, and journal tracking.
 */

import fs from 'fs';
import path from 'path';
import {
  getProduct,
  getTicker,
  getCandles,
  createLimitOrder,
  createMarketOrder,
  getAccountBalance,
  getOrder,
  cancelOrder,
} from './client';
import { playTransactionSound } from './sound';

export interface AIOrderProposal {
  productId: string;   // e.g. "BTC-USD"
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;  // 0.0 to 1.0
  reasoning: string;
  strategy?: 'STANDARD' | 'LISTING_MOMENTUM';
  maxHoldDurationMs?: number;
  atrPct?: number;     // Asset's current volatility for dynamic sizing
}

export interface CoinbasePosition {
  productId: string;
  baseCurrency: string;
  entryPrice: number;
  sizeUsd: number;
  quantity: number;
  entryTime: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  highestPriceSeen: number;
  simulated: boolean;
  orderId?: string;
  buyFeeUsd?: number;
  orderType?: 'MAKER' | 'TAKER';
  strategy?: 'STANDARD' | 'LISTING_MOMENTUM' | 'VERIFY';
  runnerMode?: boolean;
  maxHoldDurationMs?: number;
}

export interface CoinbaseTradeRecord {
  id: string;
  productId: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  sizeUsd: number;
  grossPnlUsd: number;
  feesPaidUsd: number;
  netPnlUsd: number;
  pnlUsd: number; // Kept for backwards compatibility (equals netPnlUsd)
  pnlPct: number; // Net return %
  entryTime: number;
  exitTime: number;
  reason: string;
  simulated: boolean;
  orderType?: string;
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const POSITIONS_FILE = path.join(DATA_DIR, 'coinbase-positions.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'coinbase-journal.json');

// ─── STOP-LOSS RE-ENTRY COOLDOWN ──────────────────────────────
// Prevents death-spiral re-entries after getting stopped out on the same asset
const STOP_LOSS_COOLDOWNS: Record<string, number> = {};
const STOP_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h cooldown after a stop-loss (was 30m — TROLL bled 12 trades)
const MAX_STOPS_PER_PRODUCT_PER_DAY = 2; // Hard daily stop budget per product

function getStopDayKey(dateMs = Date.now()): string {
  return new Date(dateMs).toISOString().slice(0, 10);
}

// Throttle repeated "FEE-HURDLE HOLD" logging from the 1s stop/target loop
const LAST_HOLD_LOG_TS: Record<string, number> = {};

// ─── RECENT REJECTION LOG (shared with the dashboard) ────────
// Lets the dashboard show WHY the bot is standing down instead of looking broken.
export interface RiskRejection {
  timestamp: number;
  productId: string;
  action: string;
  reason: string;
}
const RECENT_REJECTIONS: RiskRejection[] = [];
const MAX_REJECTIONS = 20;

export function getRecentRejections(): RiskRejection[] {
  return RECENT_REJECTIONS.slice(0, MAX_REJECTIONS);
}

function logRejection(productId: string, action: string, reason: string) {
  RECENT_REJECTIONS.unshift({ timestamp: Date.now(), productId, action, reason });
  if (RECENT_REJECTIONS.length > MAX_REJECTIONS) RECENT_REJECTIONS.pop();
}

/**
 * Current risk stance for the dashboard: whether the bot has a live statistical
 * edge (recent-30 window Kelly) and which products are currently trade-blocked.
 */
export function getRiskStance() {
  const journal = loadJournal();
  const recent = journal.slice(-30);
  const completed = recent.length;
  const winners = recent.filter((t) => (t.netPnlUsd ?? t.pnlUsd ?? 0) > 0.005);
  const losers = recent.filter((t) => (t.netPnlUsd ?? t.pnlUsd ?? 0) < -0.005);
  const avg = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
  const winRate = completed >= 10 ? winners.length / completed : 0.55;
  const avgWin = winners.length > 0 ? avg(winners.map((t) => t.netPnlUsd ?? t.pnlUsd)) : 0.02;
  const avgLoss = losers.length > 0 ? Math.abs(avg(losers.map((t) => t.netPnlUsd ?? t.pnlUsd))) : 0.04;
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 1.0;
  const kellyRaw = Math.max(0, (winRate * winLossRatio - (1 - winRate)) / winLossRatio);

  const dayKey = getStopDayKey();
  const blockedToday = new Set<string>();
  const perDay: Record<string, number> = {};
  for (const t of journal) {
    if (t.reason?.toLowerCase().includes('stop-loss') && getStopDayKey(t.exitTime) === dayKey) {
      perDay[t.productId] = (perDay[t.productId] || 0) + 1;
      if (perDay[t.productId] >= MAX_STOPS_PER_PRODUCT_PER_DAY) blockedToday.add(t.productId);
    }
  }

  const cooldownBlocked = Object.keys(STOP_LOSS_COOLDOWNS).filter(
    (p) => Date.now() - STOP_LOSS_COOLDOWNS[p] < STOP_COOLDOWN_MS,
  );

  const { family, burners } = trustStats();

  return {
    kellyRaw: parseFloat(kellyRaw.toFixed(3)),
    standDown: kellyRaw <= 0,
    recentWindowTrades: completed,
    recentWinRatePct: parseFloat((completed >= 10 ? (winners.length / completed) * 100 : winRate * 100).toFixed(1)),
    blockedToday: Array.from(blockedToday),
    cooldownBlocked,
    feesToday: parseFloat(todayFeesUsd().toFixed(2)),
    maxFeesPerDay: MAX_FEES_PER_DAY_USD,
    zeroFeeFamily: Array.from(family),
    bannedProducts: Array.from(burners),
  };
}

// ─── LIQUIDITY FLOOR ─────────────────────────────────────────
// Journal verdict: every profitable trade this bot made was on a liquid product
// with real arb (BONK 15W/1L). Every loss cluster was phantom-liquidity micro-caps
// (TROLL 3W/9L, WAL, PNUT, FORTH) where "arbitrage" is slippage in disguise. Refuse
// to touch anything without meaningful 24h notional volume.
const MIN_NOTIONAL_24H_USD = parseFloat(process.env.COINBASE_MIN_NOTIONAL_USD || '500000');
const LIQUIDITY_CACHE: Record<string, { ts: number; ok: boolean; notional24hUsd: number }> = {};

async function checkProductLiquidity(productId: string): Promise<{ ok: boolean; notional24hUsd: number }> {
  const cached = LIQUIDITY_CACHE[productId];
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    return { ok: cached.ok, notional24hUsd: cached.notional24hUsd };
  }
  try {
    const ticker = (await getTicker(productId)) as any;
    const price = parseFloat(ticker?.price || ticker?.last_price || ticker?.trades?.[0]?.price || '0');
    // Per-product /ticker does NOT always include volume_24h — read it if present,
    // otherwise fall back to summing 24h of 15m candles (base volume × avg price).
    let volume24h = parseFloat(ticker?.volume_24h || '0');
    let notional = price > 0 ? volume24h * price : volume24h;

    if (notional < MIN_NOTIONAL_24H_USD) {
      try {
        const now = Math.floor(Date.now() / 1000);
        const res = (await getCandles(productId, now - 3600 * 24, now, 'FIFTEEN_MINUTE')) as any;
        const candles = (res?.candles || []).slice().reverse();
        let vol = 0;
        let pSum = 0;
        let cnt = 0;
        for (const c of candles) {
          vol += parseFloat(c.volume || '0');
          const avg = (parseFloat(c.low || '0') + parseFloat(c.high || '0')) / 2;
          if (avg > 0) { pSum += avg; cnt++; }
        }
        if (vol > 0 && cnt > 0) {
          notional = Math.max(notional, vol * (pSum / cnt));
        }
        if (!price && cnt > 0) {
          notional = vol * (pSum / cnt);
        }
      } catch {}
    }

    const ok = notional >= MIN_NOTIONAL_24H_USD;
    LIQUIDITY_CACHE[productId] = { ts: Date.now(), ok, notional24hUsd: notional };
    return { ok, notional24hUsd: notional };
  } catch {
    // Fail-open on API hiccups; a transient network error shouldn't halt trading.
    return { ok: true, notional24hUsd: 0 };
  }
}

// ─── GOD MODE: FEE-ZERO MAKER FAMILY + DUST-VERIFY + RUNNERS ─────────────
// Journal verdict: 100% of profit came from zero-fee maker fills (BONK 17 trades
// +$1.57 / $0.00 fees, FARTCOIN +$0.22 / $0.00). EVERY product that paid maker
// fees lost money (TROLL $2.62 fees → -$3.44, FORTH, UNI, PNUT, ALEPH, WAL).
// GOD MODE = only ever make on books that fill you at $0. Books that paid fees
// are BANNED; books with no history get DUST until they prove they fill fee-free.
const VERIFY_SIZE_USD = parseFloat(process.env.COINBASE_VERIFY_SIZE_USD || '5');
const MAX_VERIFY_POSITIONS = 1;
const MAX_FEES_PER_DAY_USD = parseFloat(process.env.COINBASE_MAX_FEES_PER_DAY_USD || '0.50');
const MIN_ZERO_FEE_WINS = 3;                       // closed trades to earn Verified family status
const MAX_ZERO_FEE_LEAK_USD = 0.02;                // residual fees tolerated for Verified members
const FEE_BURNER_LEAK_USD = 0.05;                  // total fees paid (any history) ⇒ banned forever
const RUNNER_TP_PCT = parseFloat(process.env.COINBASE_RUNNER_TP_PCT || '0.12');          // widened TP for zero-fee family
const RUNNER_ACTIVATE_PCT = parseFloat(process.env.COINBASE_RUNNER_ACTIVATE_PCT || '0.04'); // trail activates at +4% peak
const RUNNER_TRAIL_PCT = parseFloat(process.env.COINBASE_RUNNER_TRAIL_PCT || '0.035');   // 3.5% give-back from peak
const RUNNER_MAX_HOLD_MS = parseFloat(process.env.COINBASE_RUNNER_MAX_HOLD_HRS || '8') * 60 * 60 * 1000;
const RISK_OFF_24H_CHANGE_PCT = parseFloat(process.env.COINBASE_RISK_OFF_PCT || '2');    // ≤ -2% BTC 24h ⇒ risk-off

const TRUST_CACHE: { ts: number; data: { family: Set<string>; burners: Set<string> } } = {
  ts: 0,
  data: { family: new Set<string>(), burners: new Set<string>() },
};

function trustStats() {
  if (Date.now() - TRUST_CACHE.ts < 60_000) return TRUST_CACHE.data;
  const journal = loadJournal();
  const fees: Record<string, number> = {};
  const count: Record<string, number> = {};
  for (const t of journal) {
    fees[t.productId] = (fees[t.productId] || 0) + (t.feesPaidUsd || 0);
    count[t.productId] = (count[t.productId] || 0) + 1;
  }
  const family = new Set<string>();
  const burners = new Set<string>();
  for (const pid of Object.keys(fees)) {
    const total = fees[pid] || 0;
    const n = count[pid] || 0;
    if (total >= FEE_BURNER_LEAK_USD) burners.add(pid);
    else if (total <= MAX_ZERO_FEE_LEAK_USD && n >= MIN_ZERO_FEE_WINS) family.add(pid);
  }
  TRUST_CACHE.data = { family, burners };
  TRUST_CACHE.ts = Date.now();
  return TRUST_CACHE.data;
}

export function getProductTrust(productId: string): 'VERIFIED' | 'BANNED' | 'UNVERIFIED' {
  const { family, burners } = trustStats();
  if (burners.has(productId)) return 'BANNED';
  if (family.has(productId)) return 'VERIFIED';
  return 'UNVERIFIED';
}

export function getZeroFeeFamily(): string[] {
  return Array.from(trustStats().family);
}

export function getBannedProducts(): string[] {
  return Array.from(trustStats().burners);
}

/** Sum of fees actually paid today (UTC) — the GOD-mode fee-leak kill-switch input. */
export function todayFeesUsd(): number {
  const dayKey = getStopDayKey();
  return loadJournal()
    .filter((t) => getStopDayKey(t.exitTime) === dayKey)
    .reduce((s, t) => s + (t.feesPaidUsd || 0), 0);
}

const CANDLE_REGIME_CACHE: { ts: number; regime: 'BULL' | 'BEAR' } = { ts: 0, regime: 'BULL' };

/**
 * Infer market regime from Coinbase candles: risk-off when the anchor product
 * (BTC, falling back to the proven BONK book) is down ≥2% over 24h. This makes
 * the regime signal data-driven instead of relying only on the env override.
 */
async function getCandleRegime(): Promise<'BULL' | 'BEAR'> {
  if (Date.now() - CANDLE_REGIME_CACHE.ts < 5 * 60 * 1000) return CANDLE_REGIME_CACHE.regime;
  const now = Math.floor(Date.now() / 1000);
  for (const anchor of ['BTC-USDC', 'BONK-USDC']) {
    try {
      const res = (await getCandles(anchor, now - 3600 * 25, now, 'ONE_HOUR')) as any;
      const candles = (res?.candles || []).slice().reverse();
      if (candles.length < 12) continue;
      const closes = candles.map((c: any) => parseFloat(c.close));
      const ref24 = closes.length >= 25 ? closes[closes.length - 25] : closes[0];
      const last = closes[closes.length - 1];
      const chg24 = ref24 > 0 ? ((last - ref24) / ref24) * 100 : 0;
      const regime: 'BULL' | 'BEAR' = chg24 <= -RISK_OFF_24H_CHANGE_PCT ? 'BEAR' : 'BULL';
      CANDLE_REGIME_CACHE.regime = regime;
      CANDLE_REGIME_CACHE.ts = Date.now();
      return regime;
    } catch {
      continue;
    }
  }
  // Fail-open: a candle API hiccup should not freeze trading.
  CANDLE_REGIME_CACHE.regime = 'BULL';
  CANDLE_REGIME_CACHE.ts = Date.now();
  return 'BULL';
}

// ─── QUANT RISK & COMPOUNDING CONFIG (FEE-AWARE MAKER CALIBRATION) ─────────
const IS_BEAR_SNIPER = process.env.COINBASE_REGIME !== 'BULL';

export const QUANT_CONFIG = {
  minTradeUsd: 10.00,                                     // Raised to $10 so maker fees don't eat micro-profits
  maxPositionPct: IS_BEAR_SNIPER ? 0.20 : 0.25,           // Lowered to 25% to spread risk across more assets
  maxConcurrentPositions: IS_BEAR_SNIPER ? 3 : 4,         // Increased to 4 concurrent positions
  minCashReserveUsd: IS_BEAR_SNIPER ? 10.00 : 5.00,       // Keep a $5 cash buffer
  minConfidenceThreshold: IS_BEAR_SNIPER ? 0.70 : 0.65,   // Require 70%+ high conviction
  stopLossPct: 0.035,                                     // Widened to -3.5% (prevents getting chopped out by noise)
  takeProfitPct: 0.055,                                   // Widened to +5.5% (outruns the 1.2% round-trip maker fee)
  trailingTriggerPct: 0.035,                              // Activate trailing ratchet at +3.5% gain
  trailingLockPct: 0.018,                                 // Lock stop to +1.8% (guarantees positive cash after 1.2% fee)
  makerFeeRate: 0.006,                                    // 0.60% Coinbase Intro 1 Maker fee
  takerFeeRate: 0.012,                                    // 1.20% Taker fee
  executionMode: 'LIMIT_MAKER',                           // Strict post-only maker limit orders
  regime: IS_BEAR_SNIPER ? 'BEAR_SNIPER' : 'NORMAL',
};

// ─── PERSISTENCE ──────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function formatSizeByIncrement(amount: number, incrementStr: string): string {
  const parts = incrementStr.split('.');
  const decimals = parts.length > 1 ? parts[1].length : 0;
  const factor = Math.pow(10, decimals);
  const floored = Math.floor(amount * factor) / factor;
  return floored.toFixed(decimals);
}

function runnerPriceFmt(p: number): string {
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(8);
}

export function loadPositions(): Record<string, CoinbasePosition> {
  ensureDataDir();
  if (!fs.existsSync(POSITIONS_FILE)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(POSITIONS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function savePositions(positions: Record<string, CoinbasePosition>) {
  ensureDataDir();
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2), 'utf-8');
}

export function loadJournal(): CoinbaseTradeRecord[] {
  ensureDataDir();
  if (!fs.existsSync(JOURNAL_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(JOURNAL_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function recordTrade(trade: CoinbaseTradeRecord) {
  ensureDataDir();
  const journal = loadJournal();
  journal.push(trade);
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2), 'utf-8');
}

export function getPerformanceMetrics() {
  const journal = loadJournal();
  let totalNetPnl = 0;
  let totalGrossPnl = 0;
  let totalFeesPaid = 0;
  let wins = 0;
  let losses = 0;
  let breakevens = 0;

  for (const t of journal) {
    const net = t.netPnlUsd !== undefined ? t.netPnlUsd : t.pnlUsd;
    totalNetPnl += net;
    totalGrossPnl += t.grossPnlUsd !== undefined ? t.grossPnlUsd : (t.pnlUsd > 0 ? t.pnlUsd : 0);
    totalFeesPaid += t.feesPaidUsd !== undefined ? t.feesPaidUsd : 0;
    if (net > 0.01) wins++;
    else if (net < -0.01) losses++;
    else breakevens++;
  }

  const completed = wins + losses + breakevens;
  const winRatePct = completed > 0 ? (wins / completed) * 100 : 0;

  return {
    totalRealizedPnl: parseFloat(totalNetPnl.toFixed(2)),
    totalGrossPnl: parseFloat(totalGrossPnl.toFixed(2)),
    totalFeesPaid: parseFloat(totalFeesPaid.toFixed(2)),
    totalTrades: completed,
    wins,
    losses,
    breakevens,
    winRatePct: parseFloat(winRatePct.toFixed(1)),
  };
}

export function isSimulationMode(): boolean {
  return process.env.COINBASE_SIMULATION !== 'false';
}

// ─── QUANT KELLY COMPOUNDING SIZER ────────────────────────────

export function calculateCompoundedSize(
  totalEquityUsd: number,
  confidence: number,
  existingPositionsCount: number,
): { tradeAmountUsd: number; sizingPct: number; kellyRaw: number } {
  // Adaptive Kelly from the RECENT journal window (last 30 closes) so the sizer
  // follows the current regime instead of lifetime averages that lag by weeks.
  const journal = loadJournal();
  const recent = journal.slice(-30);
  const completed = recent.length;
  const winners = recent.filter((t) => t.netPnlUsd > 0.005);
  const losers = recent.filter((t) => t.netPnlUsd < -0.005);
  const avg = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);

  const winRate = completed >= 10 ? winners.length / completed : 0.55;
  const avgWin = winners.length > 0 ? avg(winners.map((t) => t.netPnlUsd)) : 0.02;
  const avgLoss = losers.length > 0 ? Math.abs(avg(losers.map((t) => t.netPnlUsd))) : 0.04;
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 1.0;

  // Protect against negative kelly by maxing with 0
  const kellyRaw = Math.max(0, (winRate * winLossRatio - (1 - winRate)) / winLossRatio);

  // No recent edge → do NOT trade. The old `safeKelly = 0.10` / `Math.max(0.08, ...)`
  // floor kept forcing 8–10% positions after the edge was already gone, which is
  // exactly how this bankroll bled out. At these sizes the fixed $10 min-trade and
  // ~1.2% round-trip fee make break-even trading strictly -EV.
  if (kellyRaw <= 0) {
    return { tradeAmountUsd: 0, sizingPct: 0, kellyRaw: parseFloat(kellyRaw.toFixed(3)) };
  }

  const safeKelly = kellyRaw * 0.5; // Half-Kelly: conservative even with a real edge

  const correlationFactor = Math.max(0.60, 1 - existingPositionsCount * 0.15);
  const confidenceMultiplier = Math.max(0.5, confidence);

  // Removed the 1.5x inflator that forced max position size
  const dynamicFraction = safeKelly * confidenceMultiplier * correlationFactor;
  const cappedFraction = Math.min(QUANT_CONFIG.maxPositionPct, dynamicFraction);

  // Bankroll protection: below $100 the fixed $10 min-trade dominates; refuse to
  // force an oversized position just to participate.
  const minSizingPct = totalEquityUsd <= 100 ? 0.06 : 0.04;
  if (cappedFraction < minSizingPct) {
    return {
      tradeAmountUsd: 0,
      sizingPct: parseFloat((cappedFraction * 100).toFixed(1)),
      kellyRaw: parseFloat(kellyRaw.toFixed(3)),
    };
  }

  const tradeAmountUsd = Math.min(
    totalEquityUsd * cappedFraction,
    totalEquityUsd * QUANT_CONFIG.maxPositionPct,
  );

  return {
    tradeAmountUsd: parseFloat(tradeAmountUsd.toFixed(2)),
    sizingPct: parseFloat((cappedFraction * 100).toFixed(1)),
    kellyRaw: parseFloat(kellyRaw.toFixed(3)),
  };
}

/**
 * Execute or simulate AI trade proposal with compounding risk management
 */
export async function executeAIProposal(
  proposal: AIOrderProposal,
  availableCashUsd: number,
  currentPrice: number,
  totalEquityUsd?: number,
) {
  if (proposal.action === 'HOLD') {
    return { success: false, reason: 'Action is HOLD' };
  }

  const isSim = isSimulationMode();
  const positions = loadPositions();
  const [baseCurrency, quoteCurrency] = proposal.productId.split('-');
  const openCount = Object.keys(positions).length;
  const equity = totalEquityUsd || availableCashUsd;

  console.log(`\n🧠 AI PROPOSAL: ${proposal.action} ${proposal.productId} [${isSim ? 'SIMULATION' : 'LIVE'}]`);
  console.log(`   Confidence: ${(proposal.confidence * 100).toFixed(1)}%`);
  console.log(`   Reasoning: "${proposal.reasoning}"`);

  if (proposal.confidence < QUANT_CONFIG.minConfidenceThreshold) {
    console.log(`   ❌ REJECTED: Confidence ${(proposal.confidence * 100).toFixed(1)}% is below ${(QUANT_CONFIG.minConfidenceThreshold * 100)}% threshold.`);
    return { success: false, reason: 'Low confidence' };
  }

  try {
    const product = (await getProduct(proposal.productId)) as any;
    if (product.status !== 'online') {
      console.log(`   ❌ REJECTED: ${proposal.productId} is currently offline.`);
      return { success: false, reason: 'Market offline' };
    }

    // ─── BUY ACTION (MAKER LIMIT) ───────────────────────────
    if (proposal.action === 'BUY') {
      if (openCount >= QUANT_CONFIG.maxConcurrentPositions) {
        console.log(`   ❌ REJECTED: Max positions limit reached (${openCount}/${QUANT_CONFIG.maxConcurrentPositions}).`);
        return { success: false, reason: 'Max positions limit' };
      }

      if (positions[proposal.productId]) {
        console.log(`   ℹ️ Already holding active position in ${proposal.productId}. Skipping additional entry.`);
        return { success: false, reason: 'Already in position' };
      }

      // Stop-loss re-entry cooldown — prevent death-spiral cascades (e.g. TROLL 8x stop-outs)
      const lastStopTime = STOP_LOSS_COOLDOWNS[proposal.productId];
      if (lastStopTime && Date.now() - lastStopTime < STOP_COOLDOWN_MS) {
        const minsLeft = Math.round((STOP_COOLDOWN_MS - (Date.now() - lastStopTime)) / 60000);
        console.log(`   ❌ COOLDOWN: ${proposal.productId} was stopped out recently. ${minsLeft}m cooldown remaining.`);
        logRejection(proposal.productId, 'BUY', `Stop-loss cooldown (${minsLeft}m left)`);
        return { success: false, reason: 'Stop-loss cooldown active' };
      }

      // Hard daily stop budget per product (read from journal so it survives restarts)
      const dayKey = getStopDayKey();
      const todayStops = loadJournal().filter(
        (t) =>
          t.productId === proposal.productId &&
          t.reason.toLowerCase().includes('stop-loss') &&
          getStopDayKey(t.exitTime) === dayKey,
      ).length;
      if (todayStops >= MAX_STOPS_PER_PRODUCT_PER_DAY) {
        console.log(`   ❌ DAILY STOP CAP: ${proposal.productId} already stopped ${todayStops}x today. Standing down until tomorrow.`);
        logRejection(proposal.productId, 'BUY', `Daily stop cap reached (${todayStops}x stops today)`);
        return { success: false, reason: 'Daily stop cap reached' };
      }

      // GOD 1 — Fee-burner ban: any history of paying maker fees = banned forever.
      // The ledger proved fee-paying books are the whole loss cluster.
      const trust = getProductTrust(proposal.productId);
      if (trust === 'BANNED') {
        console.log(`   ❌ FEE-BURNER BAN: ${proposal.productId} paid real maker fees in history. Banned permanently (leak cluster).`);
        logRejection(proposal.productId, 'BUY', 'Fee-burner banned (paid maker fees in history)');
        return { success: false, reason: 'Fee-burner banned' };
      }

      // GOD 4 — Daily fee-leak kill-switch: if fees burned ≥ cap today, ALL buys halt.
      const feesToday = todayFeesUsd();
      if (feesToday >= MAX_FEES_PER_DAY_USD) {
        console.log(`   ❌ FEE BUDGET: $${feesToday.toFixed(2)} fees today ≥ $${MAX_FEES_PER_DAY_USD.toFixed(2)} cap. Halting all BUYs until rollover.`);
        logRejection(proposal.productId, 'BUY', `Daily fee budget exhausted ($${feesToday.toFixed(2)} fees today)`);
        return { success: false, reason: 'Daily fee budget exhausted' };
      }

      if (availableCashUsd - QUANT_CONFIG.minTradeUsd < QUANT_CONFIG.minCashReserveUsd) {
        console.log(`   ❌ REJECTED: Insufficient cash ($${availableCashUsd.toFixed(2)}) to maintain $${QUANT_CONFIG.minCashReserveUsd} buffer.`);
        return { success: false, reason: 'Cash buffer protection' };
      }

      // Liquidity floor — refuse phantom-liquidity micro-caps (the entire loss cluster)
      const liquidity = await checkProductLiquidity(proposal.productId);
      if (!liquidity.ok) {
        console.log(`   ❌ LOW LIQUIDITY: ${proposal.productId} 24h notional $${liquidity.notional24hUsd.toFixed(0)} < $${MIN_NOTIONAL_24H_USD.toLocaleString()} min. Skipping.`);
        logRejection(proposal.productId, 'BUY', `Low liquidity (24h notional $${liquidity.notional24hUsd.toFixed(0)})`);
        return { success: false, reason: 'Low liquidity' };
      }

      const { tradeAmountUsd, sizingPct, kellyRaw } = calculateCompoundedSize(equity, proposal.confidence, openCount);
      let finalTradeUsd = Math.min(tradeAmountUsd, Math.max(0, availableCashUsd - QUANT_CONFIG.minCashReserveUsd));
      const minSize = parseFloat(product.quote_min_size || '1.0');

      // GOD 2 — Dust-verify fallback: when Kelly shows no compounding edge (or the
      // edge is too small for this bankroll), do NOT freeze forever like Phase 2 did.
      // Trade dust-size makes on the fee-free family so the recent-30 window regenerates
      // with REAL samples. The old permanent stand-down just kept measuring stale losers.
      let verificationMode = false;
      if (finalTradeUsd < minSize || finalTradeUsd < QUANT_CONFIG.minTradeUsd) {
        verificationMode = true;
        const verifySlots = Object.values(positions).filter((p) => p.strategy === 'VERIFY').length;
        if (verifySlots >= MAX_VERIFY_POSITIONS) {
          console.log(`   ❌ Kelly stand-down: no edge in recent-30 window + verification slot busy (${verifySlots}/${MAX_VERIFY_POSITIONS}).`);
          logRejection(proposal.productId, 'BUY', `Kelly stand-down (${kellyRaw}) — verify slot busy`);
          return { success: false, reason: 'Kelly stand-down (verify slot busy)' };
        }
        const verifySize = Math.max(VERIFY_SIZE_USD, minSize);
        const verifyBudget = Math.max(0, availableCashUsd - QUANT_CONFIG.minCashReserveUsd);
        if (verifySize > verifyBudget) {
          console.log(`   ❌ Kelly stand-down: cash $${verifyBudget.toFixed(2)} can't cover $${verifySize.toFixed(2)} verify dust.`);
          logRejection(proposal.productId, 'BUY', 'Kelly stand-down (cash below verify dust)');
          return { success: false, reason: 'Kelly stand-down' };
        }
        finalTradeUsd = verifySize;
        console.log(`   🔬 VERIFY MODE: Kelly ${kellyRaw} (no compounding edge). Trading $${finalTradeUsd.toFixed(2)} dust make on ${proposal.productId} to re-prove the fee-free family.`);
      }

      // GOD 3 — Candle regime gate: in a data-driven risk-off (BTC down ≥2%/24h) only
      // capitulation-reversal setups and dust-verifications may buy. Momentum/listing
      // chases hold in USDC and wait for the trend to turn.
      if (!verificationMode) {
        const regime = await getCandleRegime();
        const reasoningTxt = (proposal.reasoning || '').toLowerCase();
        const isCapitulation = reasoningTxt.includes('capitulation') || reasoningTxt.includes('reversal');
        if (regime === 'BEAR' && !isCapitulation) {
          console.log(`   ❌ RISK-OFF REGIME (BTC 24h trend down): trend/momentum buy on ${proposal.productId} suppressed. Capitulation-reversal or dust-verify only.`);
          logRejection(proposal.productId, 'BUY', 'Risk-off regime (BTC trending down ≥2%/24h)');
          return { success: false, reason: 'Risk-off regime' };
        }
      }

      if (finalTradeUsd < minSize) {
        console.log(`   ❌ REJECTED: Final trade $${finalTradeUsd.toFixed(2)} below quote_min_size $${minSize}.`);
        return { success: false, reason: 'Below minimum size' };
      }

      // Runner mode = the trade lives on a proven fee-zero (or probing) book — winners
      // get a widened target + trailing ratchet instead of the old micro-premium snipe.
      const strategyTag: CoinbasePosition['strategy'] = verificationMode
        ? 'VERIFY'
        : proposal.strategy || 'STANDARD';
      const runnerMode = trust === 'VERIFIED';

      const formatP = (p: number) => p >= 1 ? `$${p.toFixed(2)}` : p >= 0.01 ? `$${p.toFixed(4)}` : `$${p.toFixed(8)}`;
      console.log(`   📐 Compounding Sizer: $${finalTradeUsd.toFixed(2)} (${sizingPct}% of $${equity.toFixed(2)} equity) ${verificationMode ? '[VERIFY]' : runnerMode ? '[RUNNER]' : ''}`);

      let orderId = `paper-${Date.now()}`;
      let buyFeeUsd = 0;
      let actualEntryPrice = currentPrice;
      let actualQuantity = finalTradeUsd / currentPrice;

      if (!isSim) {
        const actualQuoteBal = await getAccountBalance(quoteCurrency);
        if (actualQuoteBal - finalTradeUsd < QUANT_CONFIG.minCashReserveUsd) {
          console.log(`   ❌ REJECTED: Insufficient ${quoteCurrency} balance ($${actualQuoteBal.toFixed(2)}) to trade $${finalTradeUsd.toFixed(2)} and keep $${QUANT_CONFIG.minCashReserveUsd} reserve.`);
          return { success: false, reason: `Insufficient ${quoteCurrency} balance` };
        }

        // Fetch live orderbook best bid/ask
        const ticker = (await getTicker(proposal.productId)) as any;
        const bestBid = parseFloat(ticker.best_bid || currentPrice.toString());
        const limitPriceNum = bestBid > 0 ? bestBid : currentPrice;
        const limitPriceStr = formatSizeByIncrement(limitPriceNum, product.quote_increment || '0.0001');
        const calculatedQty = finalTradeUsd / limitPriceNum;
        const qtyStr = formatSizeByIncrement(calculatedQty, product.base_increment || '0.0001');

        if (parseFloat(qtyStr) < parseFloat(product.base_min_size || '0')) {
          console.log(`   ❌ REJECTED: Base quantity ${qtyStr} below base_min_size ${product.base_min_size}`);
          return { success: false, reason: 'Below base_min_size' };
        }

        console.log(`   ⚡ Submitting MAKER LIMIT BUY for ${qtyStr} ${baseCurrency} @ $${limitPriceStr} (post_only: true)...`);
        try {
          const order = (await createLimitOrder(proposal.productId, 'BUY', qtyStr, limitPriceStr, true)) as any;
          orderId = order.order_id || order.success_response?.order_id;
          if (!orderId) {
            throw new Error(`Limit order submitted but missing order_id`);
          }
          console.log(`   📝 Maker Limit Order Submitted (ID: ${orderId}). Waiting up to 16s for maker fill...`);

          // Poll up to 16s for maker fill
          let isFilled = false;
          for (let attempt = 0; attempt < 8; attempt++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const checkOrder = await getOrder(orderId);
              const status = checkOrder.order?.status;
              if (status === 'FILLED') {
                isFilled = true;
                buyFeeUsd = parseFloat(checkOrder.order?.total_fees || '0');
                const avgPrice = parseFloat(checkOrder.order?.average_filled_price || limitPriceStr);
                const filledQty = parseFloat(checkOrder.order?.filled_size || qtyStr);
                if (avgPrice > 0) actualEntryPrice = avgPrice;
                if (filledQty > 0) actualQuantity = filledQty;
                console.log(`   ✅ MAKER LIMIT BUY FILLED! Qty: ${actualQuantity} @ $${actualEntryPrice.toFixed(4)} │ Fee: $${buyFeeUsd.toFixed(4)} (0.6% Maker)`);
                break;
              } else if (status === 'CANCELLED' || status === 'EXPIRED' || status === 'FAILED') {
                console.log(`   ⚠️ Order ended with status: ${status}`);
                return { success: false, reason: `Order ${status}` };
              }
            } catch {}
          }

          if (!isFilled) {
            console.log(`   ⏳ Maker Buy order not filled in 16s. Cancelling cleanly to protect capital & avoid taker fees...`);
            await cancelOrder(orderId);
            return { success: false, reason: 'Limit maker order timed out without fill' };
          }
        } catch (err: any) {
          console.log(`   ❌ LIVE MAKER BUY FAILED on Coinbase: ${err.message}`);
          return { success: false, reason: err.message };
        }
      } else {
        // Paper Simulation: verified/runner books fill free (that's the whole edge);
        // unverified books pay the intro maker fee so the sim mirrors real cost.
        buyFeeUsd = runnerMode ? 0 : finalTradeUsd * QUANT_CONFIG.makerFeeRate;
        console.log(`   📝 Paper Trade Logged (Simulation Mode). Est Maker Fee: $${buyFeeUsd.toFixed(4)}${runnerMode ? ' (zero-fee family: $0)' : ''}`);
      }

      let finalStopPct = QUANT_CONFIG.stopLossPct;
      let finalTpPct = strategyTag === 'LISTING_MOMENTUM' ? 0.050 : QUANT_CONFIG.takeProfitPct;
      if (runnerMode) finalTpPct = Math.max(finalTpPct, RUNNER_TP_PCT);

      if (proposal.atrPct && proposal.atrPct > 0) {
        // Base stop on 2.5x the 15-min ATR (gives 2.5 full candles of noise breathing room)
        const dynamicStop = (proposal.atrPct / 100) * 2.5;
        // Keep within bounds: min 2.0% to outrun fees, max 8.0% to prevent catastrophic drawdowns
        finalStopPct = Math.min(0.08, Math.max(0.020, dynamicStop));
        // Target reward-to-risk — but runners always widen to at least the runner target
        finalTpPct = runnerMode
          ? Math.max(RUNNER_TP_PCT, finalStopPct * 1.6)
          : Math.max(0.035, finalStopPct * 1.6);
      }
      
      const stopLoss = actualEntryPrice * (1 - finalStopPct);
      const takeProfit = actualEntryPrice * (1 + finalTpPct);
      
      console.log(`   🎯 Entry: ${formatP(actualEntryPrice)} │ Stop: ${formatP(stopLoss)} (-${(finalStopPct * 100).toFixed(1)}%) │ Target: ${formatP(takeProfit)} (+${(finalTpPct * 100).toFixed(1)}%)`);

      // Play Transaction Sound chime
      playTransactionSound('buy');

      positions[proposal.productId] = {
        productId: proposal.productId,
        baseCurrency,
        entryPrice: actualEntryPrice,
        sizeUsd: finalTradeUsd,
        quantity: actualQuantity,
        entryTime: Date.now(),
        stopLossPrice: stopLoss,
        takeProfitPrice: takeProfit,
        highestPriceSeen: actualEntryPrice,
        simulated: isSim,
        orderId,
        buyFeeUsd,
        orderType: 'MAKER',
        strategy: strategyTag,
        runnerMode,
        maxHoldDurationMs: proposal.maxHoldDurationMs || (runnerMode ? RUNNER_MAX_HOLD_MS : undefined),
      };
      savePositions(positions);

      return { success: true, simulated: isSim, size: finalTradeUsd, orderId };
    }

    // ─── SELL ACTION (MAKER / STOP EXIT) ──────────────────────
    else if (proposal.action === 'SELL') {
      const existing = positions[proposal.productId];
      if (!existing) {
        return { success: false, reason: 'No open position to exit' };
      }

      // ── FEE-HURDLE GATE ──
      // The journal's biggest leak: exits fired with ~0.24–0.45% gross "arbitrage
      // premium" — each one pays ~1.2% round-trip fees and nets negative. Only let
      // discretionary exits through when gross gain clears 1.3x the estimated
      // round-trip fee. Stop-losses always pass (mandatory risk control). Listing
      // rotations may pass once the hold window is exceeded by a 60m grace period
      // (releasing stuck cash beats paying fees to sit flat).
      const isStopLoss = proposal.reasoning.toLowerCase().includes('stop-loss');
      const roundTripFeePct =
        existing.sizeUsd > 0
          ? ((existing.buyFeeUsd || 0) + existing.sizeUsd * QUANT_CONFIG.makerFeeRate) / existing.sizeUsd
          : QUANT_CONFIG.makerFeeRate * 2;
      const grossGainPct = existing.entryPrice > 0 ? ((currentPrice - existing.entryPrice) / existing.entryPrice) * 100 : 0;
      // Runner positions live on fee-zero books — their round-trip cost is ~0, so a
      // 0.10% floor lets them bank micro-wins freely (the BONK 15W/1L edge). The full
      // 1.3x hurdle stays for fee-burning books where micro-exits are pure -EV.
      const feeHurdlePct = existing.runnerMode ? 0.10 : roundTripFeePct * 100 * 1.3;
      const isListing = !!existing.maxHoldDurationMs;
      const holdGraceElapsed =
        isListing && Date.now() - existing.entryTime > (existing.maxHoldDurationMs || 0) + 60 * 60 * 1000;

      if (!isStopLoss && grossGainPct < feeHurdlePct && !holdGraceElapsed) {
        const now = Date.now();
        if (now - (LAST_HOLD_LOG_TS[proposal.productId] || 0) > 60_000) {
          console.log(`   ⛔ FEE-HURDLE HOLD: Gross +${grossGainPct.toFixed(2)}% < ${feeHurdlePct.toFixed(2)}% round-trip fee hurdle. Holding for target.`);
          LAST_HOLD_LOG_TS[proposal.productId] = now;
        }
        logRejection(proposal.productId, 'SELL', `Fee-hurdle hold (gross +${grossGainPct.toFixed(2)}% < ${feeHurdlePct.toFixed(2)}%)`);
        return { success: false, reason: 'Below fee hurdle' };
      }

      console.log(`   ⚖️ Approved: Closing position in ${proposal.productId}`);

      let grossPnlUsd = 0;
      let exitFeeUsd = 0;
      let feesPaidUsd = 0;
      let netPnlUsd = 0;
      let pnlPct = 0;
      let actualExitPrice = currentPrice;
      const exitTime = Date.now();

      if (!isSim) {
        const baseBal = await getAccountBalance(baseCurrency);
        if (baseBal <= 0) {
          console.log(`   ⚠️ Live balance for ${baseCurrency} is 0. Cleaning local position.`);
          delete positions[proposal.productId];
          savePositions(positions);
          return { success: false, reason: 'Zero balance' };
        }

        const formattedBaseBal = formatSizeByIncrement(baseBal, product.base_increment || '0.00000001');
        const minBaseSize = parseFloat(product.base_min_size || '0');
        if (parseFloat(formattedBaseBal) < minBaseSize) {
          console.log(`   ⚠️ Base balance ${formattedBaseBal} ${baseCurrency} below minimum size ${minBaseSize}. Cleaning local position.`);
          delete positions[proposal.productId];
          savePositions(positions);
          return { success: false, reason: 'Below minimum base size' };
        }

        const ticker = (await getTicker(proposal.productId)) as any;
        const bestAsk = parseFloat(ticker.best_ask || currentPrice.toString());

        let sellOrderId = '';

        if (!isStopLoss) {
          // Take-Profit / Normal Exit: Post Maker Limit SELL at best ask (post_only: true)
          const limitPriceNum = bestAsk > 0 ? bestAsk : currentPrice;
          const limitPriceStr = formatSizeByIncrement(limitPriceNum, product.quote_increment || '0.0001');
          console.log(`   ⚡ Submitting MAKER LIMIT SELL for ${formattedBaseBal} ${baseCurrency} @ $${limitPriceStr} (post_only)...`);
          try {
            const order = (await createLimitOrder(proposal.productId, 'SELL', formattedBaseBal, limitPriceStr, true)) as any;
            sellOrderId = order.order_id || order.success_response?.order_id;

            // Wait up to 16s for maker fill
            let isFilled = false;
            for (let attempt = 0; attempt < 8; attempt++) {
              await new Promise((r) => setTimeout(r, 2000));
              try {
                const checkOrder = await getOrder(sellOrderId);
                if (checkOrder.order?.status === 'FILLED') {
                  isFilled = true;
                  exitFeeUsd = parseFloat(checkOrder.order?.total_fees || '0');
                  const avg = parseFloat(checkOrder.order?.average_filled_price || limitPriceStr);
                  if (avg > 0) actualExitPrice = avg;
                  console.log(`   ✅ MAKER LIMIT SELL FILLED! Price: $${actualExitPrice.toFixed(4)} │ Fee: $${exitFeeUsd.toFixed(4)} (0.6% Maker)`);
                  break;
                }
              } catch {}
            }

            if (!isFilled) {
              console.log(`   ⏳ Maker Sell not yet filled. Cancelling and executing market exit to guarantee fill...`);
              await cancelOrder(sellOrderId);
              const mOrder = (await createMarketOrder(proposal.productId, 'SELL', formattedBaseBal)) as any;
              sellOrderId = mOrder.order_id || mOrder.success_response?.order_id;
              await new Promise((r) => setTimeout(r, 1500));
              try {
                const check = await getOrder(sellOrderId);
                exitFeeUsd = parseFloat(check.order?.total_fees || '0');
                const avg = parseFloat(check.order?.average_filled_price || currentPrice.toString());
                if (avg > 0) actualExitPrice = avg;
              } catch {}
            }
          } catch (err: any) {
            console.log(`   ⚠️ Maker sell failed (${err.message}). Using market sell fallback...`);
            const mOrder = (await createMarketOrder(proposal.productId, 'SELL', formattedBaseBal)) as any;
            sellOrderId = mOrder.order_id || mOrder.success_response?.order_id;
            await new Promise((r) => setTimeout(r, 1500));
            try {
              const check = await getOrder(sellOrderId);
              exitFeeUsd = parseFloat(check.order?.total_fees || '0');
              const avg = parseFloat(check.order?.average_filled_price || currentPrice.toString());
              if (avg > 0) actualExitPrice = avg;
            } catch {}
          }
        } else {
          // Emergency Stop-Loss: Attempt Limit Maker Sell first to save 1.2% taker fee
          const limitPriceNum = bestAsk > 0 ? bestAsk * 0.998 : currentPrice * 0.998;
          const limitPriceStr = formatSizeByIncrement(limitPriceNum, product.quote_increment || '0.0001');
          console.log(`   🚨 EMERGENCY STOP LOSS: Attempting Limit Sell @ $${limitPriceStr} (6s window)...`);
          try {
            const order = (await createLimitOrder(proposal.productId, 'SELL', formattedBaseBal, limitPriceStr, true)) as any;
            sellOrderId = order.order_id || order.success_response?.order_id;
            
            let isFilled = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              await new Promise((r) => setTimeout(r, 2000));
              try {
                const checkOrder = await getOrder(sellOrderId);
                if (checkOrder.order?.status === 'FILLED') {
                  isFilled = true;
                  exitFeeUsd = parseFloat(checkOrder.order?.total_fees || '0');
                  const avg = parseFloat(checkOrder.order?.average_filled_price || limitPriceStr);
                  if (avg > 0) actualExitPrice = avg;
                  console.log(`   ✅ STOP LIMIT SELL FILLED! Price: $${actualExitPrice.toFixed(4)} │ Fee: $${exitFeeUsd.toFixed(4)} (0.6% Maker)`);
                  break;
                }
              } catch {}
            }
            
            if (!isFilled) {
              console.log(`   ⏳ Stop Limit not filled. Cancelling and falling back to MARKET SELL...`);
              await cancelOrder(sellOrderId);
              throw new Error("Limit timeout");
            }
          } catch (err: any) {
            console.log(`   ⚠️ Limit sell failed (${err.message}). Using market sell fallback...`);
            try {
              const mOrder = (await createMarketOrder(proposal.productId, 'SELL', formattedBaseBal)) as any;
              sellOrderId = mOrder.order_id || mOrder.success_response?.order_id;
              await new Promise((r) => setTimeout(r, 1500));
              try {
                const check = await getOrder(sellOrderId);
                exitFeeUsd = parseFloat(check.order?.total_fees || '0');
                const avg = parseFloat(check.order?.average_filled_price || currentPrice.toString());
                if (avg > 0) actualExitPrice = avg;
              } catch {}
            } catch (fallbackErr: any) {
              console.log(`   ❌ LIVE STOP SELL FAILED: ${fallbackErr.message}`);
              return { success: false, reason: fallbackErr.message };
            }
          }
        }

        if (existing) {
          grossPnlUsd = (actualExitPrice - existing.entryPrice) * existing.quantity;
          feesPaidUsd = (existing.buyFeeUsd || 0) + exitFeeUsd;
          netPnlUsd = grossPnlUsd - feesPaidUsd;
          pnlPct = existing.sizeUsd > 0 ? (netPnlUsd / existing.sizeUsd) * 100 : 0;
          console.log(`   📊 TRADE RESULT: Gross: ${grossPnlUsd >= 0 ? '+' : ''}$${grossPnlUsd.toFixed(2)} │ Total Fees: -$${feesPaidUsd.toFixed(2)} │ NET: ${netPnlUsd >= 0 ? '+' : ''}$${netPnlUsd.toFixed(2)} (${netPnlUsd >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`);
        }
      } else if (existing) {
        // Paper Simulation
        grossPnlUsd = (currentPrice - existing.entryPrice) * existing.quantity;
        feesPaidUsd = existing.sizeUsd * (QUANT_CONFIG.makerFeeRate * 2); // 1.2% round-trip maker estimate
        netPnlUsd = grossPnlUsd - feesPaidUsd;
        pnlPct = (netPnlUsd / existing.sizeUsd) * 100;
        console.log(`   📝 Paper Exit: Gross: ${grossPnlUsd >= 0 ? '+' : ''}$${grossPnlUsd.toFixed(2)} │ Est Fees: -$${feesPaidUsd.toFixed(2)} │ NET: ${netPnlUsd >= 0 ? '+' : ''}$${netPnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
      }

      // Record trade to journal with audited NET PnL
      if (existing) {
        recordTrade({
          id: existing.orderId || `trade-${Date.now()}`,
          productId: proposal.productId,
          entryPrice: existing.entryPrice,
          exitPrice: actualExitPrice || currentPrice,
          quantity: existing.quantity,
          sizeUsd: existing.sizeUsd,
          grossPnlUsd: parseFloat(grossPnlUsd.toFixed(4)),
          feesPaidUsd: parseFloat(feesPaidUsd.toFixed(4)),
          netPnlUsd: parseFloat(netPnlUsd.toFixed(4)),
          pnlUsd: parseFloat(netPnlUsd.toFixed(2)),
          pnlPct: parseFloat(pnlPct.toFixed(2)),
          entryTime: existing.entryTime,
          exitTime,
          reason: proposal.reasoning,
          simulated: isSim,
          orderType: existing.orderType || 'MAKER',
        });
      }

      // Play Sound (Win chime vs Loss warning based on TRUE NET PnL)
      if (netPnlUsd >= 0) {
        playTransactionSound('win');
      } else {
        playTransactionSound('loss');
      }

      delete positions[proposal.productId];
      savePositions(positions);

      return { success: true, simulated: isSim, size: 'ALL', pnlUsd: netPnlUsd };
    }

    return { success: false, reason: 'Unknown action' };
  } catch (err: any) {
    console.error(`   ❌ EXECUTION ERROR: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

/**
 * Check open positions against Stop-Loss, Take-Profit, and Trailing Breakeven stops
 */
export async function checkStopsAndTargets(currentPrices: Record<string, number>, availableCashUsd: number, totalEquityUsd?: number) {
  const positions = loadPositions();
  let updated = false;

  for (const [productId, pos] of Object.entries(positions)) {
    const price = currentPrices[productId];
    if (!price) continue;

    // Highest price (peak) tracking — feeds both the runner trail and legacy ratchet
    if (price > (pos.highestPriceSeen || pos.entryPrice)) {
      pos.highestPriceSeen = price;
      updated = true;
    }

    // GOD 5 — RUNNER TRAIL: zero-fee family positions ratchet the stop up behind
    // the peak once a real move starts (+4%), locking profit instead of sniping
    // micro-premiums or giving the whole runner back.
    if (pos.runnerMode) {
      const hwm = pos.highestPriceSeen || pos.entryPrice;
      const gainPct = (hwm - pos.entryPrice) / pos.entryPrice;
      if (gainPct >= RUNNER_ACTIVATE_PCT) {
        const runnerTrail = hwm * (1 - RUNNER_TRAIL_PCT);
        const lockFloor = pos.entryPrice * (1 + QUANT_CONFIG.trailingLockPct);
        const newStop = Math.max(pos.stopLossPrice, Math.max(runnerTrail, lockFloor));
        if (newStop > pos.stopLossPrice) {
          console.log(`\n🚀 RUNNER TRAIL ${productId}: peak +${(gainPct * 100).toFixed(1)}%, stop ratcheted to $${runnerPriceFmt(newStop)} (lock +${(((newStop / pos.entryPrice) - 1) * 100).toFixed(1)}%)`);
          pos.stopLossPrice = newStop;
          updated = true;
        }
      }
    } else {
      // Legacy trailing ratchet: at +2.5% gain, move stop to +1.5% (covers fees)
      const gainPct = (price - pos.entryPrice) / pos.entryPrice;
      const breakevenStop = pos.entryPrice * (1 + QUANT_CONFIG.trailingLockPct);
      if (gainPct >= QUANT_CONFIG.trailingTriggerPct && pos.stopLossPrice < breakevenStop) {
        pos.stopLossPrice = breakevenStop;
        console.log(`\n🛡️ Trailing Stop Activated for ${productId}: Locked Net Profit Stop at +${(QUANT_CONFIG.trailingLockPct * 100).toFixed(1)}% ($${breakevenStop.toFixed(4)})`);
        playTransactionSound('trailing');
      }
    }

    // Time-Decay / Max Hold Duration (for Listing Momentum rotations)
    if (pos.maxHoldDurationMs && (Date.now() - pos.entryTime) >= pos.maxHoldDurationMs) {
      const holdMins = Math.round((Date.now() - pos.entryTime) / 60000);
      console.log(`\n⏳ TIME-DECAY EXIT: ${productId} reached ${holdMins}m max hold duration. Rotating 100% back to USDC cash...`);
      await executeAIProposal(
        {
          productId,
          action: 'SELL',
          confidence: 0.99,
          reasoning: `Time-decay exit (${holdMins}m hold window elapsed) — returning capital to USDC cash`,
        },
        availableCashUsd,
        price,
        totalEquityUsd
      );
      continue;
    }

    // Stop Loss Trigger
    if (price <= pos.stopLossPrice) {
      console.log(`\n🛑 STOP LOSS TRIGGERED for ${productId} at $${price.toFixed(4)} (Entry: $${pos.entryPrice.toFixed(4)})`);
      STOP_LOSS_COOLDOWNS[productId] = Date.now(); // Activate 30m re-entry cooldown
      await executeAIProposal(
        {
          productId,
          action: 'SELL',
          confidence: 0.99,
          reasoning: `Stop-loss breached ($${price.toFixed(4)} <= $${pos.stopLossPrice.toFixed(4)})`,
        },
        availableCashUsd,
        price,
        totalEquityUsd
      );
    }
    // Take Profit Trigger
    else if (price >= pos.takeProfitPrice) {
      console.log(`\n🎯 TAKE PROFIT TRIGGERED for ${productId} at $${price.toFixed(4)} (Entry: $${pos.entryPrice.toFixed(4)})`);
      await executeAIProposal(
        {
          productId,
          action: 'SELL',
          confidence: 0.99,
          reasoning: `Take-profit reached ($${price.toFixed(4)} >= $${pos.takeProfitPrice.toFixed(4)})`,
        },
        availableCashUsd,
        price,
        totalEquityUsd
      );
    }
  }

  if (updated) {
    savePositions(positions);
  }
}
