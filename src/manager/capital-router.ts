/**
 * Capital Router & Bankroll Sweeper
 * ─────────────────────────────────
 * Auto-adjusts Solana Meme Sniper risk parameters based on live bankroll.
 * If bankroll drops below survival thresholds, it tightens stops and caps positions.
 * If bankroll hits major profit thresholds, it "sweeps" the excess profits
 * via on-chain transfer to the Coinbase Deposit address for compounding.
 */

import 'dotenv/config';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

export interface DynamicStrategyConfig {
  maxConcurrentPositions: number;
  tradeSizingSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  mode: 'SURVIVAL' | 'STANDARD' | 'AGGRESSIVE' | 'HALTED';
}

const SWEEP_THRESHOLD_SOL = 2.5; // Trigger sweep when bankroll hits this
const SWEEP_AMOUNT_SOL = 1.0;    // Amount of profit to send to Coinbase

let lastSweepTime = 0;
const SWEEP_COOLDOWN_MS = 1000 * 60 * 60; // 1 hour cooldown between sweeps

/**
 * Automatically shift trading strategy gears based on the live SOL bankroll.
 */
export function autoAdjustStrategy(solBal: number): DynamicStrategyConfig {
  if (solBal < 0.05) {
    // Bankroll effectively depleted. Halt trading to prevent gas death-spiral.
    return {
      maxConcurrentPositions: 0,
      tradeSizingSol: 0,
      takeProfitPct: 0.10,
      stopLossPct: 0.10,
      mode: 'HALTED'
    };
  }
  
  if (solBal < 0.5) {
    // SURVIVAL MODE: Bankroll is low. 
    // Cap positions to 1, reduce sizing, tighten stops to protect remaining capital.
    return {
      maxConcurrentPositions: 1,
      tradeSizingSol: Math.max(0.015, solBal * 0.15),
      takeProfitPct: 0.30,
      stopLossPct: 0.15,
      mode: 'SURVIVAL'
    };
  }

  if (solBal >= 1.5) {
    // AGGRESSIVE MODE: Bankroll is flush.
    // Increase positions, increase sizing, widen stops to catch massive runners.
    return {
      maxConcurrentPositions: 4,
      tradeSizingSol: solBal * 0.25,
      takeProfitPct: 0.75, // +75% TP
      stopLossPct: 0.25,   // -25% SL
      mode: 'AGGRESSIVE'
    };
  }

  // STANDARD MODE (0.5 to 1.5 SOL)
  return {
    maxConcurrentPositions: 3,
    tradeSizingSol: solBal * 0.20,
    takeProfitPct: 0.50,
    stopLossPct: 0.20,
    mode: 'STANDARD'
  };
}

/**
 * Checks if the bankroll hit the profit threshold and sweeps excess
 * to the configured Coinbase deposit address.
 */
export async function sweepProfitsToCoinbase(
  solBal: number,
  keypair: Keypair,
  connection: Connection
): Promise<{ swept: boolean; amountSol?: number; signature?: string; error?: string }> {
  if (solBal < SWEEP_THRESHOLD_SOL) return { swept: false };
  
  const now = Date.now();
  if (now - lastSweepTime < SWEEP_COOLDOWN_MS) return { swept: false };

  const depositAddress = process.env.COINBASE_DEPOSIT_ADDRESS;
  if (!depositAddress) {
    console.log(`\n  ⚠️ PROFIT SWEEP READY but COINBASE_DEPOSIT_ADDRESS is missing in .env! (Bankroll: ${solBal.toFixed(2)} SOL)`);
    return { swept: false, error: 'Missing deposit address' };
  }

  console.log(`\n  🎉 BANKROLL TARGET HIT! Initiating profit sweep of ${SWEEP_AMOUNT_SOL} SOL to Coinbase...`);

  try {
    const toPubkey = new PublicKey(depositAddress);
    
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey,
        lamports: SWEEP_AMOUNT_SOL * 1e9,
      })
    );

    // Fetch recent blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = keypair.publicKey;

    // Send and confirm
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [keypair],
      { commitment: 'confirmed' }
    );

    lastSweepTime = now;
    console.log(`  🏦 SWEPT SUCCESSFULLY! ${SWEEP_AMOUNT_SOL} SOL bridging to Coinbase Quant Compounder. Tx: https://solscan.io/tx/${signature}`);
    
    return { swept: true, amountSol: SWEEP_AMOUNT_SOL, signature };

  } catch (err: any) {
    console.error(`  ❌ SWEEP FAILED: ${err.message}`);
    return { swept: false, error: err.message };
  }
}
