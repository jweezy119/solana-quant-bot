import { TOKENS } from '../core/config';
import { DataBus } from './data-bus';
import { PriceTick } from '../core/types';

/**
 * Connects to Jupiter's price APIs or Websocket (if available)
 * to stream latest prices for target tokens.
 */
export class JupiterPriceFeed {
  private bus: DataBus;
  private tokens: string[];
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(bus: DataBus) {
    this.bus = bus;
    this.tokens = TOKENS.map(t => t.symbol);
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    
    console.log(`📈 Starting Jupiter price feed for ${this.tokens.length} tokens...`);
    
    // In a real implementation, we would use a WebSocket if Jupiter provides one for prices,
    // or we poll their /price API efficiently. For this demo, we'll poll every few seconds.
    this.intervalId = setInterval(() => this.pollPrices(), 2000);
    
    // Initial fetch
    await this.pollPrices();
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('🛑 Jupiter price feed stopped.');
  }

  private async pollPrices(): Promise<void> {
    if (this.tokens.length === 0) return;
    
    try {
      // Mocking Jupiter API call
      // Real API: `https://price.jup.ag/v4/price?ids=${this.tokens.join(',')}`
      
      const timestamp = Date.now();
      
      for (const token of this.tokens) {
        // Generate a random walk price for simulation purposes
        const mockPrice = 100 + (Math.random() * 10 - 5);
        
        const tick: PriceTick = {
          token,
          price: mockPrice,
          timestamp,
          source: 'jupiter'
        };
        
        this.bus.emit('price:update', tick);
      }
    } catch (error) {
      console.error('❌ Failed to poll Jupiter prices:', error);
    }
  }
}
