import { getProducts, getTicker } from '../coinbase/client';

const STABLECOINS = ['USDT', 'USDC', 'DAI', 'PYUSD', 'EURC', 'CGLD', 'WBTC'];
const MAX_SPREAD_PCT = 0.20; // Quant rule: max 0.2% spread to prevent slippage

/**
 * Scans the entire Coinbase spot market for top volume USDC pairs.
 * Applies strict quant filters to reject illiquid or wide-spread (memecoin) traps.
 */
export async function scanTopVolumeAssets(limit: number = 7): Promise<string[]> {
    try {
        const res = await getProducts(300) as any;
        let products = res.products || [];
        
        // 1. Base Filter: USDC pairs, online, non-stablecoin
        products = products.filter((p: any) => 
            p.quote_currency_id === 'USDC' && 
            p.status === 'online' &&
            !STABLECOINS.includes(p.base_currency_id)
        );

        // 2. Sort by 24h Notional Volume (Base Volume * Current Price)
        products.sort((a: any, b: any) => {
            const volA = parseFloat(a.volume_24h || '0') * parseFloat(a.price || '0');
            const volB = parseFloat(b.volume_24h || '0') * parseFloat(b.price || '0');
            return volB - volA;
        });

        // 3. Take top candidates and apply the strict Spread-to-Fee filter
        const candidates = products.slice(0, 30);
        const validProducts: string[] = [];

        for (const p of candidates) {
            try {
                const ticker = await getTicker(p.product_id) as any;
                const ask = parseFloat(ticker.best_ask || '0');
                const bid = parseFloat(ticker.best_bid || '0');
                
                if (ask > 0 && bid > 0) {
                    const spreadPct = ((ask - bid) / bid) * 100;
                    if (spreadPct <= MAX_SPREAD_PCT) {
                        validProducts.push(p.product_id);
                    } else {
                        console.log(`   [Scanner] 🚫 Rejected ${p.product_id} due to wide spread: ${spreadPct.toFixed(2)}% > ${MAX_SPREAD_PCT}% (Illiquid Trap)`);
                    }
                }
                
                if (validProducts.length >= limit) break;
            } catch (err) {
                // Ignore individual ticker fetch errors and continue
            }
        }
        
        return validProducts;
    } catch (e: any) {
        console.error(`   [Scanner] ⚠️ Failed to scan top assets: ${e.message}`);
        return [];
    }
}
