import fs from 'fs';
import path from 'path';
import { RandomForestClassifier } from 'ml-random-forest';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CSV_FILE = path.join(DATA_DIR, 'training_data.csv');

let classifier: RandomForestClassifier | null = null;
let isTraining = false;
let lastTrainTime = 0;

function encodeTrend(trend: string): number {
  if (trend.toUpperCase() === 'UP') return 1;
  if (trend.toUpperCase() === 'DOWN') return -1;
  return 0; // SIDEWAYS or unknown
}

export async function trainRandomForest() {
  if (isTraining || !fs.existsSync(CSV_FILE)) return;
  isTraining = true;

  try {
    const lines = fs.readFileSync(CSV_FILE, 'utf-8').split('\n');
    if (lines.length < 50) {
      console.log(`🌲 Not enough data to train Random Forest (need 50, got ${lines.length})`);
      isTraining = false;
      return;
    }

    const X: number[][] = [];
    const Y: number[] = [];

    // Keep only the most recent 100 rows to prevent blocking the event loop
    let dataLines = lines.slice(1);
    if (dataLines.length > 100) {
      dataLines = dataLines.slice(-100);
    }

    // Process data
    for (let i = 0; i < dataLines.length; i++) {
      const parts = dataLines[i].split(',');
      if (parts.length < 21) continue;

      // Extract outcome_15m (index 19)
      const outcome15m = parts[19];
      if (!outcome15m || outcome15m.trim() === '') continue; // Skip incomplete data

      const pctChange = parseFloat(outcome15m);
      if (isNaN(pctChange)) continue;

      // rsi(3), atrPct(7), trend(10), ofi(11), arbSpread(12), btcRsi(15)
      const rsi = parseFloat(parts[3]) || 50;
      const atrPct = parseFloat(parts[7]) || 0;
      const trendEncoded = encodeTrend(parts[10]);
      const ofi = parseFloat(parts[11]) || 0;
      const arbSpread = parseFloat(parts[12]) || 0;
      const btcRsi = parseFloat(parts[15]) || 50;

      X.push([rsi, atrPct, trendEncoded, ofi, arbSpread, btcRsi]);
      
      // Label: 1 if it gained > 0.05% in 15m (winning trade), 0 otherwise
      Y.push(pctChange > 0.05 ? 1 : 0);
    }

    if (X.length < 50) {
      console.log(`🌲 Not enough labeled outcomes to train Random Forest (${X.length} labeled)`);
      isTraining = false;
      return;
    }

    const options = {
      seed: 42,
      maxFeatures: 3,
      replacement: true,
      nEstimators: 50,
      treeOptions: {
        maxDepth: 10,
      }
    };

    console.log(`🌲 Training Random Forest on ${X.length} historical outcomes...`);
    const rf = new RandomForestClassifier(options);
    rf.train(X, Y);
    
    classifier = rf;
    lastTrainTime = Date.now();
    console.log(`🌲 Random Forest trained successfully! (Last Train Time: ${new Date().toISOString()})`);

  } catch (err: any) {
    console.error(`🌲 Random Forest training failed: ${err.message}`);
  } finally {
    isTraining = false;
  }
}

export interface RFFeatures {
  rsi: number;
  atrPct: number;
  trend: string;
  ofi: number;
  arbSpread: number;
  btcRsi: number;
}

export function predictWinProbability(features: RFFeatures): number | null {
  if (!classifier) {
    // Attempt to train in background if not trained yet
    if (!isTraining && Date.now() - lastTrainTime > 60 * 60 * 1000) {
      trainRandomForest();
    }
    return null;
  }

  try {
    const x = [
      features.rsi,
      features.atrPct,
      encodeTrend(features.trend),
      features.ofi,
      features.arbSpread,
      features.btcRsi
    ];

    // .predict returns an array of predictions. But we want probability.
    // In `ml-random-forest`, we can get prediction probability if supported, 
    // or we can manually check tree votes using classifier.estimators
    // Let's implement a quick probability aggregation:
    let upVotes = 0;
    const estimators = (classifier as any).estimators;
    if (!estimators || estimators.length === 0) return null;

    for (const tree of estimators) {
      const pred = tree.predict([x])[0];
      if (pred === 1) upVotes++;
    }

    return upVotes / estimators.length;
  } catch (err) {
    return null;
  }
}
