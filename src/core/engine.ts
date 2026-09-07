/**
 * Solana Quant Bot v3 — Engine
 * ────────────────────────────
 * Event-driven main loop that orchestrates:
 *   Data → Signals → Fusion → Sizing → Execution → Journaling
 *
 * Replaces the old while(true) { poll } pattern.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

import {
  Signal, Position, MarketRegime, RegimeState,
  JournalEntry, PriceHistory, OrderFlowState,
} from './types';
import {
  TOKENS, PRIVATE_KEY_BASE58, IS_SIMULATION, FEATURES,
  TIMING, EXITS, STARTING_CAPITAL_USDC, REGIME_MULTIPLIERS, USDC_MINT, RISK,
} from './config';
import { dataBus } from '../data/data-bus';

// Signals
import { initHistory, updateHistory, generateEmaAtrSignal, getDynamicThresholds } from '../signals/ema-atr';
import { generateBollingerSignal, computeBollinger } from '../signals/bollinger';
import { generateVwapSignal } from '../signals/vwap';
import { generateOrderFlowSignal, initOrderFlow, updateOrderFlow, decayOrderFlow } from '../signals/order-flow';
import { classifyRegime, generateRegimeSignal } from '../signals/regime-detector';
import { generateCrossDexSignal } from '../signals/cross-dex';
import { initMLPredictor, generateMLSignal } from '../signals/ml-predictor';
import { generateWhaleSignal, recordWhaleEvent } from '../signals/whale-monitor';
import { initVpin, updateVpin, generateVpinSignal, VpinState } from '../signals/vpin-toxicity';
import { generateDtwSignal } from '../signals/dtw-pattern';

// Strategy
import { fuseSignals } from '../strategy/signal-fusion';
import { calculatePositionSize, SizingResult } from '../strategy/kelly-sizer';
import { checkRisk, updatePortfolio, recordTradeResult, deductCash, addCash, getPortfolioState, savePortfolioState, loadPortfolioState } from '../strategy/risk-manager';
import { checkPortfolioVariance } from '../strategy/portfolio-manager';

// Execution
import { getPrice, buyToken, sellToken } from '../execution/jupiter-client';
import { createConnection, withRetry, sleep, isCircuitOpen } from '../execution/tx-engine';

// Persistence
import { loadPositions, savePositions, getPosition, setPosition, deletePosition, getAllPositions, getPositionCount } from '../persistence/position-store';
import { loadJournal, recordTrade, getJournal, getHistoricalWinRate, getHistoricalWinLossRatio } from '../persistence/trade-journal';
import { computeMetrics, formatMetrics } from '../persistence/metrics';

// ============================================================
//  STATE
// ============================================================
const priceHistories: Record<string, PriceHistory> = {};
const orderFlows: Record<string, OrderFlowState> = {};
const vpinStates: Record<string, VpinState> = {};
const currentRegimes: Record<string, RegimeState> = {};
const currentPrices: Record<string, number> = {};

let totalScans = 0;
let tradesExecuted = 0;

const pct = (a: number, b: number) => ((a - b) / b) * 100;
const f = (n: number, d = 4) => n.toFixed(d);

// ============================================================
//  MAIN ENGINE
// ============================================================
export async function startEngine(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  🤖  Solana Quant Bot v3 — "No Box" Edition');
  console.log('  📐  Kelly Criterion │ Bayesian Fusion │ Hurst Regime │ 7 Signals');
  console.log(`  💰  Capital: $${STARTING_CAPITAL_USDC} USDC │ Mode: ${IS_SIMULATION ? 'SIMULATION' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Load persisted state
  loadPortfolioState();
  loadPositions();
  loadJournal();

  // Initialize ML if enabled
  if (FEATURES.ML_PREDICTOR) {
    await initMLPredictor();
  }

  // Connection setup
  const conn = createConnection();
  let keypair: Keypair | null = null;

  if (!IS_SIMULATION) {
    try {
      keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_BASE58));
      console.log(`🔑  Wallet: ${keypair.publicKey.toBase58()}\n`);

      // ── Sync On-Chain USDC Balance ──
      try {
        const usdcAccounts = await conn.getParsedTokenAccountsByOwner(keypair.publicKey, { mint: new PublicKey(USDC_MINT) });
        if (usdcAccounts.value.length > 0) {
          const actualUsdc = usdcAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
          if (typeof actualUsdc === 'number' && actualUsdc > 0) {
            const pState = getPortfolioState();
            const openPosCount = getPositionCount();
            
            pState.cashAvailable = actualUsdc;
            if (openPosCount === 0) {
              pState.totalValue = actualUsdc;
            }
            if (actualUsdc > pState.peakValue) {
              pState.peakValue = actualUsdc;
            }
            // Auto scale MAX_TRADE_USDC for compounding
            const scaledMaxTrade = Math.max(RISK.maxTradeUsdc, actualUsdc * (RISK.maxPerPositionPct / 100));
            RISK.maxTradeUsdc = scaledMaxTrade;
            savePortfolioState();
            console.log(`💰  Synced On-Chain USDC Balance: $${actualUsdc.toFixed(2)} │ Max Trade Limit: $${RISK.maxTradeUsdc.toFixed(2)}\n`);
          }
        }
      } catch (balErr: any) {
        console.log(`⚠️  Could not sync on-chain USDC balance on startup: ${balErr.message}\n`);
      }

    } catch (e: any) {
      console.error('❌  Invalid private key:', e.message);
      process.exit(1);
    }
  } else {
    console.log('⚠️   SIMULATION MODE — no wallet configured\n');
  }

  // Feature flags
  const enabledSignals: string[] = ['ema-atr'];
  if (FEATURES.CROSS_DEX) enabledSignals.push('cross-dex');
  if (FEATURES.ORDER_FLOW) enabledSignals.push('order-flow');
  if (FEATURES.REGIME_DETECTION) enabledSignals.push('regime');
  enabledSignals.push('bollinger', 'vwap');
  if (FEATURES.ML_PREDICTOR) enabledSignals.push('ml-predictor');
  if (FEATURES.WHALE_MONITOR) {
    enabledSignals.push('whale-monitor');
    dataBus.on('whale:alert', recordWhaleEvent);
  }
  console.log(`📡  Active signals: [${enabledSignals.join(', ')}]\n`);

  // ── Main Loop ──
  while (true) {
    totalScans++;
    const scanTime = new Date().toISOString();
    console.log(`\n─── Scan #${totalScans}  [${scanTime}] ${'─'.repeat(35)}`);

    for (const token of TOKENS) {
      const sym = token.symbol;
      try {
        // ── 1. GET PRICE ──
        const price = await getPrice(token);
        if (price === null) {
          console.log(`  ${sym.padEnd(10)} ⚠️  Price unavailable`);
          continue;
        }
        currentPrices[sym] = price;

        // ── APPROXIMATE VOLUME (Lee-Ready style) ──
        // We lack real websocket volume for these tokens, so we simulate a standard
        // USD volume per tick — but NEUTRAL: assigning 80% buy/split based on whether
        // price already went up is a look-ahead feedback loop that makes VPIN/OFI/VWAP
        // just re-confirm the last price move (classic momentum-chasing bias). Keep the
        // split at 50/50 so order-flow signals stay near zero unless real taker data is
        // wired in.
        const h = priceHistories[sym];
        const mockVolume = 10000;
        const buyVol = mockVolume * 0.5;
        const sellVol = mockVolume * 0.5;

        // ── 2. UPDATE HISTORY ──
        const pos = getPosition(sym);
        if (!priceHistories[sym]) priceHistories[sym] = initHistory(price);
        updateHistory(priceHistories[sym], price, mockVolume, !!pos);
        const hRef = priceHistories[sym];

        if (pos) {
          let posUpdated = false;
          if (price > pos.peakPrice) {
            pos.peakPrice = price;
            posUpdated = true;
          }
          if (price < pos.troughPrice) {
            pos.troughPrice = price;
            posUpdated = true;
          }
          if (posUpdated) setPosition(sym, pos);
        }

        if (!orderFlows[sym]) orderFlows[sym] = initOrderFlow();
        if (!vpinStates[sym]) vpinStates[sym] = initVpin();

        vpinStates[sym] = updateVpin(vpinStates[sym], buyVol, sellVol);

        if (FEATURES.ORDER_FLOW) {
          // Decay first based on time elapsed since last update
          decayOrderFlow(orderFlows[sym], Date.now());
          if (buyVol > 0) orderFlows[sym] = updateOrderFlow(orderFlows[sym], true, buyVol);
          if (sellVol > 0) orderFlows[sym] = updateOrderFlow(orderFlows[sym], false, sellVol);
        }

        // ── 3. REGIME DETECTION ──
        let regime = MarketRegime.RANDOM_WALK;
        let regimeState: RegimeState | undefined;
        if (FEATURES.REGIME_DETECTION && h.prices.length >= 20) {
          regimeState = classifyRegime(sym, h);
          regime = regimeState.regime;
          currentRegimes[sym] = regimeState;
        }

        // ── 4. COLLECT SIGNALS ──
        const signals: Signal[] = [];
        const hasPos = !!pos;

        // EMA/ATR
        const emaSig = generateEmaAtrSignal(sym, price, h, hasPos, pos?.entryPrice, regime);
        if (emaSig) signals.push(emaSig);

        // Bollinger
        const bbSig = generateBollingerSignal(sym, price, h, hasPos, regime);
        if (bbSig) signals.push(bbSig);

        // VWAP
        const vwapSig = generateVwapSignal(sym, price, h, hasPos, regime);
        if (vwapSig) signals.push(vwapSig);

        // Order Flow
        if (FEATURES.ORDER_FLOW) {
          const priceChange5m = h.prices.length > 100
            ? pct(price, h.prices[h.prices.length - 100])
            : 0;
          const ofiSig = generateOrderFlowSignal(sym, price, orderFlows[sym], priceChange5m, hasPos, regime);
          if (ofiSig) signals.push(ofiSig);
        }

        // Regime signal
        if (regimeState) {
          const regSig = generateRegimeSignal(sym, regimeState);
          if (regSig) signals.push(regSig);
        }

        // Cross-DEX (only on buy signals to save API calls)
        if (FEATURES.CROSS_DEX && !hasPos && signals.some(s => s.direction === 'LONG')) {
          const cdSig = await generateCrossDexSignal(token, hasPos);
          if (cdSig) signals.push(cdSig);
        }

        // ML Predictor
        if (FEATURES.ML_PREDICTOR) {
          const bb = computeBollinger(h.prices);
          const currentOfi = orderFlows[sym]?.ofi5m ?? 0;
          const mlSig = generateMLSignal(sym, price, h, hasPos, regime, bb.percentB, currentOfi);
          if (mlSig) signals.push(mlSig);
        }

        // Whale Monitor
        if (FEATURES.WHALE_MONITOR) {
          const whaleSig = generateWhaleSignal(sym, hasPos);
          if (whaleSig) signals.push(whaleSig);
        }

        // VPIN Toxicity
        const vpinSig = generateVpinSignal(sym, vpinStates[sym], hasPos);
        if (vpinSig) signals.push(vpinSig);

        // DTW Pattern Recognition
        const dtwSig = generateDtwSignal(sym, h, hasPos);
        if (dtwSig) signals.push(dtwSig);

        // ── 5. STATUS LINE ──
        const ready = h.prices.length >= 20;
        const regimeLabel = regime.replace(/_/g, ' ').toLowerCase();
        let status = `$${f(price, 6)}  ATR:${f(h.atr, 2)}%  [${regimeLabel}]`;

        if (pos) {
          const g = pct(price, pos.entryPrice);
          status += `  │ HELD $${f(pos.entryPrice, 6)}  ${g >= 0 ? '+' : ''}${f(g, 2)}%  Stop:$${f(pos.stopPrice, 6)}`;
        } else {
          status += `  │ Dip:${f(pct(price, h.rollingHigh), 2)}%`;
        }

        const sigSummary = signals
          .filter(s => s.direction !== 'NEUTRAL')
          .map(s => `${s.source}:${s.direction === 'LONG' ? '↑' : '↓'}${(s.confidence * 100).toFixed(0)}%`)
          .join(' ');
        if (!ready) status += '  [warming…]';
        console.log(`  ${sym.padEnd(10)} ${status}${sigSummary ? `  │ ${sigSummary}` : ''}`);

        if (!ready) continue;

        // ── 6. SIGNAL FUSION ──
        const decision = fuseSignals(signals, token, regime, hasPos, pos?.entryPrice);
        if (!decision) continue;

        // ── 7. RISK CHECK ──
        const riskCheck = checkRisk(regime);
        if (!riskCheck.allowed && decision.action === 'BUY') {
          console.log(`    ⛔ ${riskCheck.reason}`);
          continue;
        }

        // ── 7.5. CROSS-ASSET CORRELATION CHECK ──
        if (decision.action === 'BUY') {
          const allPositions = getAllPositions();
          const varianceCheck = checkPortfolioVariance(sym, allPositions, priceHistories);
          if (!varianceCheck.allowed) {
            console.log(`    ⛔ Correlation Block: ${varianceCheck.reason}`);
            continue;
          }
        }

        // ── 8. POSITION SIZING (Kelly) ──
        const portfolio = getPortfolioState();
        const currentExposure = portfolio.totalValue * (portfolio.totalExposurePct / 100);
        const sizing = calculatePositionSize(
          decision, portfolio.totalValue, portfolio.positionsCount,
          currentExposure,
          getHistoricalWinRate(), getHistoricalWinLossRatio(),
        );

        const isPyramidAdd = decision.action === 'BUY' && decision.signals.some((s: Signal) => s.metadata?.isAdd);

        // Apply risk multiplier
        let finalSize = sizing.positionUsdc * riskCheck.sizeMultiplier;
        let minimumSize = RISK.minTradeUsdc;
        
        if (decision.action === 'BUY') {
          if (isPyramidAdd) {
            finalSize = finalSize * 0.30;
            minimumSize = 2; // Absolute exchange minimum for scale-ins
          }
        }
        
        decision.positionSizeUsdc = Math.max(minimumSize, finalSize);

        if (decision.positionSizeUsdc < 2) {
          console.log(`    ⛔ Position too small ($${f(decision.positionSizeUsdc, 2)})`);
          continue;
        }

        console.log(`    📊 Kelly: raw=${f(sizing.kellyRaw * 100, 1)}% safe=${f(sizing.kellySafe * 100, 1)}% → $${f(decision.positionSizeUsdc, 2)} (${f(sizing.portfolioPct, 1)}% of portfolio)`);
        console.log(`    🎯 Decision: ${decision.action} ${sym} | Confidence: ${(decision.confidence * 100).toFixed(1)}% | ${decision.reason}`);

        // ── 9. EXECUTE ──
        if (decision.action === 'BUY' && (!hasPos || isPyramidAdd)) {
          // Entry cost hurdle: at this bankroll, marginal ATR targets just pay swap +
          // priority + slippage costs. Only trade when the target clears ~2.5x the
          // estimated round-trip cost (~1.8% for low-cap AMM swaps at $5–10 notional).
          const atrH = priceHistories[sym]?.atr ?? 2;
          const { sellPct } = getDynamicThresholds(atrH);
          const roundTripCostPct = 1.8;
          if (sellPct < roundTripCostPct * 2.5) {
            console.log(`    ⛔ Cost hurdle: +${sellPct.toFixed(1)}% target < ${(roundTripCostPct * 2.5).toFixed(1)}% (2.5x round-trip cost). Skipping - trade would only pay fees.`);
            continue;
          }
          await executeBuy(decision, conn, keypair, price, regime);
        } else if (decision.action === 'SELL' || decision.action === 'PARTIAL_SELL') {
          await executeSell(decision, conn, keypair, price, pos!);
        }

      } catch (e: any) {
        console.error(`  ${sym.padEnd(10)} ⚠️  ${e.message}`);
      }
    }

    // ── 10. PORTFOLIO UPDATE ──
    updatePortfolio(getAllPositions(), currentPrices);
    const portfolio = getPortfolioState();

    // ── 11. STATS ──
    console.log(`\n  💼  Portfolio: $${f(portfolio.totalValue, 2)} │ Cash: $${f(portfolio.cashAvailable, 2)} │ Exposure: ${f(portfolio.totalExposurePct, 1)}% │ DD: ${f(portfolio.drawdownPct, 1)}%`);
    console.log(`  📊  Scans: ${totalScans} │ Trades: ${tradesExecuted} │ PnL: ${portfolio.realizedPnl >= 0 ? '+' : ''}$${f(portfolio.realizedPnl, 4)} │ Positions: ${getPositionCount()}/4`);

    // Periodic metrics (every 20 scans)
    if (totalScans % 20 === 0) {
      const metrics = computeMetrics(getJournal());
      if (metrics.totalTrades > 0) {
        console.log(`\n${formatMetrics(metrics)}`);
      }
    }

    // ── Adaptive sleep ──
    const pollMs = getAdaptivePollInterval();
    console.log(`\n  ⏳  Next scan in ${pollMs}ms...`);
    await sleep(pollMs);
  }
}

// ============================================================
//  BUY EXECUTION
// ============================================================
async function executeBuy(
  decision: any,
  conn: Connection,
  kp: Keypair | null,
  price: number,
  regime: MarketRegime,
): Promise<void> {
  const { tokenInfo: token, positionSizeUsdc } = decision;
  const usdcRaw = Math.round(positionSizeUsdc * 1_000_000);
  const atr = priceHistories[token.symbol]?.atr ?? 2;
  const { stopPct, sellPct } = getDynamicThresholds(atr);

  // Dynamic Slippage: 50 BPS base + 10 BPS per 1% of ATR, max 150 BPS
  const customSlippageBps = Math.min(150, Math.round(50 + (atr * 10)));

  console.log(`\n  🛒  BUY ${token.symbol} $${f(positionSizeUsdc, 2)} | ${decision.reason}`);

  if (IS_SIMULATION || !kp) {
    console.log(`    ℹ️  Simulation: would buy $${f(positionSizeUsdc, 2)} of ${token.symbol}`);
    
    const existingPos = getPosition(token.symbol);
    if (existingPos) {
      // Pyramid Add
      const totalTokens = existingPos.tokenAmount + positionSizeUsdc / price;
      const totalInvested = existingPos.investedUsdc + positionSizeUsdc;
      existingPos.entryPrice = totalInvested / totalTokens;
      existingPos.tokenAmount = totalTokens;
      existingPos.investedUsdc = totalInvested;
      existingPos.pyramidLevel = (existingPos.pyramidLevel ?? 0) + 1;
      
      if (existingPos.pyramidLevel === 1) {
        existingPos.stopPrice = Math.max(existingPos.stopPrice, existingPos.entryPrice);
      }
      setPosition(token.symbol, existingPos);
    } else {
      setPosition(token.symbol, {
        id: `sim-${Date.now()}`,
        symbol: token.symbol,
        mint: token.mint,
        decimals: token.decimals,
        entryPrice: price,
        tokenAmount: positionSizeUsdc / price,
        investedUsdc: positionSizeUsdc,
        openedAt: Date.now(),
        stopPrice: price * (1 - stopPct / 100),
        targetPrice: price * (1 + sellPct / 100),
        peakPrice: price,
        troughPrice: price,
        partialDone: false,
        partialPnl: 0,
        regime,
        entrySignals: decision.signals.map((s: Signal) => s.source),
        entryConfidence: decision.confidence,
        pyramidLevel: 0,
      });
    }
    deductCash(positionSizeUsdc);
    tradesExecuted++;
    return;
  }

  try {
    const result = await withRetry(() => buyToken(conn, kp, token, usdcRaw, customSlippageBps));
    console.log(`    ✅ https://solscan.io/tx/${result.signature}`);

    const existingPos = getPosition(token.symbol);
    if (existingPos) {
      // Pyramid Add
      const totalTokens = existingPos.tokenAmount + result.tokensReceived;
      const totalInvested = existingPos.investedUsdc + positionSizeUsdc;
      existingPos.entryPrice = totalInvested / totalTokens;
      existingPos.tokenAmount = totalTokens;
      existingPos.investedUsdc = totalInvested;
      existingPos.pyramidLevel = (existingPos.pyramidLevel ?? 0) + 1;
      
      if (existingPos.pyramidLevel === 1) {
        existingPos.stopPrice = Math.max(existingPos.stopPrice, existingPos.entryPrice);
      }
      setPosition(token.symbol, existingPos);
    } else {
      setPosition(token.symbol, {
        id: result.signature,
        symbol: token.symbol,
        mint: token.mint,
        decimals: token.decimals,
        entryPrice: price,
        tokenAmount: result.tokensReceived,
        investedUsdc: positionSizeUsdc,
        openedAt: Date.now(),
        stopPrice: price * (1 - stopPct / 100),
        targetPrice: price * (1 + sellPct / 100),
        peakPrice: price,
        troughPrice: price,
        partialDone: false,
        partialPnl: 0,
        regime,
        entrySignals: decision.signals.map((s: Signal) => s.source),
        entryConfidence: decision.confidence,
        pyramidLevel: 0,
      });
    }
    deductCash(positionSizeUsdc);
    tradesExecuted++;
  } catch (e: any) {
    console.error(`    ❌ Buy failed: ${e.message}`);
  }
}

// ============================================================
//  SELL EXECUTION
// ============================================================
async function executeSell(
  decision: any,
  conn: Connection,
  kp: Keypair | null,
  price: number,
  pos: Position,
): Promise<void> {
  const { tokenInfo: token } = decision;
  const isPartial = decision.action === 'PARTIAL_SELL';
  const sellFraction = isPartial ? (decision.partialFraction ?? EXITS.PARTIAL_SELL_FRAC) : 1.0;
  const label = isPartial ? 'PARTIAL SELL (60%)' : 'SELL';
  console.log(`\n  💸  ${label} ${token.symbol} | ${decision.reason}`);

  if (IS_SIMULATION || !kp) {
    const sellAmount = pos.tokenAmount * sellFraction;
    const usdcOut = sellAmount * price;
    const invested = pos.investedUsdc * sellFraction;
    // Honest cost model: the journal previously logged slippage:0/fees:0, which
    // inflated sim PnL and Kelly so the bot saw "edge" that fees then erased.
    // Assume ~0.9%/side round-trip cost (swap fees + priority + low-cap slippage).
    const ROUND_TRIP_COST_PCT = 0.018;
    const estSlippage = usdcOut * (ROUND_TRIP_COST_PCT / 2);
    const estFees = usdcOut * (ROUND_TRIP_COST_PCT / 2);
    const pnl = usdcOut - invested - estFees - estSlippage;
    console.log(`    ℹ️  Simulation: ${label} → $${f(usdcOut, 4)} (PnL: ${pnl >= 0 ? '+' : ''}$${f(pnl, 4)} after est. $${f(estFees + estSlippage, 4)} cost)`);

    if (isPartial) {
      pos.tokenAmount *= (1 - sellFraction);
      pos.investedUsdc *= (1 - sellFraction);
      pos.partialDone = true;
      pos.partialPnl = pnl;
      setPosition(token.symbol, pos);
    } else {
      deletePosition(token.symbol);
    }

    addCash(pos.investedUsdc * sellFraction + pnl);
    recordTradeResult(pnl);
    recordTrade({
      id: `sim-sell-${Date.now()}`,
      symbol: token.symbol,
      action: decision.action,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      positionSize: pos.investedUsdc * sellFraction,
      tokenAmount: sellAmount,
      pnl,
      pnlPct: (pnl / (pos.investedUsdc * sellFraction)) * 100,
      slippage: estSlippage,
      fees: estFees,
      executionMs: 0,
      signals: decision.signals,
      entrySignals: pos.entrySignals,
      regime: decision.regime,
      kellyFraction: 0,
      portfolioValueBefore: getPortfolioState().totalValue,
      portfolioValueAfter: getPortfolioState().totalValue + pnl,
      timestamp: Date.now(),
    });
    tradesExecuted++;
    return;
  }

  try {
    // ── CRITICAL FIX: Fetch actual on-chain balance to account for buy slippage ──
    const accounts = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(token.mint) });
    let actualBalanceRaw = 0;
    if (accounts.value.length > 0) {
      actualBalanceRaw = parseInt(accounts.value[0].account.data.parsed.info.tokenAmount.amount, 10);
    }

    if (actualBalanceRaw === 0) {
      console.log(`    ⚠️  No on-chain balance found for ${token.symbol}. Removing ghost position.`);
      deletePosition(token.symbol);
      return;
    }

    const sellAmountRaw = isPartial 
      ? Math.round(actualBalanceRaw * sellFraction)
      : actualBalanceRaw; // Sell everything if not partial

    const actualSellAmountFloat = sellAmountRaw / Math.pow(10, pos.decimals);
    const atr = priceHistories[token.symbol]?.atr ?? 2;
    // Boost slippage for sells to ensure we get out
    const customSlippageBps = Math.min(300, Math.round(100 + (atr * 15)));

    const result = await withRetry(() => sellToken(conn, kp, token, sellAmountRaw, customSlippageBps));
    console.log(`    ✅ https://solscan.io/tx/${result.signature}`);

    const invested = pos.investedUsdc * sellFraction;
    const pnl = result.usdcReceived - invested;
    console.log(`    💰 PnL: ${pnl >= 0 ? '+' : ''}$${f(pnl, 4)} USDC`);

    if (isPartial) {
      pos.tokenAmount *= (1 - sellFraction);
      pos.investedUsdc *= (1 - sellFraction);
      pos.partialDone = true;
      pos.partialPnl = pnl;
      setPosition(token.symbol, pos);
    } else {
      deletePosition(token.symbol);
    }

    addCash(invested + pnl);
    recordTradeResult(pnl);

    // ── Realized-Gains Reinvestment Ladder ──
    try {
      const usdcAccounts = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(USDC_MINT) });
      let actualUsdc = 0;
      if (usdcAccounts.value.length > 0) {
        actualUsdc = usdcAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
      }
      
      const pState = getPortfolioState();
      
      if (actualUsdc > 0) {
        pState.cashAvailable = actualUsdc;
      }
      
      if (actualUsdc > pState.peakValue * 1.05) {
        RISK.maxTradeUsdc = Math.min(100, RISK.maxTradeUsdc * 1.10);
        pState.peakValue = actualUsdc;
        console.log(`    🪜  Ladder UP! MAX_TRADE_USDC now $${RISK.maxTradeUsdc.toFixed(2)}`);
        savePortfolioState();
      } else if (actualUsdc > 0 && actualUsdc < pState.peakValue * 0.92) {
        RISK.maxTradeUsdc = Math.max(RISK.minTradeUsdc, RISK.maxTradeUsdc * 0.80);
        pState.peakValue = actualUsdc;
        console.log(`    🪜  Ladder DOWN (Protect)! MAX_TRADE_USDC now $${RISK.maxTradeUsdc.toFixed(2)}`);
        savePortfolioState();
      }
    } catch (e) {
      console.log(`    ⚠️  Could not check on-chain USDC balance for ladder: ${e}`);
    }
    recordTrade({
      id: result.signature,
      symbol: token.symbol,
      action: decision.action,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      positionSize: invested,
      tokenAmount: actualSellAmountFloat,
      pnl,
      pnlPct: (pnl / invested) * 100,
      slippage: 0,
      fees: 0,
      executionMs: 0,
      signals: decision.signals,
      entrySignals: pos.entrySignals,
      regime: decision.regime,
      kellyFraction: 0,
      portfolioValueBefore: getPortfolioState().totalValue,
      portfolioValueAfter: getPortfolioState().totalValue + pnl,
      timestamp: Date.now(),
      txSignature: result.signature,
    });
    tradesExecuted++;
  } catch (e: any) {
    console.error(`    ❌ Sell failed: ${e.message}`);
  }
}

// ============================================================
//  ADAPTIVE POLL INTERVAL
// ============================================================
function getAdaptivePollInterval(): number {
  // Check if any token is in high-volatility regime
  const anyHighVol = Object.values(currentRegimes).some(
    r => r.regime === MarketRegime.HIGH_VOLATILITY,
  );
  const anyLowVol = Object.values(currentRegimes).every(
    r => r.regime === MarketRegime.LOW_VOLATILITY,
  );

  if (anyHighVol) return TIMING.HIGH_VOL_POLL_MS;
  if (anyLowVol) return TIMING.LOW_VOL_POLL_MS;
  return TIMING.BASE_POLL_MS;
}

// ============================================================
//  POSITION MANAGEMENT (trailing stops, peak tracking)
// ============================================================
// This runs inline during the scan loop via the sell signal logic
// in the EMA-ATR signal generator. Peak/stop updates happen in
// the history update phase when we detect new highs.
