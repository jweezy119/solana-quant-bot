/**
 * ML Data Collection Pipeline
 * ────────────────────────────
 * Logs every scan cycle's indicators + outcome to CSV for ML training.
 * Outcomes are back-filled after 5m, 15m, and 1h to create labeled data.
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CSV_FILE = path.join(DATA_DIR, 'training_data.csv');
const PENDING_FILE = path.join(DATA_DIR, 'pending_outcomes.json');
const MAX_CSV_LINES = 50_000; // ~7 days of 12s scans across 16 products

const CSV_HEADER = [
  'timestamp', 'product', 'price', 'rsi', 'ema9', 'ema21', 'atr', 'atrPct',
  'bbLower', 'bbUpper', 'trend', 'ofi', 'arbSpread', 'socialScore',
  'btcPrice', 'btcRsi', 'action', 'confidence',
  'outcome_5m', 'outcome_15m', 'outcome_1h',
].join(',');

interface PendingOutcome {
  timestamp: number;
  product: string;
  price: number;
  csvLineIndex: number; // line number in CSV to back-fill
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureCsvHeader() {
  ensureDataDir();
  if (!fs.existsSync(CSV_FILE)) {
    fs.writeFileSync(CSV_FILE, CSV_HEADER + '\n', 'utf-8');
  }
}

function loadPending(): PendingOutcome[] {
  try {
    if (fs.existsSync(PENDING_FILE)) {
      return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function savePending(pending: PendingOutcome[]) {
  ensureDataDir();
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending), 'utf-8');
}

function countCsvLines(): number {
  try {
    const content = fs.readFileSync(CSV_FILE, 'utf-8');
    return content.split('\n').filter(l => l.trim()).length;
  } catch {
    return 0;
  }
}

function rotateCsvIfNeeded() {
  const lines = countCsvLines();
  if (lines > MAX_CSV_LINES) {
    // Keep last half of lines + header
    const content = fs.readFileSync(CSV_FILE, 'utf-8');
    const allLines = content.split('\n').filter(l => l.trim());
    const header = allLines[0];
    const keepFrom = Math.floor(allLines.length / 2);
    const kept = [header, ...allLines.slice(keepFrom)];
    fs.writeFileSync(CSV_FILE, kept.join('\n') + '\n', 'utf-8');
    console.log(`📊 [DATA] Rotated training CSV: ${lines} → ${kept.length} lines`);
  }
}

export interface DataPointInput {
  product: string;
  price: number;
  rsi: number;
  ema9: number;
  ema21: number;
  atr: number;
  atrPct: number;
  bbLower: number;
  bbUpper: number;
  trend: string;
  ofi: number;
  arbSpread: number;
  socialScore: number;
  btcPrice: number;
  btcRsi: number;
  action: string;
  confidence: number;
}

/**
 * Log a data point from the current scan cycle.
 * Outcome columns are left empty — they get back-filled later.
 */
export function collectDataPoint(input: DataPointInput) {
  ensureCsvHeader();
  rotateCsvIfNeeded();

  const now = Date.now();
  const row = [
    now, input.product, input.price.toFixed(8),
    input.rsi.toFixed(2), input.ema9.toFixed(8), input.ema21.toFixed(8),
    input.atr.toFixed(8), input.atrPct.toFixed(4),
    input.bbLower.toFixed(8), input.bbUpper.toFixed(8),
    input.trend, input.ofi.toFixed(4), input.arbSpread.toFixed(4),
    input.socialScore.toFixed(4),
    input.btcPrice.toFixed(2), input.btcRsi.toFixed(2),
    input.action, input.confidence.toFixed(4),
    '', '', '', // outcome_5m, outcome_15m, outcome_1h — filled later
  ].join(',');

  fs.appendFileSync(CSV_FILE, row + '\n', 'utf-8');

  // Track this data point for outcome back-fill
  const lineCount = countCsvLines();
  const pending = loadPending();
  pending.push({
    timestamp: now,
    product: input.product,
    price: input.price,
    csvLineIndex: lineCount - 1, // 0-indexed, this is the line we just wrote
  });

  // Only keep pending items from last 2 hours (anything older is stale)
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  const filtered = pending.filter(p => p.timestamp > twoHoursAgo);
  savePending(filtered);
}

/**
 * Back-fill outcome columns for data points that are now old enough.
 * Call this once per minute from the bot loop.
 */
export function backfillOutcomes(currentPrices: Record<string, number>) {
  if (!fs.existsSync(CSV_FILE) || !fs.existsSync(PENDING_FILE)) return;

  const pending = loadPending();
  if (pending.length === 0) return;

  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  const FIFTEEN_MIN = 15 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  // Read all CSV lines
  let lines: string[];
  try {
    lines = fs.readFileSync(CSV_FILE, 'utf-8').split('\n');
  } catch {
    return;
  }

  let modified = false;
  const remaining: PendingOutcome[] = [];

  for (const p of pending) {
    const age = now - p.timestamp;
    const currentPrice = currentPrices[`${p.product}-USDC`] || currentPrices[p.product] || 0;
    if (currentPrice <= 0) {
      remaining.push(p);
      continue;
    }

    if (p.csvLineIndex >= lines.length || p.csvLineIndex < 1) {
      continue; // Invalid line index, skip
    }

    const parts = lines[p.csvLineIndex].split(',');
    if (parts.length < 21) {
      remaining.push(p);
      continue;
    }

    let filled = false;

    // Back-fill 5m outcome
    if (age >= FIVE_MIN && !parts[18]) {
      const pctChange = ((currentPrice - p.price) / p.price) * 100;
      parts[18] = pctChange.toFixed(4);
      filled = true;
    }

    // Back-fill 15m outcome
    if (age >= FIFTEEN_MIN && !parts[19]) {
      const pctChange = ((currentPrice - p.price) / p.price) * 100;
      parts[19] = pctChange.toFixed(4);
      filled = true;
    }

    // Back-fill 1h outcome
    if (age >= ONE_HOUR && !parts[20]) {
      const pctChange = ((currentPrice - p.price) / p.price) * 100;
      parts[20] = pctChange.toFixed(4);
      filled = true;
    }

    if (filled) {
      lines[p.csvLineIndex] = parts.join(',');
      modified = true;
    }

    // Keep pending until all 3 outcomes are filled
    if (age < ONE_HOUR) {
      remaining.push(p);
    }
  }

  if (modified) {
    fs.writeFileSync(CSV_FILE, lines.join('\n'), 'utf-8');
  }

  savePending(remaining);
}
