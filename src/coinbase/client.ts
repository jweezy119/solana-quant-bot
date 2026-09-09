import 'dotenv/config';
import { generateToken } from './auth';

const API_BASE = 'https://api.coinbase.com';
const API_NAME = process.env.COINBASE_API_NAME || '';
const API_SECRET = (process.env.COINBASE_API_PRIVATE_KEY || '').replace(/\\n/g, '\n');

export async function coinbaseFetch(method: string, path: string, body?: any, retries = 2): Promise<any> {
    if (!API_NAME || !API_SECRET) throw new Error('Missing Coinbase API credentials');
    
    const token = await generateToken(API_NAME, API_SECRET, method, path);
    const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };

    const options: RequestInit = { method, headers };
    if (body) {
        options.body = JSON.stringify(body);
    }

    try {
        const res = await fetch(`${API_BASE}${path}`, options);
        if (!res.ok) {
            if (res.status === 429 && retries > 0) {
                await new Promise(r => setTimeout(r, 1000));
                return coinbaseFetch(method, path, body, retries - 1);
            }
            const err = await res.text();
            throw new Error(`Coinbase API Error (${res.status}): ${err}`);
        }
        return await res.json();
    } catch (e: any) {
        if (retries > 0 && (e.message.includes('fetch failed') || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT')) {
            await new Promise(r => setTimeout(r, 1000));
            return coinbaseFetch(method, path, body, retries - 1);
        }
        throw e;
    }
}

/**
 * Get all accounts / balances
 */
export async function getAccounts(limit: number = 250) {
    return coinbaseFetch('GET', `/api/v3/brokerage/accounts?limit=${limit}`);
}

/**
 * Get available balance for a specific currency (e.g. 'USD', 'USDC', 'BTC')
 */
/**
 * Get all accounts (wallets) with balances
 */
export async function getAllAccounts(): Promise<any[]> {
    let hasNext = true;
    let cursor = '';
    const allAccounts: any[] = [];
    
    while (hasNext) {
        const data = await coinbaseFetch('GET', `/api/v3/brokerage/accounts?limit=250${cursor ? '&cursor=' + cursor : ''}`) as any;
        if (data.accounts) {
            allAccounts.push(...data.accounts);
        }
        cursor = data.cursor;
        hasNext = !!cursor;
    }
    return allAccounts;
}

export async function getAccountBalance(currency: string, includeHolds: boolean = false): Promise<number> {
    try {
        let hasNext = true;
        let cursor = '';
        while (hasNext) {
            const data = await coinbaseFetch('GET', `/api/v3/brokerage/accounts?limit=250${cursor ? '&cursor=' + cursor : ''}`) as any;
            const account = data.accounts?.find((a: any) => a.currency === currency);
            if (account) {
                let balance = parseFloat(account.available_balance?.value || '0');
                if (includeHolds && account.hold?.value) {
                    balance += parseFloat(account.hold.value);
                }
                return balance;
            }
            hasNext = !!data.has_next && !!data.cursor;
            cursor = data.cursor || '';
        }
        return 0;
    } catch (e: any) {
        return 0;
    }
}

/**
 * Get all available products (markets)
 */
export async function getProducts(limit: number = 100) {
    return coinbaseFetch('GET', `/api/v3/brokerage/products?limit=${limit}&product_type=SPOT`);
}

/**
 * Get product details (e.g., "BTC-USD")
 */
export async function getProduct(productId: string) {
    return coinbaseFetch('GET', `/api/v3/brokerage/products/${productId}`);
}

/**
 * Get live ticker price for a product
 */
export async function getTicker(productId: string) {
    return coinbaseFetch('GET', `/api/v3/brokerage/products/${productId}/ticker`);
}

/**
 * Get historical candles (OHLCV)
 * Granularity options: ONE_MINUTE, FIVE_MINUTE, FIFTEEN_MINUTE, THIRTY_MINUTE, ONE_HOUR, TWO_HOUR, SIX_HOUR, ONE_DAY
 */
export async function getCandles(productId: string, start: number, end: number, granularity: string = 'ONE_DAY') {
    return coinbaseFetch('GET', `/api/v3/brokerage/products/${productId}/candles?start=${start}&end=${end}&granularity=${granularity}`);
}

/**
 * Execute a market order (buy or sell)
 */
export async function createMarketOrder(productId: string, side: 'BUY' | 'SELL', amount: string) {
    const clientOrderId = crypto.randomUUID();
    const body = {
        client_order_id: clientOrderId,
        product_id: productId,
        side,
        order_configuration: {
            market_market_ioc: side === 'BUY' 
                ? { quote_size: amount } // Buy $X worth of quote currency
                : { base_size: amount }  // Sell X amount of base token
        }
    };
    const res = (await coinbaseFetch('POST', `/api/v3/brokerage/orders`, body)) as any;
    if (res.success === false) {
        const errorMsg = res.error_response?.message || res.failure_reason || res.error_response?.error || 'Coinbase rejected order';
        throw new Error(`Coinbase Order Rejected (${side} ${productId}): ${errorMsg}`);
    }
    return res;
}

/**
 * Execute a limit order (defaults to post_only = true for Maker fee status)
 */
export async function createLimitOrder(
    productId: string, 
    side: 'BUY' | 'SELL', 
    baseSize: string, 
    limitPrice: string,
    postOnly: boolean = true
) {
    const clientOrderId = crypto.randomUUID();
    const body = {
        client_order_id: clientOrderId,
        product_id: productId,
        side,
        order_configuration: {
            limit_limit_gtc: {
                base_size: baseSize,
                limit_price: limitPrice,
                post_only: postOnly
            }
        }
    };
    const res = (await coinbaseFetch('POST', `/api/v3/brokerage/orders`, body)) as any;
    if (res.success === false) {
        const errorMsg = res.error_response?.message || res.failure_reason || res.error_response?.error || 'Coinbase rejected limit order';
        throw new Error(`Coinbase Limit Order Rejected (${side} ${productId}): ${errorMsg}`);
    }
    return res;
}

/**
 * Get historical or active order by order ID
 */
export async function getOrder(orderId: string): Promise<any> {
    return coinbaseFetch('GET', `/api/v3/brokerage/orders/historical/${orderId}`);
}

/**
 * Cancel one or more orders by order ID
 */
export async function cancelOrders(orderIds: string[]): Promise<any> {
    if (!orderIds || orderIds.length === 0) return { results: [] };
    return coinbaseFetch('POST', `/api/v3/brokerage/orders/batch_cancel`, { order_ids: orderIds });
}

export async function cancelOrder(orderId: string): Promise<any> {
    return cancelOrders([orderId]);
}

/**
 * Get fills for a specific order to inspect fees and fill price
 */
export async function getOrderFills(orderId: string): Promise<any> {
    return coinbaseFetch('GET', `/api/v3/brokerage/orders/historical/fills?order_id=${orderId}`);
}

/**
 * Fetch active fee tiers for maker / taker
 */
export async function getFeeTier(): Promise<{ maker: number; taker: number }> {
    try {
        const res = (await coinbaseFetch('GET', `/api/v3/brokerage/transaction_summary`)) as any;
        const maker = parseFloat(res.fee_tier?.maker_fee_rate || '0.006');
        const taker = parseFloat(res.fee_tier?.taker_fee_rate || '0.012');
        return { maker, taker };
    } catch {
        return { maker: 0.006, taker: 0.012 };
    }
}
