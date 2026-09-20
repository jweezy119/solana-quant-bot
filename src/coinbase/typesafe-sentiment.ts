/**
 * TypeSafe Jev Sentiment Engine
 * ─────────────────────────────
 * Replaces the crude keyword-lexicon sentiment scorer with TypeSafe's
 * Jev System One model. Sends headlines + market context and receives
 * calibrated probabilities for bullish/bearish sentiment, war panic,
 * and regulatory FUD — all in a single API call.
 *
 * Falls back gracefully to the legacy keyword scorer if the API key
 * is missing or the call fails.
 */

import 'dotenv/config';
import { TypeSafeClient, score, noul } from '@typesafe-ai/sdk';

export interface TypeSafeSentiment {
  /** -1.0 (extreme bearish) to +1.0 (extreme bullish) */
  score: number;
  /** 0.0 to 1.0 — model confidence in the sentiment judgment */
  confidence: number;
  /** Geopolitical war/conflict/escalation panic detected */
  isWarPanic: boolean;
  /** Probability of war panic (raw Noul value) */
  warPanicProb: number;
  /** Imminent regulatory crackdown / SEC / exchange hack */
  isRegulatoryScare: boolean;
  /** Probability of regulatory scare (raw Noul value) */
  regulatoryScareProb: number;
  /** Whether TypeSafe was used (false = fell back to lexicon) */
  usedJev: boolean;
}

// ─── CACHE ────────────────────────────────────────────────────
const jevCache: Record<string, { data: TypeSafeSentiment; expiresAt: number }> = {};
const JEV_CACHE_TTL_MS = 120_000; // 2 minutes

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
 * Analyze sentiment of crypto headlines using TypeSafe Jev.
 *
 * Sends a single request with 3 parallel questions:
 * 1. Score: overall bullish/bearish sentiment (5 levels)
 * 2. Noul: is there a geopolitical war panic?
 * 3. Noul: is there an imminent regulatory crackdown?
 *
 * @param token   - The crypto symbol (e.g. "BTC", "SOL")
 * @param texts   - Array of headline/tweet strings to evaluate
 * @returns       - Structured sentiment with calibrated probabilities
 */
export async function analyzeWithJev(
  token: string,
  texts: string[],
): Promise<TypeSafeSentiment | null> {
  const tsClient = getClient();
  if (!tsClient) return null;

  const now = Date.now();

  // Check cache
  const cacheKey = `${token}:${texts.length}`;
  if (jevCache[cacheKey] && jevCache[cacheKey].expiresAt > now) {
    return jevCache[cacheKey].data;
  }

  if (texts.length === 0) {
    // No headlines — return a neutral baseline
    return {
      score: 0.05,
      confidence: 0.5,
      isWarPanic: false,
      warPanicProb: 0,
      isRegulatoryScare: false,
      regulatoryScareProb: 0,
      usedJev: true,
    };
  }

  // Trim to most recent 15 headlines to keep token usage reasonable
  const recentTexts = texts.slice(0, 15);
  const headlineBlock = recentTexts.map((t, i) => `[${i + 1}] ${t}`).join('\n');

  try {
    const response = await tsClient.systemOne({
      state: {
        asset: token,
        context: `The following are recent news headlines and social media posts about ${token} cryptocurrency. Evaluate the overall market sentiment.`,
        headlines: headlineBlock,
      },
      questions: {
        sentiment: score(
          `What is the overall market sentiment toward ${token} based on these headlines?`,
          [
            'Strongly bearish — panic selling, crash, major hack, or regulatory crackdown language dominates',
            'Moderately bearish — negative tone, concerns about price drops, FUD, or unfavorable news outweighs positive',
            'Neutral or mixed — balanced positive and negative signals, or headlines are not price-relevant',
            'Moderately bullish — positive tone, accumulation signals, favorable news, or institutional interest',
            'Strongly bullish — euphoria, breakout, ATH, major adoption, or ETF approval language dominates',
          ],
        ),
        war_panic: noul(
          `Do the headlines describe an active or escalating geopolitical conflict, military action, war, or global emergency that would cause a crypto-wide panic selloff?`,
        ),
        regulatory_scare: noul(
          `Do the headlines describe an imminent SEC enforcement action, major exchange hack, fraud discovery, or government ban that would cause a sudden price crash for ${token}?`,
        ),
      },
    });

    const sentimentAnswer = response.answers.sentiment;
    const warPanicAnswer = response.answers.war_panic;
    const regulatoryAnswer = response.answers.regulatory_scare;

    // Convert 5-level score (0-4) into -1.0 to +1.0 range
    // Level 0 = -1.0, Level 1 = -0.5, Level 2 = 0.0, Level 3 = +0.5, Level 4 = +1.0
    const rawScore = sentimentAnswer.score; // 0 to 4
    const normalizedScore = (rawScore - 2) / 2; // maps 0→-1, 2→0, 4→+1

    const result: TypeSafeSentiment = {
      score: parseFloat(normalizedScore.toFixed(3)),
      confidence: sentimentAnswer.confidence,
      isWarPanic: warPanicAnswer.noul >= 0.7,
      warPanicProb: warPanicAnswer.noul,
      isRegulatoryScare: regulatoryAnswer.noul >= 0.7,
      regulatoryScareProb: regulatoryAnswer.noul,
      usedJev: true,
    };

    // Cache
    jevCache[cacheKey] = { data: result, expiresAt: now + JEV_CACHE_TTL_MS };

    return result;
  } catch (err: any) {
    console.warn(`[TypeSafe Jev] Sentiment call failed for ${token}: ${err.message}. Falling back to lexicon.`);
    return null;
  }
}
