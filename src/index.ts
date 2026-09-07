/**
 * Solana Quant Bot v3 — Bootstrap
 * ────────────────────────────────
 * Entry point. Wires everything and starts the engine.
 */

import { startEngine } from './core/engine';
import { dataBus } from './data/data-bus';
import { JupiterPriceFeed } from './data/jupiter-feed';
import { HeliusWebsocket } from './data/helius-ws';

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑  Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑  SIGTERM received, shutting down...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('💥  Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥  Unhandled rejection:', reason);
});

// Start
async function bootstrap() {
  console.log('🚀 Starting Solana Quant Bot v3 initialization...');
  
  // Initialize Data Layer
  const jupiterFeed = new JupiterPriceFeed(dataBus);
  const heliusWs = new HeliusWebsocket(dataBus);
  
  await jupiterFeed.start();
  await heliusWs.connect();
  
  // Initialize Engine
  await startEngine();
}

bootstrap().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
