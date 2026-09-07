/**
 * Coinbase Smart Grid & Dynamic DCA Hybrid Bot
 * ────────────────────────────────────────────
 * 1. Scans for oversold conditions (Smart DCA).
 * 2. Deploys a Limit Order Net (Grid) to catch wicks.
 * 3. Farms volatility with micro-sells (+2%).
 * 4. Macro-flushes the entire bag if average cost is up +10%.
 */

import 'dotenv/config';
import { getTechnicalSignal } from './signals';
import { 
  getAccountBalance, getProduct, getTicker, 
  createLimitOrder, cancelOrders, getOrder 
} from './client';
import { formatSizeByIncrement } from './risk-manager';

const TARGET_PAIRS = (process.env.COINBASE_PRODUCTS || 'SOL-USDC,DOGE-USDC').split(',').map(p => p.trim());
const GRID_CHUNKS = 4;        // Deploy 4 buy orders per grid net
const CHUNK_SIZE_USD = 10.00; // $10 per order (perfect for $100 bankroll)
const GRID_SPACING_PCT = 0.015; // 1.5% spacing between limit buys
const MICRO_TAKE_PROFIT = 0.020; // 2.0% profit for each grid step
const MACRO_TAKE_PROFIT = 0.10;  // 10.0% profit for total bag flush

interface GridState {
  isActive: boolean;
  baseSymbol: string;
  avgEntryPrice: number;
  totalAccumulated: number;
  buyOrderIds: string[];
  sellOrderIds: string[];
}

