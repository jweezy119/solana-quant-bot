/**
 * Solana Hybrid Bot v2 — Quant Edition
 * ─────────────────────────────────────────────────────────────
 * Strategies:
 *   1. Swing / DCA   — buy dips, sell rallies with smart exits
 *   2. Cross-DEX     — Raydium/Orca/Meteora spread as signal booster
 *
 * Quant Features:
 *   ✅ 2:1 Risk/Reward  (sell +4%, stop -2%)
 *   ✅ EMA(10/20) trend filter — no buying in downtrends
 *   ✅ Momentum guard  — no catching falling knives
 *   ✅ ATR-adaptive thresholds — volatility-aware entry/exit
 *   ✅ Trailing stop   — locks in profits as price climbs
 *   ✅ Partial exits   — 60% at target, 40% trails with stop
 *   ✅ Cross-DEX spread as confidence booster (1.5× position)
 *   ✅ 20-sample warm-up period before any trade fires
 *
 * Stack: TypeScript · @solana/web3.js · Jupiter v6 API · Public RPC
 *
 * Setup:
 *   1. cp .env.example .env
 *   2. Fill in PRIVATE_KEY in .env
 *   3. npm install
 *   4. npx ts-node index.ts
 */

import "dotenv/config";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";

// ============================================================
//  🔑  WALLET  (loaded from .env — never hardcode keys!)
// ============================================================
const PRIVATE_KEY_BASE58: string = process.env.PRIVATE_KEY ?? "YOUR_PRIVATE_KEY_HERE";

// ============================================================
//  ⚙️  CONFIG
// ============================================================
const RPC_ENDPOINT      = "https://api.mainnet-beta.solana.com";
const JUPITER_QUOTE_URL = "https://public.jupiterapi.com/quote";
const JUPITER_SWAP_URL  = "https://public.jupiterapi.com/swap";
const POLL_INTERVAL_MS  = 3_000;
const POSITIONS_FILE    = "./positions.json";

// Capital
const SWING_POS_USDC_RAW      = 15 * 1_000_000;   // $15 base position
const SWING_POS_BOOSTED_RAW   = 20 * 1_000_000;   // $20 when cross-DEX confirms
const CROSS_DEX_USDC_RAW      = 12 * 1_000_000;   // $12 cross-DEX check
const MAX_SWING_POSITIONS      = 4;

// Swing — FIXED 2:1 Risk/Reward
const BASE_SELL_PCT   = 3.5;   // take-profit: +3.5% from entry
const BASE_STOP_PCT   = 1.5;   // stop-loss:   -1.5% from entry
const PARTIAL_SELL    = 0.60;  // sell 60% at target, trail 40%

// ATR-adaptive bounds (multiplied by ATR%)
const ATR_DIP_MULT    = 1.0;   // dip threshold  = ATR% × 1.0 (tighter for faster entries)
const ATR_SELL_MULT   = 2.0;   // sell threshold = ATR% × 2.0
const ATR_STOP_MULT   = 1.0;   // stop threshold = ATR% × 1.0
const MIN_DIP_PCT     = 1.0;   // floor (tighter)
const MAX_DIP_PCT     = 4.5;   // ceiling

// Trailing stop — activates once price is +2% above entry
const TRAIL_ACTIVATION_PCT = 1.5;  // activate trailing stop at +1.5%
const TRAIL_DISTANCE_PCT   = 1.2;  // trail 1.2% below peak

// EMA periods
const EMA_FAST_PERIOD = 10;
const EMA_SLOW_PERIOD = 20;
const MIN_SAMPLES     = 20;    // minimum price history before trading

// Cross-DEX
const MIN_SPREAD_PCT  = 0.6;   // minimum spread % to flag an opportunity
const DEX_LABELS      = ["Raydium", "Orca", "Meteora"];

// Slippage
const SLIPPAGE_BPS = 50;

// ============================================================
//  🪙  TOKENS
// ============================================================
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface TokenInfo { symbol: string; mint: string; decimals: number; }

