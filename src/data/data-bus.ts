/**
 * Solana Quant Bot v3 — Data Bus
 * ─────────────────────────────────
 * Central pub/sub event bus. All modules communicate through here.
 * Zero coupling between producers and consumers.
 */

import { EventEmitter } from 'events';
import {
  PriceTick,
  Signal,
  TradeDecision,
  RegimeState,
  WhaleEvent,
  JournalEntry,
  MetricsSnapshot,
} from '../core/types';

// ============================================================
//  EVENT PAYLOAD TYPES
// ============================================================
export interface DataBusEvents {
  'price:update': PriceTick;
  'signal:generated': Signal;
  'trade:decision': TradeDecision;
  'trade:executed': JournalEntry;
  'regime:change': RegimeState;
  'whale:alert': WhaleEvent;
  'risk:circuit-breaker': { reason: string; pauseMs: number };
  'position:opened': { symbol: string; size: number; price: number };
  'position:closed': { symbol: string; pnl: number; reason: string };
  'metrics:updated': MetricsSnapshot;
  'engine:tick': { scanNumber: number; timestamp: number };
  'engine:error': { module: string; error: string };
}

// ============================================================
//  TYPED EVENT BUS
// ============================================================
export class DataBus {
  private emitter = new EventEmitter();

  constructor() {
    // Allow many listeners (one per module per event)
    this.emitter.setMaxListeners(50);
  }

  emit<K extends keyof DataBusEvents>(event: K, data: DataBusEvents[K]): void {
    this.emitter.emit(event, data);
  }

  on<K extends keyof DataBusEvents>(
    event: K,
    handler: (data: DataBusEvents[K]) => void,
  ): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
  }

  once<K extends keyof DataBusEvents>(
    event: K,
    handler: (data: DataBusEvents[K]) => void,
  ): void {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
  }

  off<K extends keyof DataBusEvents>(
    event: K,
    handler: (data: DataBusEvents[K]) => void,
  ): void {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
  }

  /** Number of listeners for a given event */
  listenerCount<K extends keyof DataBusEvents>(event: K): number {
    return this.emitter.listenerCount(event);
  }

  /** Remove all listeners (for graceful shutdown) */
  removeAll(): void {
    this.emitter.removeAllListeners();
  }
}

// Singleton — all modules import the same bus
export const dataBus = new DataBus();