// In-memory state tracking (in a production bot, this would save to a JSON file)
const activeGrids: Record<string, GridState> = {};

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function startSmartGrid() {
  console.clear();
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  🕸️  COINBASE SMART GRID & DCA HYBRID ENGINE');
  console.log(`  🎯 Targets: ${TARGET_PAIRS.join(', ')}`);
  console.log(`  💰 Strategy: $${CHUNK_SIZE_USD} chunks │ ${GRID_CHUNKS} Levels │ ${GRID_SPACING_PCT*100}% Spacing`);
  console.log(`  📈 Exits: Micro Grid (+${MICRO_TAKE_PROFIT*100}%) │ Macro Bag Flush (+${MACRO_TAKE_PROFIT*100}%)`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  while (true) {
    try {
      const usdcBalance = await getAccountBalance('USDC');
      
      for (const pair of TARGET_PAIRS) {
        const base = pair.split('-')[0];
        
        // 1. Fetch live technicals and price
        const tech = await getTechnicalSignal(pair);
        const ticker = await getTicker(pair) as any;
        const livePrice = parseFloat(ticker.trades?.[0]?.price || '0');
        const product = await getProduct(pair) as any;

        if (livePrice <= 0) continue;

        let grid = activeGrids[pair] || { isActive: false, baseSymbol: base, avgEntryPrice: 0, totalAccumulated: 0, buyOrderIds: [], sellOrderIds: [] };

        // ─── PHASE 1: SMART ENTRY (RSI Oversold) ───
        if (!grid.isActive) {
          if (tech.rsi <= 35) { // Deep discount
            console.log(`\n🚨 [SMART DCA] ${pair} RSI is ${tech.rsi.toFixed(1)} (OVERSOLD). Deploying Grid Net...`);
            
            if (usdcBalance < (GRID_CHUNKS * CHUNK_SIZE_USD)) {
              console.log(`   ⚠️ Insufficient USDC to deploy full grid ($${GRID_CHUNKS * CHUNK_SIZE_USD} required). Skipping.`);
              continue;
            }

            // Deploy Buy Grid
            for (let i = 0; i < GRID_CHUNKS; i++) {
              const buyPrice = livePrice * (1 - (i * GRID_SPACING_PCT));
              const buyPriceStr = formatSizeByIncrement(buyPrice, product.quote_increment);
              const buyQty = CHUNK_SIZE_USD / buyPrice;
              const buyQtyStr = formatSizeByIncrement(buyQty, product.base_increment);

              try {
                const order = await createLimitOrder(pair, 'BUY', buyQtyStr, buyPriceStr, true) as any;
                const oid = order.order_id || order.success_response?.order_id;
                if (oid) grid.buyOrderIds.push(oid);
                console.log(`   🕸️ Placed LIMIT BUY at $${buyPriceStr} for ${buyQtyStr} ${base}`);
              } catch (err: any) {
                console.log(`   ❌ Failed to place grid limit: ${err.message}`);
              }
              await sleep(300);
            }
            grid.isActive = true;
            activeGrids[pair] = grid;
          } else {
            process.stdout.write(`\r🔎 [SCANNING] ${pair}: RSI=${tech.rsi.toFixed(1)} (Waiting for < 35 discount) │ Price: $${livePrice.toFixed(4)}    `);
          }
        } 
        
        // ─── PHASE 2 & 3: GRID MANAGEMENT & MICRO-SELLING ───
        else if (grid.isActive) {
          // Check status of buy orders
          const activeBuys = [];
          for (const oid of grid.buyOrderIds) {
            try {
              const check = await getOrder(oid);
              if (check.order?.status === 'FILLED') {
                const filledQtyStr = check.order.filled_size;
                const filledPriceStr = check.order.average_filled_price;
                const filledQty = parseFloat(filledQtyStr);
                const filledPrice = parseFloat(filledPriceStr);
                
                // Update Macro Bag Average Cost
                const totalCost = (grid.avgEntryPrice * grid.totalAccumulated) + (filledPrice * filledQty);
                grid.totalAccumulated += filledQty;
                grid.avgEntryPrice = totalCost / grid.totalAccumulated;
                
                console.log(`\n✅ [GRID FILLED] Bought ${filledQtyStr} ${base} @ $${filledPriceStr}!`);
                
                // Instantly deploy Micro-Sell
                const sellPrice = filledPrice * (1 + MICRO_TAKE_PROFIT);
                const sellPriceStr = formatSizeByIncrement(sellPrice, product.quote_increment);
                
                try {
                  const sellOrder = await createLimitOrder(pair, 'SELL', filledQtyStr, sellPriceStr, true) as any;
                  const soid = sellOrder.order_id || sellOrder.success_response?.order_id;
                  if (soid) grid.sellOrderIds.push(soid);
                  console.log(`   🎯 Placed MICRO-SELL at $${sellPriceStr} (+${MICRO_TAKE_PROFIT*100}%)`);
                } catch (e: any) {
                  console.log(`   ❌ Failed to place micro-sell: ${e.message}`);
                }
              } else if (check.order?.status === 'OPEN') {
                activeBuys.push(oid);
              }
            } catch (e) {}
            await sleep(300);
          }
          grid.buyOrderIds = activeBuys;

          // Check status of micro-sell orders
          const activeSells = [];
          let soldQty = 0;
          for (const oid of grid.sellOrderIds) {
            try {
              const check = await getOrder(oid);
              if (check.order?.status === 'FILLED') {
                console.log(`\n💰 [MICRO-PROFIT SECURED] Sold chunk at +${MICRO_TAKE_PROFIT*100}%!`);
                soldQty += parseFloat(check.order.filled_size);
              } else if (check.order?.status === 'OPEN') {
                activeSells.push(oid);
              }
            } catch (e) {}
            await sleep(300);
          }
          grid.sellOrderIds = activeSells;
          grid.totalAccumulated -= soldQty; // reduce bag size

          // ─── PHASE 4: MACRO BAG FLUSH ───
          if (grid.totalAccumulated > 0 && grid.avgEntryPrice > 0) {
            const macroGainPct = (livePrice - grid.avgEntryPrice) / grid.avgEntryPrice;
            process.stdout.write(`\r💼 [BAG HELD] ${pair}: ${grid.totalAccumulated.toFixed(2)} ${base} │ Avg Cost: $${grid.avgEntryPrice.toFixed(4)} │ Macro PnL: ${(macroGainPct*100).toFixed(2)}%    `);
            
            if (macroGainPct >= MACRO_TAKE_PROFIT) {
              console.log(`\n🚀 [MACRO FLUSH] Bag is up +${(macroGainPct*100).toFixed(2)}%! Cancelling grids and selling entire bag!`);
              await cancelOrders([...grid.buyOrderIds, ...grid.sellOrderIds]);
              
              const sellQtyStr = formatSizeByIncrement(grid.totalAccumulated, product.base_increment);
              const limitPriceStr = formatSizeByIncrement(livePrice * 0.998, product.quote_increment); // guarantee fill
              
              try {
                await createLimitOrder(pair, 'SELL', sellQtyStr, limitPriceStr, true);
                console.log(`   ✅ Successfully flushed bag. Strategy reset.`);
                grid = { isActive: false, baseSymbol: base, avgEntryPrice: 0, totalAccumulated: 0, buyOrderIds: [], sellOrderIds: [] };
              } catch (e: any) {
                console.log(`   ❌ Failed to flush bag: ${e.message}`);
              }
            }
          } else if (grid.buyOrderIds.length === 0 && grid.sellOrderIds.length === 0) {
            // Grid completely empty, reset
            grid.isActive = false;
          }
          
          activeGrids[pair] = grid;
        }
      }
    } catch (e: any) {
      // suppress verbose errors to keep console clean
    }
    
    await sleep(5000); // 5 second loop
  }
}

startSmartGrid();
