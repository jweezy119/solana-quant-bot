/**
 * Solana DEX Meme Coin Sniper & Whale Copy-Trader
 * ────────────────────────────────────────────────
 * Scans DexScreener for surging Solana meme coins (Pump.fun & Raydium)
 * and monitors famous smart money wallets via Helius.
 * Dual-routes swaps dynamically between PumpPortal and Jupiter.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { scanTrendingMemeCoins, MemeTokenOpportunity } from '../radar/dexscreener';
import { scanWhaleActivity, WhaleAlert, getTrackedWallets } from '../radar/whale-tracker';
import { isTokenSafeRugCheck } from '../radar/rugcheck';
import { updateAndCalculateOFI, isTapeFlipping, clearOFIState } from '../signals/ofi';
import { updateHMM, isDistributionRegime, getRegimeString, clearHMMState } from '../signals/hmm';
import { executeMemeBuy, executeMemeSell } from '../execution/meme-router';
import { playTransactionSound } from '../coinbase/sound';

export interface SolanaMemePosition {
  tokenAddress: string;
  symbol: string;
  entryPriceUsd: number;
  entrySolSpent: number;
  tokensHeldRaw: number;
  entryTime: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  highestPriceSeen: number;
  simulated: boolean;
  signature?: string;
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const POSITIONS_FILE = path.join(DATA_DIR, 'solana-meme-positions.json');

const SIMULATION_MODE = process.env.MEME_SNIPER_SIMULATION !== 'false';
const MAX_CONCURRENT_POSITIONS = 3;   // Increased to 3 for higher volume of shots
const TAKE_PROFIT_PCT = 0.50; // +50% (Let runners run)
const STOP_LOSS_PCT = 0.20;   // -20% (More breathing room for volatility)
const TRAILING_TRIGGER_PCT = 0.25; // At +25%, ratchet stop
const MAX_HOLD_TIME_MINUTES = 10;  // Eject if held too long (slow bleed)

let isRunning = true;
let scanCount = 0;

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down Solana Meme Sniper cleanly...');
  isRunning = false;
  process.exit(0);
});

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadPositions(): Record<string, SolanaMemePosition> {
  ensureDataDir();
  if (!fs.existsSync(POSITIONS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function savePositions(positions: Record<string, SolanaMemePosition>) {
  ensureDataDir();
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2), 'utf-8');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPrice(p: number): string {
  if (p >= 1) return `$${p.toFixed(2)}`;
  if (p >= 0.001) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(8)}`;
}

/**
 * Fetch current prices for all held tokens directly from DexScreener
 */
