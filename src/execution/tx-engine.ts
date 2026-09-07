/**
 * Transaction Engine
 * ──────────────────
 * Retry logic, circuit breaker, and RPC failover.
 */

import { Connection, Keypair } from '@solana/web3.js';
import { RPC_ENDPOINT, RPC_FALLBACK, HELIUS_RPC } from '../core/config';

// ============================================================
//  CIRCUIT BREAKER
// ============================================================
let consecutiveFailures = 0;
const MAX_FAILURES = 5;
let circuitOpen = false;
let circuitResetTime = 0;

export function isCircuitOpen(): boolean {
  if (circuitOpen && Date.now() > circuitResetTime) {
    circuitOpen = false;
    consecutiveFailures = 0;
    console.log('  🔌  Circuit breaker reset — resuming transactions');
  }
  return circuitOpen;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
}

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_FAILURES) {
    circuitOpen = true;
    circuitResetTime = Date.now() + 5 * 60 * 1000; // 5 min cooldown
    console.log(`  🔴  Circuit breaker OPEN — ${MAX_FAILURES} consecutive failures`);
  }
}

// ============================================================
//  RETRY WITH BACKOFF
// ============================================================
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  if (isCircuitOpen()) {
    throw new Error('Circuit breaker is open');
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (e: any) {
      lastError = e;
      if (attempt < maxRetries) {
        // Exponential backoff with jitter
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        console.log(`  ⏳  Retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms: ${e.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  recordFailure();
  throw lastError ?? new Error('withRetry failed');
}

// ============================================================
//  RPC CONNECTION WITH FAILOVER
// ============================================================
export function createConnection(): Connection {
  // Priority: Helius (if available) → configured RPC → fallback
  const endpoint = HELIUS_RPC || RPC_ENDPOINT;
  return new Connection(endpoint, 'confirmed');
}

export function createFallbackConnection(): Connection {
  return new Connection(RPC_FALLBACK, 'confirmed');
}

// ============================================================
//  SLEEP
// ============================================================
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
