/**
 * Cross-DEX Spread Detection (Enhanced)
 * ──────────────────────────────────────
 * Compares prices across Raydium, Orca, Meteora.
 * Used as a confidence booster for swing entries.
 */

import { TokenInfo, Signal } from '../core/types';
import { CROSS_DEX, SLIPPAGE_BPS, USDC_MINT } from '../core/config';
import { createSignal } from './signal-types';

const JUPITER_QUOTE_URL = 'https://public.jupiterapi.com/quote';

async function getQuote(
  inputMint: string, outputMint: string,
  amountRaw: number, dex?: string,
): Promise<any | null> {
  let url = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${SLIPPAGE_BPS}`;
  if (dex) url += `&dexes=${encodeURIComponent(dex)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 429) throw new Error('Rate limited');
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  return data?.outAmount ? data : null;
}

export async function checkCrossDexSpread(token: TokenInfo): Promise<number> {
  let maxSpread = 0;
  for (const buyDex of CROSS_DEX.DEX_LABELS) {
    for (const sellDex of CROSS_DEX.DEX_LABELS) {
      if (buyDex === sellDex) continue;
      try {
        const buyQ = await getQuote(USDC_MINT, token.mint, CROSS_DEX.CHECK_AMOUNT_RAW, buyDex);
        if (!buyQ) continue;
        const sellQ = await getQuote(token.mint, USDC_MINT, parseInt(buyQ.outAmount, 10), sellDex);
        if (!sellQ) continue;
        const spread = ((parseInt(sellQ.outAmount, 10) - CROSS_DEX.CHECK_AMOUNT_RAW) / CROSS_DEX.CHECK_AMOUNT_RAW) * 100;
        if (spread > maxSpread) maxSpread = spread;
      } catch { /* skip failed routes */ }
    }
  }
  return maxSpread;
}

export async function generateCrossDexSignal(
  token: TokenInfo, hasPosition: boolean,
): Promise<Signal | null> {
  if (hasPosition) return null;
  try {
    const spread = await checkCrossDexSpread(token);
    if (spread >= CROSS_DEX.MIN_SPREAD_PCT) {
      const confidence = 0.5 + Math.min(spread / 3, 0.4);
      return createSignal('cross-dex', 'LONG', confidence, token.symbol, {
        reason: 'spread-detected', spread,
      });
    }
  } catch { /* non-critical */ }
  return null;
}
