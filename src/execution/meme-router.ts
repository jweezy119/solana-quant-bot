/**
 * Unified Meme Coin Swap Router
 * ──────────────────────────────
 * Routes swaps dynamically between:
 * 1. PumpPortal Local API (for Pump.fun bonding curve & PumpSwap AMMs)
 * 2. Jupiter Aggregator v6 (for Raydium, Meteora, Orca, and graduated tokens)
 *
 * All transactions are signed locally with your private key and submitted
 * via your high-speed Helius RPC connection.
 */

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { buyTokenWithSol, sellTokenForSol } from './jupiter-client';

export interface MemeTradeResult {
  success: boolean;
  signature: string;
  source: 'PUMPPORTAL' | 'JUPITER';
  error?: string;
}

/**
 * Execute a buy for a meme token using native SOL
 */
export async function executeMemeBuy(
  conn: Connection,
  kp: Keypair,
  mint: string,
  solAmount: number,
  slippagePct = 3
): Promise<MemeTradeResult> {
  const isPumpToken = mint.toLowerCase().endsWith('pump');

  // Strategy A: If Pump.fun token, try PumpPortal first
  if (isPumpToken) {
    try {
      const dynamicPriorityFee = Math.min(0.003, solAmount * 0.015); // Max 1.5% of trade size, capped at 0.003 SOL
      const res = await fetch('https://pumpportal.fun/api/trade-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: kp.publicKey.toBase58(),
          action: 'buy',
          mint,
          amount: solAmount,
          denominatedInSol: 'true',
          slippage: slippagePct,
          priorityFee: Math.max(0.0001, dynamicPriorityFee), // Minimum 0.0001 SOL bribe
          pool: 'auto',
        }),
        signal: AbortSignal.timeout(6000),
      });

      if (res.ok) {
        const txBuf = await res.arrayBuffer();
        if (txBuf.byteLength > 100) {
          const tx = VersionedTransaction.deserialize(new Uint8Array(txBuf));
          tx.sign([kp]);

          const sig = await conn.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: 3,
          });

          return { success: true, signature: sig, source: 'PUMPPORTAL' };
        }
      }
    } catch (e: any) {
      // Fall through to Jupiter
    }
  }

  // Strategy B: Jupiter Route (Raydium, Meteora, or fallback)
  try {
    const lamports = Math.floor(solAmount * 1e9);
    const jupRes = await buyTokenWithSol(conn, kp, mint, lamports, slippagePct * 100);
    return { success: true, signature: jupRes.signature, source: 'JUPITER' };
  } catch (err: any) {
    return {
      success: false,
      signature: '',
      source: isPumpToken ? 'PUMPPORTAL' : 'JUPITER',
      error: err.message,
    };
  }
}

/**
 * Execute a sell of a meme token back to native SOL
 */
export async function executeMemeSell(
  conn: Connection,
  kp: Keypair,
  mint: string,
  rawTokensHeld = 0,
  slippagePct = 3
): Promise<MemeTradeResult> {
  const isPumpToken = mint.toLowerCase().endsWith('pump');

  // Strategy A: Try PumpPortal 100% sell
  if (isPumpToken) {
    try {
      // For selling, we assume roughly the same dynamic fee as entry to avoid eating the bankroll
      const res = await fetch('https://pumpportal.fun/api/trade-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: kp.publicKey.toBase58(),
          action: 'sell',
          mint,
          amount: '100%',
          denominatedInSol: 'false',
          slippage: slippagePct,
          priorityFee: 0.0002, // Lower flash exit bribe for micro-accounts
          pool: 'auto',
        }),
        signal: AbortSignal.timeout(6000),
      });

      if (res.ok) {
        const txBuf = await res.arrayBuffer();
        if (txBuf.byteLength > 100) {
          const tx = VersionedTransaction.deserialize(new Uint8Array(txBuf));
          tx.sign([kp]);

          const sig = await conn.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: 3,
          });

          return { success: true, signature: sig, source: 'PUMPPORTAL' };
        }
      }
    } catch {
      // Fall through to Jupiter
    }
  }

  // Strategy B: Jupiter Sell
  let tokensToSell = rawTokensHeld;
  if (tokensToSell <= 0) {
    try {
      const accounts = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(mint) });
      if (accounts.value && accounts.value.length > 0) {
        tokensToSell = parseInt(accounts.value[0].account.data.parsed.info.tokenAmount.amount, 10);
      }
    } catch {}
  }

  if (tokensToSell > 0) {
    try {
      const jupRes = await sellTokenForSol(conn, kp, mint, tokensToSell, slippagePct * 100);
      return { success: true, signature: jupRes.signature, source: 'JUPITER' };
    } catch (err: any) {
      return { success: false, signature: '', source: 'JUPITER', error: err.message };
    }
  }

  return { success: false, signature: '', source: 'PUMPPORTAL', error: 'No token balance found to sell' };
}
