/**
 * ML Predictor Signal (TensorFlow.js)
 * ────────────────────────────────────
 * Loads a pre-trained LSTM model and runs inference on a sliding window.
 * Gracefully degrades if no model is present.
 */

import { Signal, PriceHistory, MarketRegime } from '../core/types';
import { createSignal } from './signal-types';

let tf: any = null;
let model: any = null;
let modelLoaded = false;
let modelFailed = false;

// Feature normalization parameters (set during training)
const SCALER = {
  priceMean: 0, priceStd: 1,
  volumeMean: 0, volumeStd: 1,
};

const WINDOW_SIZE = 50;
const NUM_FEATURES = 7; // price_return, atr, ema_spread, bb_pctb, ofi, momentum, hour_sin

/**
 * Attempt to load TensorFlow.js and the model.
 * Non-blocking: if tf.js isn't installed or model missing, we skip ML signals.
 */
export async function initMLPredictor(): Promise<boolean> {
  if (modelFailed) return false;
  try {
    tf = await import('@tensorflow/tfjs-node');
    model = await tf.loadLayersModel('file://./src/ml/model/model.json');
    modelLoaded = true;
    console.log('🧠  ML model loaded successfully');
    return true;
  } catch (e: any) {
    modelFailed = true;
    console.log(`🧠  ML model not available (${e.message}) — skipping ML signals`);
    return false;
  }
}

/**
 * Extract feature vector from current state.
 */
function extractFeatures(h: PriceHistory, bb_pctb: number, ofi: number): number[] {
  const prices = h.prices;
  const p = prices[prices.length - 1];
  const pPrev = prices.length > 1 ? prices[prices.length - 2] : p;
  const priceReturn = pPrev > 0 ? (p - pPrev) / pPrev : 0;
  const emaSpread = h.emaSlow > 0 ? (h.emaFast - h.emaSlow) / h.emaSlow : 0;
  const hourSin = Math.sin((new Date().getHours() / 24) * 2 * Math.PI);

  return [
    priceReturn,
    h.atr / 100,
    emaSpread,
    bb_pctb,
    ofi,
    prices.length > 3 ? (p - prices[prices.length - 4]) / prices[prices.length - 4] : 0,
    hourSin,
  ];
}

// Sliding window buffer per token
const buffers: Record<string, number[][]> = {};

export function generateMLSignal(
  symbol: string, price: number, h: PriceHistory,
  hasPosition: boolean, regime?: MarketRegime,
  bb_pctb: number = 0.5, ofi: number = 0
): Signal | null {
  if (!modelLoaded || !tf || !model) return null;

  // Update buffer
  if (!buffers[symbol]) buffers[symbol] = [];
  const features = extractFeatures(h, bb_pctb, ofi);
  buffers[symbol].push(features);
  if (buffers[symbol].length > WINDOW_SIZE) buffers[symbol].shift();
  if (buffers[symbol].length < WINDOW_SIZE) return null;

  try {
    // Run inference inside tf.tidy() to prevent memory leaks
    const result = tf.tidy(() => {
      const input = tf.tensor3d([buffers[symbol]]); // [1, 50, 7]
      const prediction = model.predict(input);
      return prediction.dataSync();
    });

    // result[0] = P(up), result[1] = P(down) (softmax output)
    const pUp = result[0] ?? 0.5;
    const pDown = result[1] ?? 0.5;

    // Only signal when model is confident
    if (pUp > 0.6 && !hasPosition) {
      return createSignal('ml-predictor', 'LONG', pUp, symbol, {
        reason: 'model-bullish', pUp, pDown,
      });
    }
    if (pDown > 0.6 && hasPosition) {
      return createSignal('ml-predictor', 'SHORT', pDown, symbol, {
        reason: 'model-bearish', pUp, pDown,
      });
    }
  } catch (e: any) {
    // Inference failed — don't crash, just skip
  }
  return null;
}
