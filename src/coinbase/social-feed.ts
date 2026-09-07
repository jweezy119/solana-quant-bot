/**
 * Coinbase Social Sentiment Harvester & NLP Analyzer
 * ──────────────────────────────────────────────────
 * Pulls sentiment from Twitter / X (via Bearer Token) or
 * real-time crypto news & social feeds (CoinTelegraph, etc.),
 * and scores bullish/bearish polarity and buzz velocity.
 */

import 'dotenv/config';
import { pollAlphaRadar } from '../radar/alpha-radar';

export interface SocialSentiment {
  token: string;              // e.g. "BTC"
  score: number;              // -1.0 (extreme bearish) to +1.0 (extreme bullish)
  confidence: number;         // 0.0 to 1.0
  buzzCount: number;          // Number of social/news mentions analyzed
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  sampleHeadlines: string[];  // Top relevant headlines or tweets
  source: 'twitter' | 'news_feed' | 'hybrid';
  lastUpdated: number;
  isWarPanicCascade?: boolean; // Geopolitical war headline panic freeze flag
}

// ─── CRYPTO LEXICON FOR SENTIMENT SCORING ─────────────────────
const BULLISH_KEYWORDS = [
  'breakout', 'bull', 'bullish', 'pump', 'rally', 'ath', 'surge', 'accumulating',
  'accumulation', 'moon', 'long', 'support held', 'skyrocket', 'rebound', 'inflow',
  'inflows', 'adoption', 'etf approval', 'all-time high', 'undervalued', 'gem',
  'buying the dip', 'higher highs', 'oversold bounce', 'golden cross', 'institutional buying'
];

const BEARISH_KEYWORDS = [
  'crash', 'dump', 'dumping', 'bear', 'bearish', 'rekt', 'rug', 'hack', 'hacked',
  'sec', 'lawsuit', 'ban', 'banned', 'fud', 'breakdown', 'short', 'resistance rejected',
  'liquidation', 'liquidated', 'selloff', 'plunge', 'plunging', 'panic', 'outflow',
  'outflows', 'fraud', 'overvalued', 'death cross', 'lower lows', 'bleeding'
];

// Geopolitical War & Global Escalation Panic keywords
const WAR_PANIC_KEYWORDS = [
  'war', 'missile', 'airstrike', 'escalat', 'ww3', 'geopolit', 'retaliat',
  'middle east strike', 'military action', 'emergency declaration', 'crude surge', 'conflict'
];

// In-memory cache to prevent spamming feeds / APIs
const sentimentCache: Record<string, { data: SocialSentiment; expiresAt: number }> = {};
const CACHE_TTL_MS = 60_000 * 2; // 2 minutes TTL

/**
 * Clean HTML and CDATA tags
 */
