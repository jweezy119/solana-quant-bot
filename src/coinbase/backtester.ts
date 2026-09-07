import { coinbaseFetch } from './client';

// Types
interface CoinbaseCandle {
    start: string;
    low: string;
    high: string;
    open: string;
    close: string;
    volume: string;
}

interface BacktestResult {
    stopLossPct: number;
    takeProfitPct: number;
    rsiBuyThreshold: number;
    netPnl: number;
    winRate: number;
    maxDrawdown: number;
    trades: number;
}

async function fetchHistoricalData(productId: string, days: number): Promise<number[]> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - (days * 24 * 60 * 60);
    const GRANULARITY_SEC = 15 * 60;
    const MAX_CANDLES = 300; // Coinbase API limit per request
    const step = MAX_CANDLES * GRANULARITY_SEC;

    let allCandles: CoinbaseCandle[] = [];

    console.log(`Fetching ${days} days of data for ${productId}...`);
    for (let s = start; s < end; s += step) {
        const e = Math.min(s + step - 1, end);
        try {
            const data = await coinbaseFetch('GET', `/api/v3/brokerage/products/${productId}/candles?start=${s}&end=${e}&granularity=FIFTEEN_MINUTE`) as { candles: CoinbaseCandle[] };
            if (data.candles && data.candles.length > 0) {
                allCandles = allCandles.concat(data.candles);
            }
            await new Promise(r => setTimeout(r, 150)); // Rate limit buffer
        } catch (err) {
            console.error(`Error fetching chunk ${s} to ${e}:`, err);
        }
    }

    // Sort chronologically (oldest to newest)
    allCandles.sort((a, b) => parseInt(a.start) - parseInt(b.start));
    return allCandles.map(c => parseFloat(c.close));
}

function calculateRSI(prices: number[], period: number = 14): number[] {
    const rsi = new Array(prices.length).fill(0);
    if (prices.length < period + 1) return rsi;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    let rs = avgGain / (avgLoss === 0 ? 1e-10 : avgLoss);
    rsi[period] = 100 - (100 / (1 + rs));

    for (let i = period + 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        rs = avgGain / (avgLoss === 0 ? 1e-10 : avgLoss);
        rsi[i] = 100 - (100 / (1 + rs));
    }

    return rsi;
}

function runSimulation(
    prices: number[],
    rsi: number[],
    stopLossPct: number,
    takeProfitPct: number,
    rsiBuyThreshold: number
): BacktestResult {
    let position: { entryPrice: number; holdTime: number } | null = null;
    let wins = 0;
    let trades = 0;
    let peakCapital = 1000;
    let capital = 1000;
    let maxDrawdown = 0;

    for (let i = 14; i < prices.length; i++) {
        if (position) {
            position.holdTime++;
            const currentPrice = prices[i];
            const pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;

            // Exit conditions: Stop loss, Take profit, or Time decay (24h = 96 * 15m)
            if (pnlPct <= -stopLossPct || pnlPct >= takeProfitPct || position.holdTime >= 96) {
                // 0.6% maker fee on entry and exit
                const netTradeReturn = pnlPct - 0.006 - 0.006;
                capital = capital * (1 + netTradeReturn);
                trades++;
                if (netTradeReturn > 0) wins++;

                if (capital > peakCapital) peakCapital = capital;
                const drawdown = (peakCapital - capital) / peakCapital;
                if (drawdown > maxDrawdown) maxDrawdown = drawdown;

                position = null;
            }
        } else {
            // Entry condition
            if (rsi[i] < rsiBuyThreshold) {
                position = {
                    entryPrice: prices[i],
                    holdTime: 0
                };
            }
        }
    }

    return {
        stopLossPct,
        takeProfitPct,
        rsiBuyThreshold,
        netPnl: ((capital - 1000) / 1000) * 100,
        winRate: trades > 0 ? (wins / trades) * 100 : 0,
        maxDrawdown: maxDrawdown * 100,
        trades
    };
}

async function runGridSearch() {
    const products = ['BONK-USDC', 'BTC-USDC'];
    
    const stopLossParams = [0.015, 0.022, 0.030, 0.050];
    const takeProfitParams = [0.020, 0.038, 0.050, 0.080];
    const rsiParams = [25, 30, 35, 40];

    for (const product of products) {
        console.log(`\n======================================`);
        console.log(`Starting Backtest for ${product}`);
        console.log(`======================================`);
        
        const prices = await fetchHistoricalData(product, 30);
        if (prices.length === 0) {
            console.error(`No price data fetched for ${product}. Skipping.`);
            continue;
        }

        const rsi = calculateRSI(prices, 14);
        const results: BacktestResult[] = [];

        for (const sl of stopLossParams) {
            for (const tp of takeProfitParams) {
                for (const rsiThreshold of rsiParams) {
                    const res = runSimulation(prices, rsi, sl, tp, rsiThreshold);
                    results.push(res);
                }
            }
        }

        // Sort by Net PnL descending
        results.sort((a, b) => b.netPnl - a.netPnl);

        console.log(`\nTop 5 Results for ${product}:`);
        console.table(results.slice(0, 5).map(r => ({
            "RSI Buy": r.rsiBuyThreshold,
            "SL %": (r.stopLossPct * 100).toFixed(1) + "%",
            "TP %": (r.takeProfitPct * 100).toFixed(1) + "%",
            "Net PnL %": r.netPnl.toFixed(2) + "%",
            "Win %": r.winRate.toFixed(2) + "%",
            "Max DD %": r.maxDrawdown.toFixed(2) + "%",
            "Trades": r.trades
        })));
    }
}

// Run standalone
if (require.main === module) {
    runGridSearch().catch(console.error);
}
