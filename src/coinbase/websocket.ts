import WebSocket from 'ws';

export interface OFIMetrics {
    bidVolumeUsd: number;
    askVolumeUsd: number;
    imbalance: number; // -1.0 to 1.0 (positive = buyer dominance)
    price: number;
}

const ofiState: Record<string, OFIMetrics> = {};
let ws: WebSocket | null = null;

export function getLiveMetrics(productId: string): OFIMetrics | null {
    return ofiState[productId] || null;
}

export function connectWebsocket(products: string[]) {
    ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');
    
    ws!.on('open', () => {
        console.log('📡 [Coinbase WS] Connected. Subscribing to L2 Orderbook and Tickers...');
        ws!.send(JSON.stringify({
            type: 'subscribe',
            product_ids: products,
            channel: 'level2'
        }));
        ws!.send(JSON.stringify({
            type: 'subscribe',
            product_ids: products,
            channel: 'ticker'
        }));
    });

    ws!.on('message', (data: Buffer) => {
        try {
            const msg = JSON.parse(data.toString());
            
            if (msg.channel === 'ticker' && msg.events) {
                for (const event of msg.events) {
                    for (const ticker of event.tickers) {
                        const pid = ticker.product_id;
                        if (!ofiState[pid]) {
                            ofiState[pid] = { bidVolumeUsd: 0, askVolumeUsd: 0, imbalance: 0, price: 0 };
                        }
                        ofiState[pid].price = parseFloat(ticker.price);
                    }
                }
            }

            if (msg.channel === 'l2_data' && msg.events) {
                for (const event of msg.events) {
                    const pid = event.product_id;
                    if (!ofiState[pid]) {
                        ofiState[pid] = { bidVolumeUsd: 0, askVolumeUsd: 0, imbalance: 0, price: 0 };
                    }
                    
                    let bidVol = 0;
                    let askVol = 0;

                    if (event.updates) {
                        for (const update of event.updates) {
                            const price = parseFloat(update.price_level);
                            const newSize = parseFloat(update.new_quantity);
                            // Convert to USD volume for apples-to-apples
                            const usdVolume = newSize * price;
                            
                            if (update.side === 'bid') {
                                bidVol += usdVolume;
                            } else {
                                askVol += usdVolume;
                            }
                        }
                    }
                    
                    // Exponential smoothing for the order flow
                    ofiState[pid].bidVolumeUsd = (ofiState[pid].bidVolumeUsd * 0.8) + (bidVol * 0.2);
                    ofiState[pid].askVolumeUsd = (ofiState[pid].askVolumeUsd * 0.8) + (askVol * 0.2);
                    
                    const totalVol = ofiState[pid].bidVolumeUsd + ofiState[pid].askVolumeUsd;
                    if (totalVol > 0) {
                        ofiState[pid].imbalance = (ofiState[pid].bidVolumeUsd - ofiState[pid].askVolumeUsd) / totalVol;
                    }
                }
            }
        } catch (err) {}
    });

    ws!.on('close', () => {
        console.log('📡 [Coinbase WS] Disconnected. Reconnecting in 5s...');
        setTimeout(() => connectWebsocket(products), 5000);
    });

    ws!.on('error', (err) => {
        console.error('📡 [Coinbase WS] Error:', err.message);
    });
}
