/**
 * Trade Journal
 * ─────────────
 * Logs every trade with full context for post-analysis.
 * JSON-file backed (upgradeable to SQLite later).
 */

import fs from 'fs';
import { JournalEntry } from '../core/types';
import { DATA_DIR } from '../core/config';
import { MarketRegime, SignalSource } from '../core/types';
import { FUSION_WEIGHTS } from '../core/config';

const JOURNAL_FILE = `${DATA_DIR}/trade-journal.json`;
const journal: JournalEntry[] = [];

// Bayesian prior for Kelly Criterion
let kellyAlpha = 11; // ~55% prior win rate
let kellyBeta = 9;
let ewmaWinPct = 4.0;
let ewmaLossPct = 2.0;

interface SignalPerformance {
  trades: number;
  sumReturns: number;
  sumSquaredReturns: number;
}
const signalStats: Record<string, SignalPerformance> = {};

export function loadJournal(): void {
  try {
    if (fs.existsSync(JOURNAL_FILE)) {
      const data = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf-8'));
      journal.push(...data);
      // Replay journal to restore Kelly state
      for (const entry of journal) {
        if (entry.exitPrice !== undefined) {
          updateKellyPrior(entry.pnl > 0, entry.pnlPct);
        }
      }
      console.log(`📓  Loaded ${journal.length} journal entries`);
    }
  } catch { /* fresh */ }
}

function updateKellyPrior(won: boolean, magnitude: number) {
  if (won) {
    kellyAlpha += 1;
    ewmaWinPct = ewmaWinPct * 0.9 + magnitude * 0.1;
  } else {
    kellyBeta += 1;
    ewmaLossPct = ewmaLossPct * 0.9 + Math.abs(magnitude) * 0.1;
  }
  // Exponential decay of old evidence
  kellyAlpha = Math.max(2, kellyAlpha * 0.995);
  kellyBeta = Math.max(2, kellyBeta * 0.995);
}

function updateSignalMemory(entry: JournalEntry) {
  if (!entry.entrySignals || entry.entrySignals.length === 0) return;
  const ret = entry.pnlPct;
  for (const src of entry.entrySignals) {
    if (!signalStats[src]) signalStats[src] = { trades: 0, sumReturns: 0, sumSquaredReturns: 0 };
    signalStats[src].trades += 1;
    signalStats[src].sumReturns += ret;
    signalStats[src].sumSquaredReturns += ret * ret;
  }
  
  // Every 5 trades, recalibrate
  const totalClosed = journal.filter(e => e.exitPrice !== undefined).length;
  if (totalClosed > 0 && totalClosed % 5 === 0) {
    recalibrateFusionWeights();
  }
}

function recalibrateFusionWeights() {
  const sharpes: Record<string, number> = {};
  for (const src in signalStats) {
    const stat = signalStats[src];
    if (stat.trades < 3) continue;
    const avg = stat.sumReturns / stat.trades;
    const variance = (stat.sumSquaredReturns / stat.trades) - (avg * avg);
    const std = Math.sqrt(Math.max(0, variance));
    sharpes[src] = std > 0 ? (avg / std) : (avg < 0 ? -1 : 0);
  }
  
  for (const regimeValue of Object.values(MarketRegime)) {
    const regime = regimeValue as MarketRegime;
    const weights = FUSION_WEIGHTS[regime];
    if (!weights) continue;
    let total = 0;
    for (const src in weights) {
      if (sharpes[src] !== undefined) {
        if (sharpes[src] < 0) weights[src as SignalSource]! *= 0.5;
        else if (sharpes[src] > 1.5) weights[src as SignalSource]! *= 1.3;
      }
      total += weights[src as SignalSource]!;
    }
    if (total > 0) {
      for (const src in weights) weights[src as SignalSource]! /= total;
    }
  }
}

function saveJournal(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2));
  } catch (e: any) {
    console.error(`  ⚠️  Failed to save journal: ${e.message}`);
  }
}

export function recordTrade(entry: JournalEntry): void {
  journal.push(entry);
  if (entry.exitPrice !== undefined) {
    updateKellyPrior(entry.pnl > 0, entry.pnlPct);
    updateSignalMemory(entry);
  }
  saveJournal();
}

export function getJournal(): JournalEntry[] {
  return [...journal];
}

/**
 * Compute actual win rate from trade history (Bayesian updated).
 */
export function getHistoricalWinRate(): number {
  return kellyAlpha / (kellyAlpha + kellyBeta);
}

/**
 * Compute actual win/loss ratio from trade history (EWMA).
 */
export function getHistoricalWinLossRatio(): number {
  return ewmaLossPct > 0 ? ewmaWinPct / ewmaLossPct : 2.0;
}
