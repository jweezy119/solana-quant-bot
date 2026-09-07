import fs from 'fs';
import path from 'path';
import { coinbaseFetch, getProduct, getTicker } from '../coinbase/client';
import { playTransactionSound } from '../coinbase/sound';

export interface CoinbaseListingAlert {
  productId: string;
  baseCurrency: string;
  quoteCurrency: string;
  status: string;
  isNewListing: boolean;
  timestamp: number;
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const KNOWN_PRODUCTS_FILE = path.join(DATA_DIR, 'known-coinbase-products.json');

let knownProductIds = new Set<string>();
let isInitialized = false;
const recentListings: CoinbaseListingAlert[] = [];

function loadKnownProducts(): Set<string> {
  try {
    if (fs.existsSync(KNOWN_PRODUCTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(KNOWN_PRODUCTS_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        return new Set(data);
      }
    }
  } catch {}
  return new Set();
}

function saveKnownProducts(ids: Set<string>) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(KNOWN_PRODUCTS_FILE, JSON.stringify(Array.from(ids), null, 2), 'utf-8');
  } catch {}
}

/**
 * Scan Coinbase product catalog for new additions or status changes
 */
export async function checkCoinbaseNewListings(): Promise<CoinbaseListingAlert[]> {
  try {
    const data = (await coinbaseFetch('GET', '/api/v3/brokerage/products?limit=500')) as any;
    const products: any[] = data.products || [];

    const newAlerts: CoinbaseListingAlert[] = [];
    const currentProductMap = new Map<string, any>();

    for (const p of products) {
      currentProductMap.set(p.product_id, p);
    }

    // Initialize from disk or initial scan
    if (!isInitialized) {
      knownProductIds = loadKnownProducts();
      if (knownProductIds.size === 0) {
        for (const p of products) {
          knownProductIds.add(p.product_id);
        }
        saveKnownProducts(knownProductIds);
        isInitialized = true;
        return [];
      }
      isInitialized = true;
    }

    // Detect new additions not in known catalog
    let hasNew = false;
    for (const [id, prod] of currentProductMap.entries()) {
      if (!knownProductIds.has(id)) {
        knownProductIds.add(id);
        hasNew = true;

        const alert: CoinbaseListingAlert = {
          productId: id,
          baseCurrency: prod.base_currency_id,
          quoteCurrency: prod.quote_currency_id,
          status: prod.status,
          isNewListing: true,
          timestamp: Date.now(),
        };

        recentListings.unshift(alert);
        newAlerts.push(alert);

        console.log(`\n🚀🚀🚀 [NEW COINBASE LISTING DETECTED] 🚀🚀🚀`);
        console.log(`   Pair: ${id} │ Status: ${prod.status} │ Base: ${prod.base_currency_id}`);
        console.log(`   Listing Momentum Sniper queued for: ${id}`);

        // Sound alert for new listing
        playTransactionSound('win');
      }
    }

    if (hasNew) {
      saveKnownProducts(knownProductIds);
    }

    return newAlerts;
  } catch (err: any) {
    return [];
  }
}

/**
 * Check if a newly listed product is safe to trade (online status and reasonable spread)
 */
export async function evaluateListingMomentum(productId: string): Promise<{
  safe: boolean;
  reason: string;
  bestBid: number;
  bestAsk: number;
  spreadPct: number;
  notional24hUsd: number;
}> {
  try {
    const product = (await getProduct(productId)) as any;
    if (!product || product.status !== 'online') {
      return { safe: false, reason: `Product status is ${product?.status || 'unknown'} (not online)`, bestBid: 0, bestAsk: 0, spreadPct: 0, notional24hUsd: 0 };
    }

    if (product.trading_disabled || product.cancel_only) {
      return { safe: false, reason: 'Trading is disabled or cancel_only', bestBid: 0, bestAsk: 0, spreadPct: 0, notional24hUsd: 0 };
    }

    const ticker = (await getTicker(productId)) as any;
    const bestBid = parseFloat(ticker.best_bid || '0');
    const bestAsk = parseFloat(ticker.best_ask || '0');

    if (bestBid <= 0 || bestAsk <= 0) {
      return { safe: false, reason: 'Order book is empty (no bid or ask)', bestBid, bestAsk, spreadPct: 0, notional24hUsd: 0 };
    }

    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
    // Brand-new listings must be genuinely liquid, not just "online":
    // tight spread AND meaningful 24h volume (else the arb band is always phantom).
    const volume24h = parseFloat(ticker.volume_24h || '0');
    const price = parseFloat(ticker.price || ticker.last_price || bestBid);
    const notional24hUsd = price > 0 ? volume24h * price : volume24h;

    if (spreadPct > 1.00) {
      return {
        safe: false,
        reason: `Spread too wide (${spreadPct.toFixed(2)}% > 1.0% max for new listings)`,
        bestBid,
        bestAsk,
        spreadPct,
        notional24hUsd,
      };
    }

    if (notional24hUsd < 1_000_000) {
      return {
        safe: false,
        reason: notional24hUsd <= 0
          ? `No measurable 24h volume — cannot verify liquidity, skipping`
          : `24h notional $${notional24hUsd.toFixed(0)} < $1M min — phantom-liquidity cap, skipping`,
        bestBid,
        bestAsk,
        spreadPct,
        notional24hUsd,
      };
    }

    return { safe: true, reason: 'Listing is online, tight spread, and liquid (real arb possible)', bestBid, bestAsk, spreadPct, notional24hUsd };
  } catch (err: any) {
    return { safe: false, reason: err.message, bestBid: 0, bestAsk: 0, spreadPct: 0, notional24hUsd: 0 };
  }
}

export function getRecentCoinbaseListings(): CoinbaseListingAlert[] {
  return recentListings.slice(0, 10);
}

export function getTotalMonitoredCoinbaseProducts(): number {
  return knownProductIds.size;
}
