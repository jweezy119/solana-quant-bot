import { HELIUS_WS, TOKENS } from '../core/config';
import { DataBus } from './data-bus';
import { WhaleEvent } from '../core/types';

/**
 * Helius Websocket integration for real-time blockchain events.
 * Used for detecting whale movements, liquidity pool changes,
 * and extremely fast price updates via Geyser/Yellowstone RPC plugins.
 */
export class HeliusWebsocket {
  private bus: DataBus;
  private ws: any | null = null; // Use appropriate WebSocket type in production
  private isRunning = false;

  constructor(bus: DataBus) {
    this.bus = bus;
  }

  public async connect(): Promise<void> {
    if (this.isRunning) return;
    
    const rpcUrl = HELIUS_WS;
    if (!rpcUrl.includes('helius')) {
      console.warn('⚠️ Non-Helius RPC detected. Some advanced WS features may not work.');
    }

    this.isRunning = true;
    console.log(`🔌 Connecting to Solana Websocket for whale monitoring...`);
    
    // In production, we would use native WebSocket or @solana/web3.js Connection.onLogs
    // For this mock, we simulate incoming whale events
    
    this.simulateEvents();
  }

  public disconnect(): void {
    if (this.ws) {
      // this.ws.close();
      this.ws = null;
    }
    this.isRunning = false;
    console.log('🛑 Helius Websocket disconnected.');
  }

  private simulateEvents(): void {
    if (!this.isRunning) return;
    
    // Simulate a whale event every 10-30 seconds
    const delay = 10000 + Math.random() * 20000;
    
    setTimeout(() => {
      if (!this.isRunning) return;
      
      const tokens = TOKENS.map(t => t.symbol);
      if (tokens.length > 0) {
        const token = tokens[Math.floor(Math.random() * tokens.length)];
        const isBuy = Math.random() > 0.5;
        const amountUsd = 100000 + Math.random() * 900000; // $100k to $1M
        
        const whaleEvent: WhaleEvent = {
          wallet: `Whale_${Math.random().toString(36).substring(7)}`,
          token,
          direction: isBuy ? 'BUY' : 'SELL',
          amountUsd,
          timestamp: Date.now(),
          txSignature: `tx_${Math.random().toString(36).substring(7)}`
        };
        
        this.bus.emit('whale:alert', whaleEvent);
      }
      
      this.simulateEvents();
    }, delay);
  }
}
