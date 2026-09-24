/**
 * TypeSafe Jev Sybil & Wallet Clustering Detector
 * ───────────────────────────────────────────────
 * Analyzes the top 10 token holders of a newly launched meme coin.
 * Uses Jev to evaluate if the distribution looks like a malicious
 * Sybil attack (developer splitting supply into 50 wallets of 1.5% each
 * to bypass RugCheck) vs a healthy decentralized distribution.
 */

import 'dotenv/config';
import { TypeSafeClient, noul } from '@typesafe-ai/sdk';
import { Connection, PublicKey } from '@solana/web3.js';

export interface TypeSafeSybilResult {
  isSybilCluster: boolean;
  sybilProbability: number;
  usedJev: boolean;
}

// ─── CACHE ────────────────────────────────────────────────────
const jevCache: Record<string, { data: TypeSafeSybilResult; expiresAt: number }> = {};
const JEV_CACHE_TTL_MS = 300_000; // 5 minutes

let client: TypeSafeClient | null = null;
function getClient(): TypeSafeClient | null {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  if (!client) {
    client = new TypeSafeClient({ apiKey });
  }
  return client;
}

/**
 * Fetch top holders from Solana RPC and analyze with Jev.
 */
export async function analyzeSybilClustering(
  connection: Connection,
  tokenAddress: string
): Promise<TypeSafeSybilResult | null> {
  const tsClient = getClient();
  if (!tsClient) return null;

  const now = Date.now();
  if (jevCache[tokenAddress] && jevCache[tokenAddress].expiresAt > now) {
    return jevCache[tokenAddress].data;
  }

  let largestAccounts: any[] = [];
  try {
    const mintPubkey = new PublicKey(tokenAddress);
    // Get top 20 token accounts
    const res = await connection.getTokenLargestAccounts(mintPubkey, 'confirmed');
    largestAccounts = res.value || [];
  } catch (err: any) {
    console.warn(`[TypeSafe Sybil] Failed to fetch largest accounts for ${tokenAddress}: ${err.message}`);
    return null;
  }

  if (largestAccounts.length === 0) return null;

  // Assume total supply roughly equals the sum of the top 20 if it's a new coin, 
  // or we can just look at relative sizing.
  const totalInTop20 = largestAccounts.reduce((sum, acc) => sum + (acc.uiAmount || 0), 0);
  
  if (totalInTop20 === 0) return null;

  // Format the top 15 wallets as a string for Jev to analyze
  const distributionText = largestAccounts
    .slice(0, 15)
    .map((acc, i) => `Wallet ${i + 1}: ${((acc.uiAmount || 0) / totalInTop20 * 100).toFixed(2)}% of top supply`)
    .join('\n');

  try {
    const response = await tsClient.systemOne({
      state: {
        asset: tokenAddress,
        distribution: distributionText,
        context: `Evaluate the token supply distribution. Malicious developers often split their supply into many wallets (e.g. holding exactly 1.5% to 3% each) to evade detection from generic rug-checkers. Healthy launches usually have a curve of differing amounts, or one large bonding curve / Raydium pool wallet.`
      },
      questions: {
        is_sybil_cluster: noul(
          `Based on this wallet distribution, is there a high probability of a Sybil clustering attack? (e.g., several wallets holding near-identical, suspicious percentages like 2.0% each, indicating a developer splitting supply to dump).`
        )
      }
    });

    const sybilAnswer = response.answers.is_sybil_cluster;
    const isSybil = sybilAnswer.noul >= 0.65;

    const result: TypeSafeSybilResult = {
      isSybilCluster: isSybil,
      sybilProbability: sybilAnswer.noul,
      usedJev: true,
    };

    jevCache[tokenAddress] = { data: result, expiresAt: now + JEV_CACHE_TTL_MS };

    return result;
  } catch (err: any) {
    console.warn(`[TypeSafe Jev] Sybil call failed for ${tokenAddress}: ${err.message}.`);
    return null;
  }
}
