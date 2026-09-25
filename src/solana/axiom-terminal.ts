/**
 * Axiom / Photon -Style Live WebSocket Terminal
 * With Pegasus AI (TypeSafe) NLP Semantic Filter & Auto-Exit Ledger
 * ─────────────────────────────────────────────
 * Streams 0-block token creations, grades the token using TypeSafe AI
 * on narrative potential, tracks Raydium Migrations,
 * and manages auto-selling at Take Profit / Stop Loss.
 */

import 'dotenv/config';
import WebSocket from 'ws';
import { executeMemeBuy, executeMemeSell } from '../execution/meme-router';
import { Keypair, Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { TypeSafeClient, score } from '@typesafe-ai/sdk';

const typeSafe = new TypeSafeClient();
const SIMULATION_MODE = process.env.MEME_SNIPER_SIMULATION !== 'false';
const TRADE_SIZE_SOL = 0.015; // Decreased from 0.03 to protect remaining bankroll
const MAX_CONCURRENT_BAGS = 2; // Hard cap
const PUMP_PORTAL_WS = 'wss://pumpportal.fun/api/data';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const POSITIONS_FILE = path.join(DATA_DIR, 'solana-meme-positions.json');

console.clear();
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('  🦄  AXIOM TERMINAL: PEGASUS AI (TYPESAFE) & AUTO-EXIT ENGINE');
console.log(`  💼  Mode: ${SIMULATION_MODE ? '🟡 SIMULATION (Paper Trading)' : '🔴 LIVE ON-CHAIN'}`);
console.log('  📡  Connecting to PumpPortal 0-Block Stream...');
console.log('═══════════════════════════════════════════════════════════════════════════════');

const ws = new WebSocket(PUMP_PORTAL_WS);

let connection: Connection | null = null;
let keypair: Keypair | null = null;

if (!SIMULATION_MODE) {
  const pk = process.env.PRIVATE_KEY;
  if (pk) {
    keypair = Keypair.fromSecretKey(bs58.decode(pk));
    const rpcUrl = process.env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : 'https://api.mainnet-beta.solana.com';
    connection = new Connection(rpcUrl, 'confirmed');
  }
}

// ─── LEDGER SYSTEM ────────────────────────────────────────────────────────
interface SolanaMemePosition {
  tokenAddress: string;
  symbol: string;
  entrySolSpent: number;
  tokensHeldRaw: number;
  entryTime: number;
  simulated: boolean;
  signature?: string;
  quantScore?: number;
}

function loadPositions(): Record<string, SolanaMemePosition> {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(POSITIONS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8')); } catch { return {}; }
}
function savePositions(pos: Record<string, SolanaMemePosition>) {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(pos, null, 2), 'utf-8');
}

ws.on('open', () => {
  console.log('  🟢 Socket Open. Subscribing to Live Token Creations...\n');
  ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  
  console.log('  🟢 Subscribing to Raydium Graduations (Pump.fun Migrations)...\n');
  ws.send(JSON.stringify({ method: "subscribeMigration" })); 
});

process.on('SIGINT', async () => {
  console.log('\n🛑 [SHUTDOWN SEQUENCE INITIATED] Stopping terminal and securing capital...');
  ws.close();
  
  const positions = loadPositions();
  const mints = Object.keys(positions);
  
  if (mints.length > 0) {
    console.log(`  ⚠️ You have ${mints.length} open bags. The Auto-Exit engine is turning off.`);
    console.log(`  🔪 Liquidating all positions to native SOL to prevent orphaned bags...`);
    
    for (const mint of mints) {
      const pos = positions[mint];
      console.log(`     -> Selling ${pos.symbol}...`);
      if (!SIMULATION_MODE && connection && keypair) {
         try {
           await executeMemeSell(connection, keypair, mint, pos.tokensHeldRaw, 15);
         } catch (e) { console.log(`        ❌ Failed to sell ${pos.symbol}.`); }
      }
      delete positions[mint];
    }
    savePositions(positions);
    console.log(`  ✅ All capital secured. Safe to power down.`);
  } else {
    console.log(`  ✅ No open positions. Safe to power down.`);
  }
  
  process.exit(0);
});

ws.on('message', async (data: Buffer) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.txType === 'create' && msg.mint && msg.name && msg.symbol) {
    if (!msg.twitter && !msg.telegram) {
       console.log(`\n  [REJECTED] ❌ ${msg.symbol} has no socials (No X/TG). Instant Rug signature.`);
       return;
    }

    const initialBuyTokens = msg.initialBuy || 0;
    const devHoldPct = (initialBuyTokens / 1_000_000_000) * 100; 

    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`\n  [${timestamp}] 💊 [NEW MINT] ${msg.symbol} │ Dev Hold: ${devHoldPct.toFixed(1)}%`);
    
    // Asynchronous Pegasus AI Evaluation
    analyzeTokenWithAI(msg.mint, msg.symbol, msg.name, devHoldPct, false).catch(() => {});
  }

  // ============================================
  // EVENT: TOKEN MIGRATES TO RAYDIUM
  // ============================================
  if (msg.txType === 'raydiumMigration' || (msg.message && msg.message.includes('Migration'))) {
    const mint = msg.mint;
    const symbol = msg.symbol || 'RAY_MIGRATE';
    const name = msg.name || 'Unknown';
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    
    console.log(`\n  [${timestamp}] 🚀 [RAYDIUM MIGRATION DETECTED] Token ${symbol} is graduating!`);
    console.log(`     📊 Checking Jev Semantic NLP to ensure it's not a scam push...`);
    
    // Asynchronous Pegasus AI Evaluation (isRaydium = true)
    analyzeTokenWithAI(mint, symbol, name, 0, true).catch(() => {});
  }
});

