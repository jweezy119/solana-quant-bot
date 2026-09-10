import { getAllAccounts, getTicker } from './client';
import { loadPositions, savePositions, isSimulationMode, QUANT_CONFIG } from './risk-manager';

export async function syncWalletToPositions(): Promise<{ importedProducts: string[], usdcAvailable: number, usdcHold: number }> {
    const isSim = isSimulationMode();
    let accounts: any[] = [];
    
    try {
        accounts = await getAllAccounts();
    } catch (e: any) {
        console.error('  ⚠️ [WALLET SYNC] Failed to fetch accounts:', e.message);
        return { importedProducts: [], usdcAvailable: 0, usdcHold: 0 };
    }

    const positions = loadPositions();
    const importedProducts: string[] = [];
    
    let usdcAvailable = 0;
    let usdcHold = 0;

    for (const account of accounts) {
        const currency = account.currency;
        const available = parseFloat(account.available_balance?.value || '0');
        const hold = parseFloat(account.hold?.value || '0');
        const total = available + hold;

        if (currency === 'USDC') {
            usdcAvailable = available;
            usdcHold = hold;
            continue;
        }
        
        if (currency === 'USD') continue; // Ignore fiat

        // Found an altcoin balance > 0
        if (total > 0 && !isSim) {
            const productId = `${currency}-USDC`;
            
            // Check if it's already managed by the bot
            if (!positions[productId]) {
                try {
                    // Estimate entry price using current market price
                    const ticker = await getTicker(productId) as any;
                    let currentPriceStr = ticker.price;
                    if (!currentPriceStr && ticker.trades && ticker.trades.length > 0) {
                        currentPriceStr = ticker.trades[0].price;
                    }
                    if (!currentPriceStr) {
                        currentPriceStr = ticker.best_ask || ticker.best_bid;
                    }
                    const currentPrice = parseFloat(currentPriceStr || '0');
                    
                    if (currentPrice > 0) {
                        const sizeUsd = total * currentPrice;
                        
                        // Ignore dust (< $2.00)
                        if (sizeUsd < 2.0) continue;

                        console.log(`\n💼 [WALLET SYNC] Found undocumented manual bag of ${currency}: ${total.toFixed(4)} (~$${sizeUsd.toFixed(2)})`);
                        console.log(`   ↳ Importing into AI Portfolio for active management (TP/SL).`);
                        
                        // Construct synthetic position using global env settings
                        const stopLossPct = QUANT_CONFIG.stopLossPct || 0.08;
                        const takeProfitPct = QUANT_CONFIG.takeProfitPct || 0.15;

                        positions[productId] = {
                            productId,
                            baseCurrency: currency,
                            entryPrice: currentPrice,
                            sizeUsd: sizeUsd,
                            quantity: total,
                            entryTime: Date.now(),
                            stopLossPrice: currentPrice * (1 - stopLossPct),
                            takeProfitPrice: currentPrice * (1 + takeProfitPct),
                            highestPriceSeen: currentPrice,
                            simulated: false,
                            orderId: 'manual-sync'
                        };
                        
                        importedProducts.push(productId);
                    }
                } catch (err: any) {
                    // console.error(`\\n❌ [WALLET SYNC DEBUG] Failed to get ticker for ${productId}: ${err.message}`);
                    // Ignored: Probably an asset not tradable against USDC (like a staked asset)
                }
            }
        }
    }

    if (importedProducts.length > 0) {
        savePositions(positions);
    }

    return { importedProducts, usdcAvailable, usdcHold };
}
