/**
 * Order Flow Imbalance (OFI) Engine
 * ─────────────────────────────────
 * High-frequency quant module that tracks tick-by-tick buying vs selling pressure.
 * When OFI flips deeply negative, it indicates extreme whale distribution (dumping).
 */

export interface OfiTick {
  buys: number;
  sells: number;
  timestamp: number;
}

const ofiState: Record<string, OfiTick[]> = {};
const OFI_WINDOW = 5; // Track last 5 ticks

/**
 * Updates the Order Flow Imbalance (OFI) for a token and calculates the current delta.
 * Returns the current OFI score. Extremely negative values indicate heavy dumping.
 */
export function updateAndCalculateOFI(mint: string, currentBuys: number, currentSells: number): number {
  if (!ofiState[mint]) {
    ofiState[mint] = [];
  }

  const ticks = ofiState[mint];
  ticks.push({ buys: currentBuys, sells: currentSells, timestamp: Date.now() });

  if (ticks.length > OFI_WINDOW) {
    ticks.shift();
  }

  if (ticks.length < 2) return 0; // Not enough data yet

  let totalOfi = 0;

  // Calculate moving OFI over the window
  for (let i = 1; i < ticks.length; i++) {
    const prev = ticks[i - 1];
    const curr = ticks[i];

    const deltaBuys = curr.buys - prev.buys;
    const deltaSells = curr.sells - prev.sells;

    // Order Flow Imbalance = Net Buying Pressure - Net Selling Pressure
    const tickOfi = deltaBuys - deltaSells;
    totalOfi += tickOfi;
  }

  return totalOfi;
}

/**
 * Checks if the OFI indicates a "Tape Flip" (massive whale unloading)
 */
export function isTapeFlipping(ofiScore: number): boolean {
  // If we see more than 150 net sells over the short window, it's a catastrophic dump
  return ofiScore < -150;
}

/**
 * Clean up state for tokens no longer tracked
 */
export function clearOFIState(mint: string) {
  delete ofiState[mint];
}