/**
 * PEGASUS TIER: TypeSafe NLP Semantic Scoring
 */
async function analyzeTokenWithAI(mint: string, symbol: string, name: string, devHoldPct: number, isRaydium: boolean) {
  let finalScore = 0;
  let failReason = "";

  // 1. Math Filter (Skip if Raydium, curve already filled)
  if (!isRaydium) {
    if (devHoldPct > 8.0) failReason = `Dev holds too much (${devHoldPct.toFixed(1)}% > 8.0% — Rug Risk)`;
    else if (devHoldPct < 3.5) failReason = `Dev didn't spend enough (${devHoldPct.toFixed(1)}% < 3.5% — Spent less than 1 SOL)`;
    else finalScore += 40; // Sweet spot base score
  } else {
    finalScore += 40; // Raydium Momentum Base Score
  }

  if (failReason) {
    console.log(`     ❌ [REJECTED] ${failReason}`);
    return;
  }

  console.log(`     🤖 Requesting Pegasus TypeSafe AI Semantic Evaluation for "${name}" ($${symbol})...`);

  try {
    const aiRes = await typeSafe.systemOne({
      state: { ticker: symbol, token_name: name },
      questions: {
        memePotential: score("How strong is the viral meme narrative or meta potential of this token name and ticker? Reject random gibberish or low-effort names.", [
          "Random gibberish, keyboard smashes, or zero-effort (e.g. ASD, FDSD, TEST, dsfs)",
          "Weak or overplayed (e.g. standard generic names without twist, random words like 'apple')",
          "Decent meme, recognizable pop culture, but not highly unique",
          "Strong meta, funny, catchy, likely to catch attention on Crypto Twitter",
          "God-tier viral narrative, hilarious, highly culturally relevant or extremely clever ticker"
        ])
      }
    });

    const memeScoreValue = aiRes.answers.memePotential.score + 1; // 1 to 5
    // Multiply AI score (1=12, 2=24, 3=36, 4=48, 5=60)
    finalScore += (memeScoreValue * 12);
    
    console.log(`     🦄 [AI NLP SCORE: ${memeScoreValue}/5] ${symbol} | Total Quant: ${finalScore}/100`);

    if (memeScoreValue < 4) {
       console.log(`     ❌ [REJECTED] Jev Narrative Score too low (${memeScoreValue}/5). Demanding 4.0 or higher.`);
       return;
    }

    if (finalScore >= 85) {
      console.log(`     ✅ [APPROVED] Token meets elite Pegasus AI parameters!`);
      
      const pos = loadPositions();
      const activePositions = Object.keys(pos);
      
      if (activePositions.length >= MAX_CONCURRENT_BAGS) {
        let weakestMint = "";
        let lowestScore = Infinity;
        for (const m of activePositions) {
           const p = pos[m];
           const score = p.quantScore || 0; // Legacy bags have 0 score, making them easy targets for rotation
           if (score < lowestScore) {
              lowestScore = score;
              weakestMint = m;
           }
        }
        
        if (finalScore > lowestScore) {
           console.log(`     🔄 [ALPHA ROTATION] New token ${symbol} (Score: ${finalScore}) is STRONGER than held bag ${pos[weakestMint].symbol} (Score: ${lowestScore}).`);
           console.log(`     🔪 Liquidating weaker bag ${pos[weakestMint].symbol} to free up portfolio space...`);
           if (!SIMULATION_MODE && connection && keypair) {
             executeMemeSell(connection, keypair, weakestMint, pos[weakestMint].tokensHeldRaw, 15).catch(()=>{});
           }
           delete pos[weakestMint];
           savePositions(pos);
        } else {
           console.log(`     🛑 Holding max bags (${MAX_CONCURRENT_BAGS}). New token ${symbol} (Score: ${finalScore}) is NOT stronger than our weakest bag (Score: ${lowestScore}). Passing.`);
           return;
        }
      }

      if (!SIMULATION_MODE && connection && keypair) {
        console.log(`     ⚡ APEING IN: Routing ${TRADE_SIZE_SOL} SOL buy...`);
        executeMemeBuy(connection, keypair, mint, TRADE_SIZE_SOL, 10).then(async (res: any) => {
          if (res.success) {
             console.log(`     ✅ BOUGHT! Fetching balance to save to Auto-Exit ledger. Tx: https://solscan.io/tx/${res.signature}`);
             await new Promise(r => setTimeout(r, 3000));
             let tokensHeld = 0;
             try {
                const accounts = await connection!.getParsedTokenAccountsByOwner(keypair!.publicKey, { mint: new (require('@solana/web3.js').PublicKey)(mint) });
                if (accounts.value && accounts.value.length > 0) {
                  tokensHeld = parseInt(accounts.value[0].account.data.parsed.info.tokenAmount.amount, 10);
                }
             } catch {}
             const newPos = loadPositions(); // reload in case it changed
             newPos[mint] = {
               tokenAddress: mint,
               symbol: symbol,
               entrySolSpent: TRADE_SIZE_SOL,
               tokensHeldRaw: tokensHeld,
               entryTime: Date.now(),
               simulated: false,
               signature: res.signature,
               quantScore: finalScore
             };
             savePositions(newPos);
          }
        });
      } else {
        console.log(`     🟡 (SIMULATION: Paper Trade Executed)`);
      }
    } else {
      console.log(`     ❌ [REJECTED] AI determined weak narrative (Score: ${finalScore}/100)`);
    }

  } catch (error) {
    console.log(`     ⚠️ AI Timeout/Error on ${symbol}, bypassing.`);
  }
}