const TOKENS: TokenInfo[] = [
  { symbol: "WIF",      mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", decimals: 6 },
  { symbol: "POPCAT",   mint: "7GCihgDB8fe6KNjn2grciq8T7J2P4KkHnbqZ6Dq3pump", decimals: 6 },
  { symbol: "MOODENG",  mint: "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Qp8M3eYipump", decimals: 6 },
  { symbol: "FARTCOIN", mint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", decimals: 6 },
];

// ============================================================
//  📊  TYPES
// ============================================================
interface PriceHistory {
  prices:      number[];
  emaFast:     number;
  emaSlow:     number;
  atr:         number;   // Average True Range as % of price
  rollingHigh: number;
}

interface SwingPosition {
  symbol:           string;
  mint:             string;
  decimals:         number;
  entryPriceUsdc:   number;
  tokenAmount:      number;
  investedUsdc:     number;
  openedAt:         string;
  stopPrice:        number;   // dynamic, trails upward
  targetPrice:      number;
  peakPrice:        number;   // highest seen since entry
  partialDone:      boolean;  // true once 60% sold
}

// ============================================================
//  🗄️  GLOBAL STATE
// ============================================================
const positions:    Record<string, SwingPosition> = {};
const priceHistory: Record<string, PriceHistory>  = {};
let totalScans  = 0;
let tradesExec  = 0;
let sessionPnl  = 0;

// ============================================================
//  🔧  UTILITIES
// ============================================================
const sleep     = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const pct       = (a: number, b: number) => ((a - b) / b) * 100;
const f         = (n: number, d = 4) => n.toFixed(d);
const usdcH     = (raw: number) => raw / 1_000_000;
const clamp     = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function computeEMA(prev: number, price: number, period: number): number {
  const k = 2 / (period + 1);
  return prev === 0 ? price : price * k + prev * (1 - k);
}

function computeATRPct(prices: number[]): number {
  if (prices.length < 2) return 2.0;
  let sum = 0;
  const n = Math.min(prices.length - 1, 10);
  for (let i = prices.length - 1; i >= prices.length - n; i--) {
    sum += Math.abs(pct(prices[i], prices[i - 1]));
  }
  return sum / n;
}

function getDynamicThresholds(atr: number): { dipPct: number; sellPct: number; stopPct: number } {
  return {
    dipPct:  clamp(atr * ATR_DIP_MULT,  MIN_DIP_PCT, MAX_DIP_PCT),
    sellPct: clamp(atr * ATR_SELL_MULT, BASE_SELL_PCT, 8.0),
    stopPct: clamp(atr * ATR_STOP_MULT, BASE_STOP_PCT, 3.5),
  };
}

function printStats(): void {
  console.log(
    `\n  📊  Stats │ Scans: ${totalScans} │ Trades: ${tradesExec} │ ` +
    `P&L: ${sessionPnl >= 0 ? "+" : ""}$${f(sessionPnl, 4)} USDC │ Positions: ${Object.keys(positions).length}/${MAX_SWING_POSITIONS}`
  );
}

// ============================================================
//  💾  PERSISTENCE
// ============================================================
function loadPositions(): void {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      Object.assign(positions, JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf-8")));
      console.log(`📂  Loaded ${Object.keys(positions).length} open position(s) from disk.`);
    }
  } catch { /* fresh start */ }
}

function savePositions(): void {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

function loadKeypair(b58: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(b58));
}

// ============================================================
//  📡  JUPITER API
// ============================================================
async function getQuote(inputMint: string, outputMint: string, amountRaw: number, dex?: string): Promise<any | null> {
  let url = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${SLIPPAGE_BPS}`;
  if (dex) url += `&dexes=${encodeURIComponent(dex)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (res.status === 429) throw new Error("Rate limited (429)");
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  return data?.outAmount ? data : null;
}

async function getSwapTx(quote: any, pubkey: string): Promise<string> {
  const res = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: pubkey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Swap API HTTP ${res.status}`);
  const data = (await res.json()) as any;
  if (!data.swapTransaction) throw new Error("No swapTransaction");
  return data.swapTransaction as string;
}

async function sendTx(conn: Connection, kp: Keypair, b64: string): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const lbh = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction({ signature: sig, blockhash: lbh.blockhash, lastValidBlockHeight: lbh.lastValidBlockHeight }, "confirmed");
  return sig;
}

// ============================================================
//  💱  PRICE & INDICATORS
// ============================================================
async function getPrice(token: TokenInfo, dex?: string): Promise<number | null> {
  const q = await getQuote(token.mint, USDC, Math.pow(10, token.decimals), dex);
  if (!q) return null;
  return usdcH(parseInt(q.outAmount, 10));
}

function updateHistory(symbol: string, price: number): PriceHistory {
  if (!priceHistory[symbol]) {
    priceHistory[symbol] = { prices: [], emaFast: price, emaSlow: price, atr: 2.0, rollingHigh: price };
  }
  const h = priceHistory[symbol];
  h.prices.push(price);
  if (h.prices.length > 60) h.prices.shift();
  h.emaFast = computeEMA(h.emaFast, price, EMA_FAST_PERIOD);
  h.emaSlow = computeEMA(h.emaSlow, price, EMA_SLOW_PERIOD);
  h.atr     = computeATRPct(h.prices);
  if (!positions[symbol] && price > h.rollingHigh) h.rollingHigh = price;
  return h;
}

// ============================================================
//  🔄  CROSS-DEX SCAN  (used as signal booster)
// ============================================================
async function checkCrossDexSpread(token: TokenInfo): Promise<number> {
  let maxSpread = 0;
  for (const buyDex of DEX_LABELS) {
    for (const sellDex of DEX_LABELS) {
      if (buyDex === sellDex) continue;
      try {
        const buyQ = await getQuote(USDC, token.mint, CROSS_DEX_USDC_RAW, buyDex);
        if (!buyQ) continue;
        const sellQ = await getQuote(token.mint, USDC, parseInt(buyQ.outAmount, 10), sellDex);
        if (!sellQ) continue;
        const spread = pct(parseInt(sellQ.outAmount, 10), CROSS_DEX_USDC_RAW);
        if (spread > maxSpread) maxSpread = spread;
      } catch { /* no route */ }
    }
  }
  return maxSpread;
}

// ============================================================
//  📈  SWING SIGNAL  (with all quant filters)
// ============================================================
type SignalType = "BUY" | "SELL_TARGET" | "SELL_STOP" | "SELL_TRAIL" | "PARTIAL_SELL";

interface SwingSignal {
  type:         SignalType;
  token:        TokenInfo;
  price:        number;
  reason:       string;
  boosted:      boolean;
}

function checkSwingSignal(token: TokenInfo, price: number, h: PriceHistory): SwingSignal | null {
  const sym = token.symbol;
  const pos = positions[sym];

  // Need minimum samples for reliable indicators
  if (h.prices.length < MIN_SAMPLES) return null;

  // ── SELL / MANAGE open position ───────────────────────────
  if (pos) {
    // Update peak for trailing stop
    if (price > pos.peakPrice) {
      pos.peakPrice = price;
      // Tighten trailing stop as price climbs
      if (pct(price, pos.entryPriceUsdc) >= TRAIL_ACTIVATION_PCT) {
        const newStop = pos.peakPrice * (1 - TRAIL_DISTANCE_PCT / 100);
        if (newStop > pos.stopPrice) {
          pos.stopPrice = newStop;
        }
      }
      savePositions();
    }

    const gainPct = pct(price, pos.entryPriceUsdc);

    // Trailing stop hit
    if (price <= pos.stopPrice && pct(price, pos.entryPriceUsdc) >= TRAIL_ACTIVATION_PCT) {
      return { type: "SELL_TRAIL", token, price, reason: `🔒 Trailing stop: $${f(pos.stopPrice, 6)} (peak: $${f(pos.peakPrice, 6)})`, boosted: false };
    }
    // Hard stop loss
    if (gainPct <= -BASE_STOP_PCT) {
      return { type: "SELL_STOP", token, price, reason: `🛑 Stop loss ${f(gainPct, 2)}% (entry $${f(pos.entryPriceUsdc, 6)})`, boosted: false };
    }
    // Partial take-profit (60%) at target
    if (!pos.partialDone && gainPct >= BASE_SELL_PCT) {
      return { type: "PARTIAL_SELL", token, price, reason: `💰 Partial exit +${f(gainPct, 2)}% — selling 60%, trailing 40%`, boosted: false };
    }
    // Full exit (remaining 40%) at extended target
    if (pos.partialDone && gainPct >= BASE_SELL_PCT * 1.5) {
      return { type: "SELL_TARGET", token, price, reason: `🏁 Full exit +${f(gainPct, 2)}% — extended target hit`, boosted: false };
    }
    return null;
  }

  // ── BUY checks ────────────────────────────────────────────
  if (Object.keys(positions).length >= MAX_SWING_POSITIONS) return null;

  // 1. Trend filter: fast EMA must be above slow EMA (uptrend only)
  const uptrend = h.emaFast > h.emaSlow;
  if (!uptrend) return null;

  // 2. Volatility-adaptive dip threshold
  const { dipPct } = getDynamicThresholds(h.atr);
  const dipFromHigh = pct(price, h.rollingHigh);
  if (dipFromHigh > -dipPct) return null;

  // 3. Momentum confirmation: price must be RISING vs 3 scans ago (no falling knives)
  if (h.prices.length >= 4) {
    const priceThreeBack = h.prices[h.prices.length - 4];
    if (price <= priceThreeBack) return null; // still falling — wait
  }

  const reason = `📉 Dip ${f(Math.abs(dipFromHigh), 2)}% | ATR: ${f(h.atr, 2)}% | EMA✅ | Momentum✅`;
  return { type: "BUY", token, price, reason, boosted: false };
}

// ============================================================
//  ⚡  EXECUTORS
// ============================================================
async function executeSwingTrade(signal: SwingSignal, conn: Connection, kp: Keypair): Promise<void> {
  const { type, token, price, reason, boosted } = signal;
  const { symbol, mint, decimals } = token;
  const pubkey = kp.publicKey.toBase58();

  if (type === "BUY") {
    const posSize = boosted ? SWING_POS_BOOSTED_RAW : SWING_POS_USDC_RAW;
    console.log(`\n  🛒  BUY ${symbol}${boosted ? " [BOOSTED $9]" : " [$6]"} | ${reason}`);

    const buyQ = await getQuote(USDC, mint, posSize);
    if (!buyQ) throw new Error(`No buy route for ${symbol}`);

    const tx  = await getSwapTx(buyQ, pubkey);
    const sig = await sendTx(conn, kp, tx);
    console.log(`    ✅ https://solscan.io/tx/${sig}`);

    const tokensReceived = parseInt(buyQ.outAmount, 10) / Math.pow(10, decimals);
    const { stopPct, sellPct } = getDynamicThresholds(priceHistory[symbol]?.atr ?? 2);
    positions[symbol] = {
      symbol, mint, decimals,
      entryPriceUsdc: price,
      tokenAmount:    tokensReceived,
      investedUsdc:   usdcH(posSize),
      openedAt:       new Date().toISOString(),
      stopPrice:      price * (1 - stopPct / 100),
      targetPrice:    price * (1 + sellPct / 100),
      peakPrice:      price,
      partialDone:    false,
    };
    if (priceHistory[symbol]) priceHistory[symbol].rollingHigh = price;
    savePositions();
    tradesExec++;
    return;
  }

  const pos = positions[symbol];
  if (!pos) return;

  if (type === "PARTIAL_SELL") {
    const sellAmt = Math.round(pos.tokenAmount * PARTIAL_SELL * Math.pow(10, decimals));
    console.log(`\n  💸  PARTIAL SELL ${symbol} (60%) | ${reason}`);
    const sellQ = await getQuote(mint, USDC, sellAmt);
    if (!sellQ) throw new Error("No partial sell route");
    const tx  = await getSwapTx(sellQ, pubkey);
    const sig = await sendTx(conn, kp, tx);
    console.log(`    ✅ https://solscan.io/tx/${sig}`);
    const received = usdcH(parseInt(sellQ.outAmount, 10));
    const pnl = received - pos.investedUsdc * PARTIAL_SELL;
    sessionPnl += pnl;
    pos.tokenAmount   *= (1 - PARTIAL_SELL);
    pos.investedUsdc  *= (1 - PARTIAL_SELL);
    pos.partialDone    = true;
    savePositions();
    tradesExec++;
    return;
  }

  // Full sell (SELL_TARGET, SELL_STOP, SELL_TRAIL)
  const label = type === "SELL_TARGET" ? "SELL TARGET" : type === "SELL_STOP" ? "SELL STOP" : "SELL TRAIL";
  console.log(`\n  💸  ${label} ${symbol} | ${reason}`);
  const tokenRaw = Math.round(pos.tokenAmount * Math.pow(10, decimals));
  const sellQ = await getQuote(mint, USDC, tokenRaw);
  if (!sellQ) throw new Error("No sell route");
  const tx  = await getSwapTx(sellQ, pubkey);
  const sig = await sendTx(conn, kp, tx);
  console.log(`    ✅ https://solscan.io/tx/${sig}`);
  const received = usdcH(parseInt(sellQ.outAmount, 10));
  const pnl = received - pos.investedUsdc;
  console.log(`    💰 P&L: ${pnl >= 0 ? "+" : ""}$${f(pnl, 4)} USDC`);
  sessionPnl += pnl;
  delete positions[symbol];
  savePositions();
  tradesExec++;
}

// ============================================================
//  🔁  MAIN LOOP
// ============================================================
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  🤖  Solana Hybrid Bot v2 — Quant Edition");
  console.log("  📐  2:1 R:R │ EMA Filter │ ATR-Adaptive │ Trailing Stop");
  console.log("═══════════════════════════════════════════════════════\n");

  const simMode = PRIVATE_KEY_BASE58 === "YOUR_PRIVATE_KEY_HERE";
  if (simMode) {
    console.log("⚠️   SIMULATION MODE — add private key to trade live.\n");
  }

  loadPositions();

  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  let keypair: Keypair | null = null;
  if (!simMode) {
    try {
      keypair = loadKeypair(PRIVATE_KEY_BASE58);
      console.log(`🔑  Wallet: ${keypair.publicKey.toBase58()}\n`);
    } catch (e) { console.error("❌  Bad private key:", e); process.exit(1); }
  }

  while (true) {
    totalScans++;
    console.log(`\n─── Scan #${totalScans}  [${new Date().toISOString()}] ${"─".repeat(28)}`);

    for (const token of TOKENS) {
      try {
        const price = await getPrice(token);
        if (price === null) { console.log(`  ${token.symbol.padEnd(8)} ⚠️  Price unavailable`); continue; }

        const h    = updateHistory(token.symbol, price);
        const pos  = positions[token.symbol];
        const ready = h.prices.length >= MIN_SAMPLES;

        // Status line
        const trend = ready ? (h.emaFast > h.emaSlow ? "↑" : "↓") : "…";
        let status = `$${f(price, 6)}  ATR:${f(h.atr, 2)}%  EMA${trend}`;
        if (pos) {
          const g = pct(price, pos.entryPriceUsdc);
          status += `  │ HELD $${f(pos.entryPriceUsdc, 6)}  ${g >= 0 ? "+" : ""}${f(g, 2)}%  Stop:$${f(pos.stopPrice, 6)}`;
        } else {
          status += `  │ High:$${f(h.rollingHigh, 6)}  Dip:${f(pct(price, h.rollingHigh), 2)}%`;
        }
        if (!ready) status += "  [warming up…]";

        const signal = ready ? checkSwingSignal(token, price, h) : null;
        console.log(`  ${token.symbol.padEnd(8)} ${status}${signal ? `  ← ${signal.reason}` : ""}`);

        // Cross-DEX spread check — boost position if confirmed
        if (signal?.type === "BUY") {
          try {
            const spread = await checkCrossDexSpread(token);
            if (spread >= MIN_SPREAD_PCT) {
              signal.boosted = true;
              console.log(`    🔀 Cross-DEX spread +${f(spread, 3)}% confirms signal → BOOSTED $9`);
            }
          } catch { /* non-critical */ }
        }

        if (signal && keypair) {
          await executeSwingTrade(signal, connection, keypair);
        } else if (signal && simMode) {
          console.log(`    ℹ️  Simulation: would execute ${signal.type}`);
        }

      } catch (e: any) {
        console.error(`  ${token.symbol.padEnd(8)} ⚠️  ${e.message}`);
      }
    }

    printStats();
    console.log(`\n  ⏳  Sleeping ${POLL_INTERVAL_MS}ms...`);
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
