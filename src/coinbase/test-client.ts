import 'dotenv/config';
import { getProduct, getTicker, getCandles } from './client';

async function testMarketData() {
    try {
        console.log("📈 Fetching Bitcoin Product Info...");
        const btc = (await getProduct('BTC-USD')) as any;
        console.log(`Product: ${btc.product_id}, Status: ${btc.status}`);

        console.log("\n📊 Fetching Live Ticker...");
        const ticker = (await getTicker('BTC-USD')) as any;
        console.log(`Price: $${ticker.trades[0].price} | Volume: ${ticker.trades[0].size}`);
        
        console.log("\n🕯️ Fetching Daily Candles (Last 3 days)...");
        const end = Math.floor(Date.now() / 1000);
        const start = end - (3 * 24 * 60 * 60);
        const candles = (await getCandles('BTC-USD', start, end, 'ONE_DAY')) as any;
        console.log(`Retrieved ${candles.candles?.length} candles.`);
        if (candles.candles) {
            candles.candles.forEach((c: any) => {
                const date = new Date(parseInt(c.start) * 1000).toISOString().split('T')[0];
                console.log(`  - ${date}: O:${c.open} H:${c.high} L:${c.low} C:${c.close}`);
            });
        }
    } catch (e: any) {
        console.error("Error:", e.message);
    }
}

if (require.main === module) {
    testMarketData();
}
