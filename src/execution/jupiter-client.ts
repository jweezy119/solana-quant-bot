/**
 * Jupiter Client (Extracted + Enhanced)
 * ──────────────────────────────────────
 * Handles all Jupiter v6 API interactions.
 * Enhanced with dynamic priority fees and rate-limit awareness.
 */

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { TokenInfo } from '../core/types';
import {
  JUPITER_QUOTE_URL, JUPITER_SWAP_URL, JUPITER_PRICE_URL, SLIPPAGE_BPS,
  USDC_MINT, TIMING, FEATURES,
} from '../core/config';
import { sendJitoBundle } from './jito-executor';

const usdcHuman = (raw: number) => raw / 1_000_000;

// ============================================================
//  QUOTE
// ============================================================
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: number,
  dex?: string,
  customSlippageBps?: number,
): Promise<any | null> {
  const slippage = customSlippageBps ?? SLIPPAGE_BPS;
  let url = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippage}`;
  if (dex) url += `&dexes=${encodeURIComponent(dex)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMING.API_TIMEOUT_MS) });
  if (res.status === 429) throw new Error('Rate limited (429)');
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  return data?.outAmount ? data : null;
}

// ============================================================
//  PRICE
// ============================================================
export async function getPrice(token: TokenInfo): Promise<number | null> {
  try {
    const q = await getQuote(token.mint, USDC_MINT, Math.pow(10, token.decimals));
    if (!q) return null;
    return usdcHuman(parseInt(q.outAmount, 10));
  } catch (e) {
    return null;
  }
}

// ============================================================
//  SWAP TRANSACTION
// ============================================================
export async function getSwapTx(quote: any, pubkey: string): Promise<string> {
  const res = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: pubkey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: {
        maxBps: 300 // allow Jupiter to adjust slippage up to 3% dynamically within our quote
      },
      prioritizationFeeLamports: {
        autoMultiplier: 2, // 2x the auto fee to ensure inclusion
      },
    }),
    signal: AbortSignal.timeout(TIMING.SWAP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Swap API HTTP ${res.status}`);
  const data = (await res.json()) as any;
  if (!data.swapTransaction) throw new Error('No swapTransaction');
  return data.swapTransaction as string;
}

// ============================================================
//  SEND TRANSACTION
// ============================================================
export async function sendTransaction(
  conn: Connection,
  kp: Keypair,
  b64: string,
): Promise<string> {
  if (FEATURES.JITO_BUNDLES) {
    return await sendJitoBundle(conn, kp, b64);
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const lbh = await conn.getLatestBlockhash('confirmed');
  await conn.confirmTransaction(
    { signature: sig, blockhash: lbh.blockhash, lastValidBlockHeight: lbh.lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}

// ============================================================
//  HIGH-LEVEL: BUY TOKEN
// ============================================================
export async function buyToken(
  conn: Connection,
  kp: Keypair,
  token: TokenInfo,
  usdcAmountRaw: number,
  customSlippageBps?: number,
): Promise<{ signature: string; tokensReceived: number; price: number }> {
  const quote = await getQuote(USDC_MINT, token.mint, usdcAmountRaw, undefined, customSlippageBps);
  if (!quote) throw new Error(`No buy route for ${token.symbol}`);

  const swapTx = await getSwapTx(quote, kp.publicKey.toBase58());
  const signature = await sendTransaction(conn, kp, swapTx);

  const tokensReceived = parseInt(quote.outAmount, 10) / Math.pow(10, token.decimals);
  const price = usdcHuman(usdcAmountRaw) / tokensReceived;

  return { signature, tokensReceived, price };
}

// ============================================================
//  HIGH-LEVEL: SELL TOKEN
// ============================================================
export async function sellToken(
  conn: Connection,
  kp: Keypair,
  token: TokenInfo,
  tokenAmountRaw: number,
  customSlippageBps?: number,
): Promise<{ signature: string; usdcReceived: number }> {
  const quote = await getQuote(token.mint, USDC_MINT, tokenAmountRaw, undefined, customSlippageBps);
  if (!quote) throw new Error(`No sell route for ${token.symbol}`);

  const swapTx = await getSwapTx(quote, kp.publicKey.toBase58());
  const signature = await sendTransaction(conn, kp, swapTx);

  const usdcReceived = usdcHuman(parseInt(quote.outAmount, 10));
  return { signature, usdcReceived };
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ============================================================
//  HIGH-LEVEL: BUY WITH NATIVE SOL (FOR MEME COIN SNIPING)
// ============================================================
export async function buyTokenWithSol(
  conn: Connection,
  kp: Keypair,
  outputMint: string,
  solAmountLamports: number,
  customSlippageBps = 250,
): Promise<{ signature: string; outAmount: number }> {
  const quote = await getQuote(SOL_MINT, outputMint, solAmountLamports, undefined, customSlippageBps);
  if (!quote) throw new Error(`No Jupiter route from SOL to ${outputMint}`);

  const swapTx = await getSwapTx(quote, kp.publicKey.toBase58());
  const signature = await sendTransaction(conn, kp, swapTx);
  return { signature, outAmount: parseInt(quote.outAmount, 10) };
}

// ============================================================
//  HIGH-LEVEL: SELL TOKEN FOR NATIVE SOL
// ============================================================
export async function sellTokenForSol(
  conn: Connection,
  kp: Keypair,
  inputMint: string,
  tokenAmountRaw: number,
  customSlippageBps = 250,
): Promise<{ signature: string; solReceived: number }> {
  const quote = await getQuote(inputMint, SOL_MINT, tokenAmountRaw, undefined, customSlippageBps);
  if (!quote) throw new Error(`No Jupiter route from ${inputMint} to SOL`);

  const swapTx = await getSwapTx(quote, kp.publicKey.toBase58());
  const signature = await sendTransaction(conn, kp, swapTx);
  return { signature, solReceived: parseInt(quote.outAmount, 10) / 1e9 };
}
