import { getProducts } from './client';

/**
 * Fetches all available spot markets from Coinbase and returns
 * the top N most active USDC pairs by 24h trading volume.
 */
export async function fetchTopVolumeProducts(limit: number): Promise<string[]> {
    try {
        console.log(`\n🔍 [SCANNER] Polling global exchange data for top ${limit} USDC pairs by volume...`);
        // We fetch a large number of products to ensure we capture the whole market
        const res = await getProducts(500) as any;
        
        if (!res.products || res.products.length === 0) {
            console.error('   ⚠️ [SCANNER] Failed to parse products from Coinbase.');
            return [];
        }

        const STABLECOINS = ['USDT', 'USDC', 'DAI', 'PYUSD', 'EURC', 'EUROC', 'CGLD', 'WBTC'];
        
        // Filter for active USDC pairs
        const usdcPairs = res.products.filter((p: any) => 
            p.quote_currency_id === 'USDC' && 
            p.status === 'online' &&
            !p.product_id.includes('VENOM') && // filter out buggy pairs if needed
            !STABLECOINS.includes(p.base_currency_id)
        );

        // Calculate 24h USD volume and sort
        const sorted = usdcPairs.sort((a: any, b: any) => {
            const volA = parseFloat(a.volume_24h || '0') * parseFloat(a.price || '0');
            const volB = parseFloat(b.volume_24h || '0') * parseFloat(b.price || '0');
            return volB - volA; // descending
        });

        // Slice top N
        const topN = sorted.slice(0, limit);
        
        const productIds = topN.map((p: any) => p.product_id);
        
        console.log(`   🌐 [SCANNER] Discovered Top ${productIds.length} high-momentum assets.`);
        return productIds;
        
    } catch (err: any) {
        console.error(`   ⚠️ [SCANNER] Error fetching products: ${err.message}`);
        return [];
    }
}
