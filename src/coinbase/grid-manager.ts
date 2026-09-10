import fs from 'fs';
import path from 'path';
import { createLimitOrder, getOrder, cancelOrder, getProduct, createMarketOrder } from './client';
import { isSimulationMode, QUANT_CONFIG, formatSizeByIncrement } from './risk-manager';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const GRID_FILE = path.join(DATA_DIR, 'grid-positions.json');

export interface GridOrder {
    productId: string;
    stage: 'BUYING' | 'SELLING';
    orderId: string;
    price: number;
    sizeUsd: number;
    baseQty: number;
    entryTime: number;
    simulated: boolean;
}

export function loadGrid(): Record<string, GridOrder> {
    if (!fs.existsSync(GRID_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(GRID_FILE, 'utf-8'));
    } catch {
        return {};
    }
}

export function saveGrid(grid: Record<string, GridOrder>) {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(GRID_FILE, JSON.stringify(grid, null, 2), 'utf-8');
}

const GRID_SPREAD_PCT = 0.015; // 1.5% distance for Grid Buy/Sell limit orders
const GRID_TRADE_USD = QUANT_CONFIG.minTradeUsd;

/**
 * Grid Manager tick loop
 * Manages sideways limit orders asynchronously from the main directional sniper.
 */
export async function updateGrid(productId: string, currentPrice: number, atrPct: number, availableCashUsd: number, hasSniperPosition: boolean) {
    const isSim = isSimulationMode();
    const grid = loadGrid();
    const order = grid[productId];

    // Dynamic Capital Allocation: 
    // Grid only operates if the asset has low volatility (ATR < 4%) and the sniper bot isn't trading it.
    if (!order && (atrPct > 0.04 || hasSniperPosition)) {
        return; 
    }

    // 1. Place Initial Grid Buy
    if (!order) {
        if (availableCashUsd < GRID_TRADE_USD + QUANT_CONFIG.minCashReserveUsd) return;

        const limitPrice = currentPrice * (1 - GRID_SPREAD_PCT);
        let orderId = `grid-sim-${Date.now()}`;
        
        if (!isSim) {
            try {
                const res = await getProduct(productId) as any;
                const limitPriceStr = formatSizeByIncrement(limitPrice, res.quote_increment || '0.0001');
                const qtyStr = formatSizeByIncrement(GRID_TRADE_USD / limitPrice, res.base_increment || '0.0001');
                
                const cbOrder = await createLimitOrder(productId, 'BUY', qtyStr, limitPriceStr, true) as any;
                orderId = cbOrder.order_id || cbOrder.success_response?.order_id;
                console.log(`   🕸️ [GRID MAKER] Placed Limit BUY for ${productId} at $${limitPriceStr} (ATR: ${(atrPct*100).toFixed(1)}%)`);
            } catch (err: any) {
                // If it fails (e.g. min size issues), ignore silently to avoid log spam
                return;
            }
        } else {
            console.log(`   🕸️ [GRID MAKER] Placed Limit BUY for ${productId} at $${limitPrice.toFixed(4)} (ATR: ${(atrPct*100).toFixed(1)}%) [SIM]`);
        }

        grid[productId] = {
            productId,
            stage: 'BUYING',
            orderId,
            price: limitPrice,
            sizeUsd: GRID_TRADE_USD,
            baseQty: GRID_TRADE_USD / limitPrice,
            entryTime: Date.now(),
            simulated: isSim
        };
        saveGrid(grid);
        return;
    }

    // 2. Evaluate Order Status
    if (order.stage === 'BUYING') {
        let filled = isSim && (currentPrice <= order.price);
        if (!isSim) {
            try {
                const cbOrder = await getOrder(order.orderId) as any;
                if (cbOrder.order?.status === 'FILLED') filled = true;
                else if (cbOrder.order?.status === 'CANCELLED') {
                    delete grid[productId];
                    saveGrid(grid);
                    return;
                }
            } catch {}
        }

        if (filled) {
            console.log(`   🕸️ [GRID MAKER] BUY Filled! Placing Limit SELL for ${productId}...`);
            const sellPrice = order.price * (1 + GRID_SPREAD_PCT * 1.5); // Sell higher to clear maker fees and bag profit
            let sellOrderId = `grid-sim-sell-${Date.now()}`;

            if (!isSim) {
                try {
                    const res = await getProduct(productId) as any;
                    const limitPriceStr = formatSizeByIncrement(sellPrice, res.quote_increment || '0.0001');
                    const qtyStr = formatSizeByIncrement(order.baseQty, res.base_increment || '0.0001');
                    
                    const cbOrder = await createLimitOrder(productId, 'SELL', qtyStr, limitPriceStr, true) as any;
                    sellOrderId = cbOrder.order_id || cbOrder.success_response?.order_id;
                } catch (err: any) {
                    console.error(`   ⚠️ [GRID MAKER] Failed to place sell: ${err.message}`);
                    return; // Wait till next loop to retry
                }
            }
            
            order.stage = 'SELLING';
            order.orderId = sellOrderId;
            order.price = sellPrice;
            saveGrid(grid);
        }
    } else if (order.stage === 'SELLING') {
        const entryPrice = order.sizeUsd / order.baseQty;
        // FLASH CRASH PROTECTION
        if (currentPrice <= entryPrice * (1 - QUANT_CONFIG.stopLossPct)) {
            console.log(`   🚨 [GRID MAKER] Flash Crash Stop-Loss Hit for ${productId}! Cutting grid bag at -${(QUANT_CONFIG.stopLossPct*100).toFixed(1)}%`);
            if (!isSim) {
                try {
                    await cancelOrder(order.orderId);
                    const res = await getProduct(productId) as any;
                    const qtyStr = formatSizeByIncrement(order.baseQty, res.base_increment || '0.0001');
                    await createMarketOrder(productId, 'SELL', qtyStr);
                } catch (err: any) {
                    console.error(`   ⚠️ [GRID MAKER] Failed to market sell grid bag: ${err.message}`);
                }
            }
            delete grid[productId];
            saveGrid(grid);
            return;
        }

        let filled = isSim && (currentPrice >= order.price);
        if (!isSim) {
            try {
                const cbOrder = await getOrder(order.orderId) as any;
                if (cbOrder.order?.status === 'FILLED') filled = true;
                else if (cbOrder.order?.status === 'CANCELLED') {
                    // Manual intervention occurred or order aged out. 
                    delete grid[productId];
                    saveGrid(grid);
                    return;
                }
            } catch {}
        }

        if (filled) {
            const profit = order.sizeUsd * (GRID_SPREAD_PCT * 1.5);
            console.log(`   💸 [GRID MAKER] SELL Filled! Harvested ~$${profit.toFixed(2)} sideways profit on ${productId}`);
            delete grid[productId];
            saveGrid(grid);
        }
    }
}
