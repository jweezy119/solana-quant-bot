const WebSocket = require('ws');
const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');
ws.on('open', () => {
    ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-USDC'],
        channel: 'ticker'
    }));
});
ws.on('message', (data) => {
    console.log(data.toString());
    process.exit(0);
});
ws.on('error', (err) => console.log(err));
