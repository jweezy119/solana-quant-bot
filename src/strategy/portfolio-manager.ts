/**
 * Cross-Asset Correlation Matrix & Portfolio Manager
 * ──────────────────────────────────────────────────
 * Calculates rolling Pearson correlation between assets to
 * minimize portfolio variance. Prevents entering new positions
 * that are highly correlated with existing open positions.
 */

import { PriceHistory, Position } from '../core/types';

const MAX_CORRELATION = 0.85;
const CORRELATION_WINDOW = 60; // Use last 60 periods (e.g. 3-5 mins depending on poll rate)

/**
 * Computes the Pearson correlation coefficient between two arrays.
 * Returns a value between -1 and 1.
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n === 0) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const valX = x[x.length - n + i];
    const valY = y[y.length - n + i];
    
    sumX += valX;
    sumY += valY;
    sumXY += (valX * valY);
    sumX2 += (valX * valX);
    sumY2 += (valY * valY);
  }

  const numerator = (n * sumXY) - (sumX * sumY);
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Returns an array of percentage returns from an array of prices.
 */
function getReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return returns;
}

/**
 * Checks if a candidate symbol is safe to buy given the currently open positions.
 * It calculates the correlation of returns between the candidate and all open positions.
 * If the correlation > MAX_CORRELATION for ANY open position, the trade is rejected.
 * 
 * @param candidateSymbol - The symbol we want to buy
 * @param openPositions - The currently open positions (Record or array)
 * @param histories - Record of all price histories
 * @returns { allowed: boolean, reason?: string }
 */
export function checkPortfolioVariance(
  candidateSymbol: string,
  openPositions: Record<string, Position>,
  histories: Record<string, PriceHistory>
): { allowed: boolean, reason?: string } {
  const candidateHistory = histories[candidateSymbol];
  
  // Need enough data
  if (!candidateHistory || candidateHistory.prices.length < CORRELATION_WINDOW) {
    return { allowed: true }; 
  }

  const candidateReturns = getReturns(candidateHistory.prices.slice(-CORRELATION_WINDOW - 1));

  for (const posSymbol of Object.keys(openPositions)) {
    if (posSymbol === candidateSymbol) continue; // Should already be caught by hasPosition, but just in case

    const posHistory = histories[posSymbol];
    if (!posHistory || posHistory.prices.length < CORRELATION_WINDOW) continue;

    const posReturns = getReturns(posHistory.prices.slice(-CORRELATION_WINDOW - 1));
    const corr = pearsonCorrelation(candidateReturns, posReturns);

    if (corr > MAX_CORRELATION) {
      return { 
        allowed: false, 
        reason: `Highly correlated with open position ${posSymbol} (r = ${corr.toFixed(2)})` 
      };
    }
  }

  return { allowed: true };
}
