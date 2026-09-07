/**
 * Position Store
 * ──────────────
 * JSON-file backed position persistence with type safety.
 */

import fs from 'fs';
import { Position } from '../core/types';
import { POSITIONS_FILE, DATA_DIR } from '../core/config';

const positions: Record<string, Position> = {};

export function loadPositions(): Record<string, Position> {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(POSITIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8'));
      Object.assign(positions, data);
      console.log(`📂  Loaded ${Object.keys(positions).length} open position(s)`);
    }
  } catch { /* fresh start */ }
  return positions;
}

export function savePositions(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
  } catch (e: any) {
    console.error(`  ⚠️  Failed to save positions: ${e.message}`);
  }
}

export function getPosition(symbol: string): Position | undefined {
  return positions[symbol];
}

export function setPosition(symbol: string, pos: Position): void {
  positions[symbol] = pos;
  savePositions();
}

export function deletePosition(symbol: string): void {
  delete positions[symbol];
  savePositions();
}

export function getAllPositions(): Record<string, Position> {
  return positions;
}

export function getPositionCount(): number {
  return Object.keys(positions).length;
}
