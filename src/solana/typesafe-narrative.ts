/**
 * TypeSafe Jev Narrative Sniper Engine
 * ─────────────────────────────
 * Evaluates meme coin token profiles (description, metadata, website text) 
 * at launch. Uses TypeSafe's Jev System One model to instantly grade the
 * cult potential, flag generic AI/copy-paste descriptions, and identify 
 * connection to established communities.
 */

import 'dotenv/config';
import { TypeSafeClient, score, noul } from '@typesafe-ai/sdk';

export interface TypeSafeNarrative {
  /** 0.0 (generic rug) to 4.0 (cult narrative) */
  cultScore: number;
  /** Probability this is a low-effort generic copy-paste or AI generated rug */
  rugProbability: number;
  /** Probability this token references an existing established community/trend */
  establishedCommunityProb: number;
  /** Confidence in the cult score */
  confidence: number;
  /** Did it use Jev (false = fallback) */
  usedJev: boolean;
}

// ─── CACHE ────────────────────────────────────────────────────
const jevCache: Record<string, { data: TypeSafeNarrative; expiresAt: number }> = {};
const JEV_CACHE_TTL_MS = 600_000; // 10 minutes

// ─── CLIENT SINGLETON ─────────────────────────────────────────
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
 * Analyze narrative of a meme token using TypeSafe Jev.
 *
 * @param symbol - Token symbol (e.g., "$WIF")
 * @param description - Token description from DexScreener/Pump.fun
 * @param socialLinks - String representation of socials (e.g. "Website, Twitter, Telegram")
 */
export async function analyzeNarrativeWithJev(
  symbol: string,
  description: string,
  socialLinks: string,
): Promise<TypeSafeNarrative | null> {
  const tsClient = getClient();
  if (!tsClient) return null;

  const now = Date.now();

  const cacheKey = `${symbol}:${description.length}`;
  if (jevCache[cacheKey] && jevCache[cacheKey].expiresAt > now) {
    return jevCache[cacheKey].data;
  }

  // If no description, it's very low effort.
  if (!description || description.trim() === '') {
    return {
      cultScore: 0.0,
      rugProbability: 0.95,
      establishedCommunityProb: 0.0,
      confidence: 0.9,
      usedJev: false,
    };
  }

  try {
    const response = await tsClient.systemOne({
      state: {
        asset: symbol,
        description: description,
        socials: socialLinks,
        context: `Evaluate this meme coin launch. Meme coins succeed purely on narrative, cult following, and humor. We are looking for highly original, high-effort, cult-like narratives and avoiding low-effort, AI-generated, generic pump-and-dump copy-pastes.`
      },
      questions: {
        cult_potential: score(
          `What is the cult and viral potential of this meme coin narrative based on the description and metadata?`,
          [
            'Extremely low effort — Generic copy-paste, obvious AI generated text, meaningless buzzwords, or completely empty.',
            'Below average — Unoriginal dog/cat variant with no unique angle or humor.',
            'Average — Decent effort, standard meme formatting, some humor but nothing highly viral.',
            'High potential — Highly original, genuinely funny, unique meta, or strong narrative angle.',
            'Cult status — Masterclass in meme culture, unhinged genius, highly viral framing, instantly recognizable cult potential.'
          ]
        ),
        is_generic_rug: noul(
          `Does this description read like an extremely generic, low-effort, or AI-generated copy-paste designed for a quick rug-pull scam?`
        ),
        has_established_meta: noul(
          `Does this narrative strongly reference a known real-world event, established influencer, popular video game, or heavily trending internet meta?`
        )
      }
    });

    const cultAnswer = response.answers.cult_potential;
    const rugAnswer = response.answers.is_generic_rug;
    const establishedAnswer = response.answers.has_established_meta;

    const result: TypeSafeNarrative = {
      cultScore: cultAnswer.score, // 0 to 4
      rugProbability: rugAnswer.noul,
      establishedCommunityProb: establishedAnswer.noul,
      confidence: cultAnswer.confidence,
      usedJev: true,
    };

    jevCache[cacheKey] = { data: result, expiresAt: now + JEV_CACHE_TTL_MS };

    return result;
  } catch (err: any) {
    console.warn(`[TypeSafe Jev] Narrative call failed for ${symbol}: ${err.message}.`);
    return null;
  }
}