function cleanText(text: string): string {
  return text
    .replace(/<!\[CDATA\[(.*?)\]\]>/gi, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Evaluate sentiment of an array of text snippets
 */
function scoreSentimentLexicon(texts: string[]): { score: number; confidence: number; isWarPanicCascade: boolean } {
  if (texts.length === 0) {
    return { score: 0, confidence: 0.5, isWarPanicCascade: false };
  }

  let bullCount = 0;
  let bearCount = 0;
  let warPanicCount = 0;
  let totalWords = 0;

  for (const text of texts) {
    const lower = text.toLowerCase();
    const words = lower.split(/\W+/);
    totalWords += words.length;

    for (const kw of BULLISH_KEYWORDS) {
      if (lower.includes(kw)) {
        bullCount += kw.includes(' ') ? 2 : 1; // multi-word phrases get more weight
      }
    }

    for (const kw of BEARISH_KEYWORDS) {
      if (lower.includes(kw)) {
        bearCount += kw.includes(' ') ? 2 : 1;
      }
    }

    for (const kw of WAR_PANIC_KEYWORDS) {
      if (lower.includes(kw)) {
        warPanicCount++;
      }
    }
  }

  const net = bullCount - bearCount;
  const totalMatches = bullCount + bearCount;

  if (totalMatches === 0) {
    return { score: 0.05, confidence: 0.5, isWarPanicCascade: false }; // neutral slight optimism baseline
  }

  // Normalized score between -1 and +1
  const rawScore = net / Math.max(totalMatches, 1);
  const score = Math.max(-1, Math.min(1, rawScore));

  // Confidence scales with sample depth (more matches = higher statistical confidence)
  const confidence = Math.min(0.95, 0.5 + (totalMatches / (texts.length * 2 + 5)) * 0.45);

  return { score, confidence, isWarPanicCascade: warPanicCount >= 2 };
}

/**
 * Fetch recent tweets using Twitter / X API v2 (if TWITTER_BEARER_TOKEN is configured)
 */
async function fetchTwitterSentiment(token: string): Promise<{ texts: string[]; headlines: string[] } | null> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN || process.env.X_BEARER_TOKEN;
  if (!bearerToken) return null;

  try {
    const query = encodeURIComponent(`($${token} OR #${token}) lang:en -is:retweet`);
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=20&tweet.fields=public_metrics,created_at`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      console.warn(`[Twitter API] Search returned status ${res.status}: ${res.statusText}`);
      return null;
    }

    const json = (await res.json()) as any;
    const tweets = json.data || [];
    const texts: string[] = [];
    const headlines: string[] = [];

    for (const t of tweets) {
      if (t.text) {
        texts.push(t.text);
        if (headlines.length < 3) {
          headlines.push(`🐦 ${cleanText(t.text).slice(0, 100)}...`);
        }
      }
    }

    return { texts, headlines };
  } catch (err: any) {
    console.warn(`[Twitter API] Error fetching tweets for ${token}:`, err.message);
    return null;
  }
}

/**
 * Fetch breaking crypto news & social syndicate feeds (CoinTelegraph, etc.)
 */
async function fetchNewsFeedSentiment(token: string): Promise<{ texts: string[]; headlines: string[] }> {
  const feeds = [
    'https://cointelegraph.com/rss',
    'https://decrypt.co/feed',
  ];

  const texts: string[] = [];
  const headlines: string[] = [];

  const tokenAliases: Record<string, string[]> = {
    BTC: ['btc', 'bitcoin'],
    ETH: ['eth', 'ethereum', 'ether'],
    SOL: ['sol', 'solana'],
    XRP: ['xrp', 'ripple'],
    DOGE: ['doge', 'dogecoin'],
    PEPE: ['pepe', 'pepecoin', '$pepe'],
    BONK: ['bonk', '$bonk'],
    SHIB: ['shib', 'shiba', 'shiba inu'],
    SUI: ['sui', '$sui'],
    RENDER: ['render', 'rndr', '$render'],
    SEI: ['sei', '$sei'],
    AVAX: ['avax', 'avalanche'],
    NEAR: ['near', 'near protocol'],
  };

  const aliases = tokenAliases[token] || [token.toLowerCase(), `$${token.toLowerCase()}`];

  for (const feedUrl of feeds) {
    try {
      const res = await fetch(feedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
      });
      if (!res.ok) continue;

      const xml = await res.text();
      const itemRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<description>(.*?)<\/description>[\s\S]*?<\/item>/gi;
      let match: RegExpExecArray | null;

      while ((match = itemRegex.exec(xml)) !== null) {
        const title = cleanText(match[1]);
        const desc = cleanText(match[2]);
        const fullContent = `${title} ${desc}`.toLowerCase();

        // Check if item mentions this token
        const matchesToken = aliases.some(alias => {
          const regex = new RegExp(`\\b${alias}\\b`, 'i');
          return regex.test(fullContent);
        });

        if (matchesToken) {
          texts.push(`${title}. ${desc}`);
          if (headlines.length < 3) {
            headlines.push(`📰 ${title.slice(0, 100)}`);
          }
        }
      }
    } catch {
      // Continue to next feed on failure
    }
  }

  return { texts, headlines };
}

/**
 * Get aggregated social media / Twitter sentiment for a crypto token
 */
export async function getSocialSentiment(tokenSymbol: string): Promise<SocialSentiment> {
  const cleanSymbol = tokenSymbol.toUpperCase().replace('-USD', '').replace('-USDC', '');
  const now = Date.now();

  // Return cached result if fresh
  if (sentimentCache[cleanSymbol] && sentimentCache[cleanSymbol].expiresAt > now) {
    return sentimentCache[cleanSymbol].data;
  }

  let source: 'twitter' | 'news_feed' | 'hybrid' = 'news_feed';
  const collectedTexts: string[] = [];
  const sampleHeadlines: string[] = [];

  // 1. Query real-time Alpha Radar (DexScreener meme momentum + Helius Whale tracker + Coinbase listings)
  const radar = await pollAlphaRadar();
  if (radar.summary) {
    sampleHeadlines.push(radar.summary);
  }

  // 2. Try Twitter API if credentials exist
  const twitterResult = await fetchTwitterSentiment(cleanSymbol);
  if (twitterResult && twitterResult.texts.length > 0) {
    source = 'twitter';
    collectedTexts.push(...twitterResult.texts);
    sampleHeadlines.push(...twitterResult.headlines.slice(0, 2));
  }

  // 3. Fallback news feed check
  if (collectedTexts.length === 0) {
    const newsResult = await fetchNewsFeedSentiment(cleanSymbol);
    if (newsResult.texts.length > 0) {
      source = 'news_feed';
      collectedTexts.push(...newsResult.texts);
    }
  }

  // Score using NLP Lexicon for macro / war panic check
  const { score: macroScore, confidence: macroConf, isWarPanicCascade } = scoreSentimentLexicon(collectedTexts);

  // Fuse Alpha Radar (70% weight) with Macro News (30% weight)
  const combinedScore = isWarPanicCascade ? -0.85 : parseFloat(((radar.score * 0.70) + (macroScore * 0.30)).toFixed(3));
  const combinedConf = parseFloat(((radar.confidence * 0.70) + (macroConf * 0.30)).toFixed(2));

  let direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (combinedScore >= 0.15) {
    direction = 'BULLISH';
  } else if (combinedScore <= -0.15) {
    direction = 'BEARISH';
  }

  const result: SocialSentiment = {
    token: cleanSymbol,
    score: combinedScore,
    confidence: combinedConf,
    buzzCount: collectedTexts.length + radar.activeMemeCount,
    direction,
    sampleHeadlines,
    source,
    lastUpdated: now,
    isWarPanicCascade,
  };

  // Cache result
  sentimentCache[cleanSymbol] = {
    data: result,
    expiresAt: now + CACHE_TTL_MS,
  };

  return result;
}