ws.on('close', () => { console.log('  🔴 Socket Closed. Terminal Offline. Rebooting...'); process.exit(1); });
ws.on('error', (err) => { console.error('  ❌ Socket Error:', err.message); process.exit(1); });


// ─── AUTO-EXIT BACKGROUND LOOP ───────────────────────────────────────────
async function getHeldPrices(mints: string[]) {
  if (mints.length === 0) return {};
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`);
    const data = await res.json() as any;
    const prices: Record<string, number> = {};
    for (const p of data.pairs || []) {
      if (p.baseToken?.address && !prices[p.baseToken.address]) {
        prices[p.baseToken.address] = parseFloat(p.priceUsd || '0');
      }
    }
    return prices;
  } catch { return {}; }
}

setInterval(async () => {
  if (SIMULATION_MODE || !connection || !keypair) return;

  const positions = loadPositions();
  const mints = Object.keys(positions);
  if (mints.length === 0) return;

  const currentPrices = await getHeldPrices(mints);
  const solPriceUsd = 140; 
  const entryValueUsd = TRADE_SIZE_SOL * solPriceUsd; 
  const tpTargetUsd = entryValueUsd * 1.30; // +30%
  const slTargetUsd = entryValueUsd * 0.85; // -15%

  for (const mint of mints) {
    const pos = positions[mint];
    const price = currentPrices[mint];
    if (!price) continue; 

    const tokenAmount = pos.tokensHeldRaw / 1_000_000;
    const currentBagValueUsd = tokenAmount * price;

    if (currentBagValueUsd >= tpTargetUsd) {
      console.log(`\n  🎯 [TAKE PROFIT TRIGGERED] ${pos.symbol} Bag hit $${currentBagValueUsd.toFixed(2)} (+30%). Auto-Selling...`);
      delete positions[mint]; 
      savePositions(positions);
      executeMemeSell(connection, keypair, mint, pos.tokensHeldRaw, 15);
    } 
    else if (currentBagValueUsd <= slTargetUsd) {
      console.log(`\n  🛡️ [STOP LOSS TRIGGERED] ${pos.symbol} Bag dropped to $${currentBagValueUsd.toFixed(2)} (-15%). Cutting bags...`);
      delete positions[mint]; 
      savePositions(positions);
      executeMemeSell(connection, keypair, mint, pos.tokensHeldRaw, 15);
    }
  }
}, 5000);
