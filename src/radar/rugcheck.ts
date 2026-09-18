/**
 * RugCheck API Integration
 * ────────────────────────
 * Checks Solana token mints against the free RugCheck.xyz API
 * to detect malicious contracts, honeypots, and rugged distributions.
 */

export interface RugCheckRisk {
  name: string;
  value: string;
  description: string;
  score: number;
  level: 'danger' | 'warn' | 'good';
}

export interface RugCheckReport {
  mint: string;
  tokenProgram: string;
  score: number;
  risks: RugCheckRisk[];
}

/**
 * Validates a token mint against RugCheck.
 * Returns true if the token is considered "safe" (no danger risks).
 */
export async function isTokenSafeRugCheck(mint: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      headers: { 'User-Agent': 'QuantRadar/1.0' },
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!res.ok) {
      // If the API fails or rate limits, default to false (safe approach) or true?
      // Since it's a safety measure, we'll return false if we can't verify,
      // but to prevent blocking all trades if API is down, we can log a warning.
      if (res.status === 429) {
        console.warn(`[RugCheck] Rate limited. Allowing token ${mint} conditionally.`);
        return true; 
      }
      return false;
    }

    const report = (await res.json()) as RugCheckReport;
    
    // A score over 500 is generally considered highly risky by RugCheck
    if (report.score > 500) {
      console.log(`[RugCheck] 🛑 Token ${mint} REJECTED: RugCheck Score is too high (${report.score}).`);
      return false;
    }

    // Check for explicit "danger" level risks (e.g. mint authority active, honeypot)
    if (report.risks && report.risks.length > 0) {
      const dangerRisks = report.risks.filter(r => r.level === 'danger');
      if (dangerRisks.length > 0) {
        console.log(`[RugCheck] 🛑 Token ${mint} REJECTED: Found ${dangerRisks.length} DANGER risks (e.g., ${dangerRisks[0].name}).`);
        return false;
      }
    }

    return true; // Token passes checks
  } catch (err: any) {
    console.error(`[RugCheck] Error fetching report for ${mint}: ${err.message}`);
    // Defaulting to true on network error so we don't completely halt the bot if rugcheck goes down,
    // but this is a design choice. For maximum safety, return false. We will return false.
    return false;
  }
}