async function getHeldPositionsPrices(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {};
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`, {
      headers: { 'User-Agent': 'QuantRadar/1.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as any;
    const prices: Record<string, number> = {};
    for (const p of data.pairs || []) {
      if (p.baseToken?.address && !prices[p.baseToken.address]) {
        prices[p.baseToken.address] = parseFloat(p.priceUsd || '0');
      }
    }
    return prices;
  } catch {
    return {};
  }
}

async function fetchOnChainTokenBalance(conn: Connection, owner: PublicKey, mint: PublicKey): Promise<number> {
  try {
    const accounts = await conn.getParsedTokenAccountsByOwner(owner, { mint });
    if (accounts.value && accounts.value.length > 0) {
      return parseInt(accounts.value[0].account.data.parsed.info.tokenAmount.amount, 10);
    }
  } catch {}
  return 0;
}

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error('❌ Error: PRIVATE_KEY missing in .env');
    process.exit(1);
  }

  const keypair = Keypair.fromSecretKey(bs58.decode(pk));
  const rpcUrl = process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  console.clear();
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  🎯  SOLANA MEME COIN SNIPER & SMART MONEY COPY-TRADER');
  console.log('  ⚡  Engine: DexScreener Viral Momentum + Helius Whale Radar + PumpPortal / Jupiter');
  console.log(`  💼  Mode: ${SIMULATION_MODE ? '🟡 SIMULATION (Paper Trading)' : '🔴 LIVE ON-CHAIN (Real SOL Execution)'}`);
  console.log(`  🔑  Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`  📐  Trade Size: Dynamic (20% of Bankroll) │ Max Positions: ${MAX_CONCURRENT_POSITIONS}`);
  console.log(`  🎯  Targets: +${(TAKE_PROFIT_PCT * 100)}% Take Profit │ -${(STOP_LOSS_PCT * 100)}% Stop Loss`);
  console.log(`  🐋  Tracked Smart Money: ${getTrackedWallets().length} Wallets (Helius Stream)`);
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  while (isRunning) {
    scanCount++;
    const timestamp = new Date().toISOString();

    // 1. Fetch current SOL balance
    let solBal = 0;
    try {
      solBal = (await connection.getBalance(keypair.publicKey)) / 1e9;
    } catch {}

    const positions = loadPositions();
    const dynamicTradeSol = Math.max(0.015, parseFloat((solBal * 0.20).toFixed(4)));
    const openMints = Object.keys(positions);
    const openCount = openMints.length;

    const IS_BEAR_MARKET = process.env.COINBASE_REGIME !== 'BULL';
    const activeMaxPositions = IS_BEAR_MARKET ? 1 : MAX_CONCURRENT_POSITIONS;

    console.log(`\n─── Solana Scan #${scanCount}  [${timestamp}] ───────────────────────────────────────────`);
    if (IS_BEAR_MARKET) {
      console.log(`  🛡️  DOWNTREND DETECTED: Operating in BEAR_SNIPER Mode (Max Positions: 1, Strict Whale/Score Requirements)`);
    }
    console.log(`  💰 SOL Balance: ${solBal.toFixed(4)} SOL (~$${(solBal * 140).toFixed(2)}) │ Open Positions: ${openCount}/${activeMaxPositions}`);

    // 2. Poll DexScreener & Whale Activity & Dedicated Held Token Prices
    // In a bear market, we demand extreme buy ratios (3.0x) and low liquidity (3k) to catch instant runners
    const scanFilters = IS_BEAR_MARKET 
      ? { minLiquidityUsd: 3000, minBuyRatio5m: 3.0 } 
      : { minLiquidityUsd: 3000, minBuyRatio5m: 2.5 };

    const [memes, whaleAlerts, heldPrices] = await Promise.all([
      scanTrendingMemeCoins(scanFilters),
      scanWhaleActivity(3),
      getHeldPositionsPrices(openMints),
    ]);

    // 3. Display Top Trending Meme Coins
    console.log(`\n  🔥 Top Trending Solana Meme Coins (DexScreener Live Radar):`);
    if (memes.length === 0) {
      console.log(`     (No tokens currently meeting strict >${scanFilters.minBuyRatio5m}x buy ratio and >$3k liquidity threshold)`);
    } else {
      for (const m of memes.slice(0, 4)) {
        const pStr = formatPrice(m.priceUsd).padEnd(12);
        const buyRatioStr = `${m.buyRatio5m}x buys`.padEnd(11);
        const vol5mStr = `$${(m.volume5m / 1000).toFixed(1)}k 5m`.padEnd(12);
        const liqStr = `$${(m.liquidityUsd / 1000).toFixed(0)}k liq`.padEnd(11);
        const pumpBadge = m.isPumpFun ? '💊 Pump.fun' : '⚡ Raydium ';
        const scoreBadge = `[Score: ${m.score}]`;
        console.log(`     • ${m.symbol.padEnd(10)} ${pStr} │ ${buyRatioStr} │ ${vol5mStr} │ ${liqStr} │ ${pumpBadge} ${scoreBadge}`);
      }
    }

    // 4. Display Recent Whale Activity
    if (whaleAlerts.length > 0) {
      console.log(`\n  🐋 Smart Money & Whale Swaps:`);
      for (const a of whaleAlerts.slice(0, 2)) {
        console.log(`     🚨 ${a.walletLabel} ${a.action} $${a.amountUsd.toFixed(0)} of ${a.tokenSymbol || 'token'} on ${a.source}`);
      }
    }

    // 5. Evaluate Opportunities for Entry
    if (openCount < activeMaxPositions && memes.length > 0) {
      const candidate = memes[0];
      const minScore = IS_BEAR_MARKET ? 85 : 75;
      const whaleActive = whaleAlerts.some(w => w.tokenMint === candidate.tokenAddress || w.tokenSymbol === candidate.symbol);
      const isSafeInBear = !IS_BEAR_MARKET || whaleActive || candidate.buyRatio5m > 4.0;

      // High conviction criteria: Score >= threshold, bear safety passed, not already in position
      if (candidate.score >= minScore && isSafeInBear && !positions[candidate.tokenAddress]) {
        console.log(`\n  🚀 HIGH CONVICTION BREAKOUT DETECTED: $${candidate.symbol}`);
        
        // --- NEW: RugCheck & Safety Check ---
        const isSafe = await isTokenSafeRugCheck(candidate.tokenAddress);
        if (!isSafe) {
           console.log(`     ⏭️ Skipping $${candidate.symbol} due to RugCheck safety failure.`);
           continue;
        }

        if (IS_BEAR_MARKET) console.log(`     🛡️ Bear Market Override: Cleared (Whale Active: ${whaleActive}, Buy Ratio: ${candidate.buyRatio5m}x)`);
        console.log(`     Score: ${candidate.score}/100 │ Buy Ratio: ${candidate.buyRatio5m}x │ 5m Vol: $${candidate.volume5m.toFixed(0)}`);

        if (solBal < dynamicTradeSol + 0.008) {
          console.log(`     ⚠️ Insufficient SOL (${solBal.toFixed(4)} SOL) to trade ${dynamicTradeSol} SOL + gas reserve.`);
        } else {
          console.log(`     ⚡ Executing entry for ${dynamicTradeSol} SOL [${SIMULATION_MODE ? 'SIMULATION' : 'LIVE ON-CHAIN'}]...`);

          let tokensReceived = 0;
          let signature = `paper-${Date.now()}`;

          if (!SIMULATION_MODE) {
            const tradeRes = await executeMemeBuy(connection, keypair, candidate.tokenAddress, dynamicTradeSol, 15);
            if (tradeRes.success) {
              signature = tradeRes.signature;
              await sleep(2500);
              const onChainBal = await fetchOnChainTokenBalance(connection, keypair.publicKey, new PublicKey(candidate.tokenAddress));
            tokensReceived = onChainBal > 0 ? onChainBal : ((dynamicTradeSol * 140) / candidate.priceUsd);
              console.log(`     ✅ LIVE BUY Confirmed via ${tradeRes.source}! Tx: https://solscan.io/tx/${signature}`);
              playTransactionSound('buy');
            } else {
              console.log(`     ❌ BUY ROUTE FAILED: ${tradeRes.error || 'Execution rejected'}`);
              continue;
            }
          } else {
            tokensReceived = (dynamicTradeSol * 140) / candidate.priceUsd;
            console.log(`     📝 Paper Trade Logged (Simulation Mode).`);
            playTransactionSound('buy');
          }

          positions[candidate.tokenAddress] = {
            tokenAddress: candidate.tokenAddress,
            symbol: candidate.symbol,
            entryPriceUsd: candidate.priceUsd,
            entrySolSpent: dynamicTradeSol,
            tokensHeldRaw: tokensReceived,
            entryTime: Date.now(),
            stopLossPrice: candidate.priceUsd * (1 - STOP_LOSS_PCT),
            takeProfitPrice: candidate.priceUsd * (1 + TAKE_PROFIT_PCT),
            highestPriceSeen: candidate.priceUsd,
            simulated: SIMULATION_MODE,
            signature,
          };
          savePositions(positions);
        }
      }
    }

    // 6. Manage Open Positions (Stops & Targets with direct live pricing)
    const currentPositions = loadPositions();
    for (const [mint, pos] of Object.entries(currentPositions)) {
      const currentMemeData = memes.find((m) => m.tokenAddress === mint);
      const livePrice = heldPrices[mint] || currentMemeData?.priceUsd || pos.entryPriceUsd;
      const gainPct = (livePrice - pos.entryPriceUsd) / pos.entryPriceUsd;

      const timeHeldMs = Date.now() - pos.entryTime;
      const timeHeldMinutes = timeHeldMs / (1000 * 60);

      // Ejection: Time Limit
      if (timeHeldMinutes > MAX_HOLD_TIME_MINUTES) {
        console.log(`\n  ⏰ TIME LIMIT REACHED for $${pos.symbol} (Held > ${MAX_HOLD_TIME_MINUTES.toFixed(1)}m). Exiting to prevent slow bleed!`);
        if (!pos.simulated) {
           await executeMemeSell(connection, keypair, mint, pos.tokensHeldRaw, 15);
        }
        clearOFIState(mint);
        clearHMMState(mint);
        delete currentPositions[mint];
        savePositions(currentPositions);
        continue;
      }

      // Ejection: Chaotic Trading (Velocity) / Dumping
      if (currentMemeData && (currentMemeData.buys5m + currentMemeData.sells5m > 3000)) {
         console.log(`\n  🌪️ CHAOTIC VOLUME DETECTED for $${pos.symbol} (>3000 tx in 5m). Ejecting to avoid slippage/dump!`);
         if (!pos.simulated) {
           await executeMemeSell(connection, keypair, mint, pos.tokensHeldRaw, 15);
         }
         clearOFIState(mint);
         clearHMMState(mint);
         delete currentPositions[mint];
         savePositions(currentPositions);
         continue;
      }

      // Calculate Quant Signals (OFI & HMM)
      let ofiScore = 0;
      if (currentMemeData) {
         ofiScore = updateAndCalculateOFI(mint, currentMemeData.buys5m, currentMemeData.sells5m);
      }
      const hmmProbs = updateHMM(mint, gainPct, ofiScore);
      const hmmRegime = getRegimeString(hmmProbs);

      // Quant Ejection 1: OFI Tape Flip
      if (isTapeFlipping(ofiScore)) {
         console.log(`\n  🚨 QUANT EJECTION: OFI TAPE FLIP DETECTED on $${pos.symbol} (OFI: ${ofiScore.toFixed(0)}). Whales are unloading!`);
         if (!pos.simulated) {
           await executeMemeSell(connection, keypair, mint, pos.tokensHeldRaw, 15);
         }
         clearOFIState(mint);
         clearHMMState(mint);
         delete currentPositions[mint];
         savePositions(currentPositions);
         playTransactionSound('loss');
         continue;
      }

      // Quant Ejection 2: HMM Distribution State
      if (isDistributionRegime(mint)) {
         console.log(`\n  🚨 QUANT EJECTION: HMM DISTRIBUTION REGIME on $${pos.symbol} (${hmmRegime}). Ejecting instantly!`);
         if (!pos.simulated) {
           await executeMemeSell(connection, keypair, mint, pos.tokensHeldRaw, 15);
         }
         clearOFIState(mint);
         clearHMMState(mint);
         delete currentPositions[mint];
         savePositions(currentPositions);
         playTransactionSound('loss');
         continue;
      }

      // Update trailing high
      if (livePrice > pos.highestPriceSeen) {
        pos.highestPriceSeen = livePrice;
        if (gainPct >= TRAILING_TRIGGER_PCT) {
          // Trail the highest price seen by the stop-loss distance, but ensure it never drops below breakeven+5%
          const newStop = pos.highestPriceSeen * (1 - STOP_LOSS_PCT);
          const breakeven = pos.entryPriceUsd * 1.05;
          const targetStop = Math.max(newStop, breakeven);
          
          if (pos.stopLossPrice < targetStop) {
            pos.stopLossPrice = targetStop;
            console.log(`\n  🛡️ Trailing Stop Activated for $${pos.symbol}: Moved stop to $${targetStop.toFixed(6)}`);
          }
        }
        savePositions(currentPositions);
      }

      // Check Take-Profit
      if (livePrice >= pos.takeProfitPrice) {
        console.log(`\n  🎯 TAKE-PROFIT HIT for $${pos.symbol} at ${formatPrice(livePrice)} (+${(gainPct * 100).toFixed(1)}%)!`);
        if (!pos.simulated) {
          const sellRes = await executeMemeSell(connection, keypair, mint, pos.tokensHeldRaw, 15);
          if (sellRes.success) {
            console.log(`     ✅ LIVE SELL Confirmed via ${sellRes.source}! Tx: https://solscan.io/tx/${sellRes.signature}`);
          } else {
            console.log(`     ❌ Sell error: ${sellRes.error}`);
          }
        }
        playTransactionSound('win');
        clearOFIState(mint);
        clearHMMState(mint);
        delete currentPositions[mint];
        savePositions(currentPositions);
      }
      // Check Stop-Loss
      else if (livePrice <= pos.stopLossPrice) {
        console.log(`\n  🛑 STOP-LOSS HIT for $${pos.symbol} at ${formatPrice(livePrice)} (${(gainPct * 100).toFixed(1)}%)!`);
        if (!pos.simulated) {
          const sellRes = await executeMemeSell(connection, keypair, mint, pos.tokensHeldRaw, 15);
          if (sellRes.success) {
            console.log(`     ✅ LIVE STOP-SELL Confirmed via ${sellRes.source}! Tx: https://solscan.io/tx/${sellRes.signature}`);
          } else {
            console.log(`     ❌ Sell error: ${sellRes.error}`);
          }
        }
        playTransactionSound('loss');
        clearOFIState(mint);
        clearHMMState(mint);
        delete currentPositions[mint];
        savePositions(currentPositions);
      }
    }

    // 7. Display Active Positions
    const active = loadPositions();
    if (Object.keys(active).length > 0) {
      console.log(`\n  📂 Open Solana Meme Positions:`);
      for (const [mint, pos] of Object.entries(active)) {
        const live = heldPrices[mint] || memes.find((m) => m.tokenAddress === mint)?.priceUsd || pos.entryPriceUsd;
        const pnlPct = ((live - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
        const sign = pnlPct >= 0 ? '+' : '';
        console.log(
          `     • $${pos.symbol}: Entry ${formatPrice(pos.entryPriceUsd)} → Current ${formatPrice(live)} │ PnL: ${sign}${pnlPct.toFixed(1)}% │ Stop: ${formatPrice(pos.stopLossPrice)} │ Target: ${formatPrice(pos.takeProfitPrice)}`
        );
      }
    }

    console.log(`\n  ⏳ Next scan in 4s...`);
    await sleep(4000); // Poll aggressively to feed OFI/HMM engines
  }
}

main().catch((err) => {
  console.error('Fatal Solana Meme Sniper Error:', err);
  process.exit(1);
});
