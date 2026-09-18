/**
 * Hidden Markov Model (HMM) - Micro-Regime Detection
 * ────────────────────────────────────────────────
 * Classifies the current millisecond state of a meme coin into:
 * 0: ACCUMULATION (Neutral)
 * 1: MARKUP (Pumping / Viral)
 * 2: DISTRIBUTION (Whales Dumping)
 */

export enum Regime {
  ACCUMULATION = 0,
  MARKUP = 1,
  DISTRIBUTION = 2
}

interface HmmState {
  probabilities: [number, number, number]; // P(Accumulation), P(Markup), P(Distribution)
}

const hmmInstances: Record<string, HmmState> = {};

// Transition probabilities (Prior beliefs of shifting states)
// P(State_t | State_{t-1})
const TRANSITIONS = [
  // From Accumulation
  [0.80, 0.15, 0.05],
  // From Markup
  [0.05, 0.80, 0.15],
  // From Distribution
  [0.10, 0.05, 0.85]
];

/**
 * Normalizes an array of probabilities so they sum to 1
 */
function normalize(probs: [number, number, number]): [number, number, number] {
  const sum = probs[0] + probs[1] + probs[2];
  return [probs[0] / sum, probs[1] / sum, probs[2] / sum];
}

/**
 * Updates the HMM state probabilities using the Forward algorithm approach.
 * Returns the probability distribution of the 3 states.
 */
export function updateHMM(mint: string, priceReturn: number, ofiScore: number): [number, number, number] {
  if (!hmmInstances[mint]) {
    // Start with assumed accumulation
    hmmInstances[mint] = { probabilities: [0.8, 0.1, 0.1] };
  }

  const prevProbs = hmmInstances[mint].probabilities;

  // Emission Probabilities: P(Observation | State)
  // Simplified Gaussian-like logic for Price Return and OFI

  // Accumulation: low price movement, neutral OFI
  let eAcc = 1.0;
  if (Math.abs(priceReturn) > 0.02 || Math.abs(ofiScore) > 20) eAcc = 0.1;

  // Markup: positive price, highly positive OFI
  let eMark = 0.1;
  if (priceReturn > 0.01 && ofiScore > 10) eMark = 0.8;
  if (priceReturn > 0.05) eMark = 0.95;

  // Distribution: negative price, deeply negative OFI
  let eDist = 0.1;
  if (priceReturn < -0.01 || ofiScore < -30) eDist = 0.7;
  if (priceReturn < -0.03 || ofiScore < -100) eDist = 0.99;

  const emissions = [eAcc, eMark, eDist];

  // Calculate new probabilities: P(State_t) = Emission * sum(PrevProb_i * Transition_{i->t})
  const newProbs: [number, number, number] = [0, 0, 0];

  for (let t = 0; t < 3; t++) {
    let sumTrans = 0;
    for (let prev = 0; prev < 3; prev++) {
      sumTrans += prevProbs[prev] * TRANSITIONS[prev][t];
    }
    newProbs[t] = emissions[t] * sumTrans;
  }

  const normalized = normalize(newProbs);
  hmmInstances[mint].probabilities = normalized;

  return normalized;
}

/**
 * Checks if the HMM detects a clear Distribution phase (>80% probability)
 */
export function isDistributionRegime(mint: string): boolean {
  if (!hmmInstances[mint]) return false;
  return hmmInstances[mint].probabilities[Regime.DISTRIBUTION] > 0.80;
}

/**
 * Formats the regime for logging
 */
export function getRegimeString(probs: [number, number, number]): string {
  const maxIdx = probs.indexOf(Math.max(...probs));
  const pct = (probs[maxIdx] * 100).toFixed(0);
  switch (maxIdx) {
    case Regime.ACCUMULATION: return `ACCUMULATION (${pct}%)`;
    case Regime.MARKUP: return `MARKUP (${pct}%)`;
    case Regime.DISTRIBUTION: return `DISTRIBUTION (${pct}%)`;
    default: return `UNKNOWN`;
  }
}

/**
 * Clean up state
 */
export function clearHMMState(mint: string) {
  delete hmmInstances[mint];
}
