/**
 * TensorFlow.js ML Model Trainer
 * ───────────────────────────────
 * Trains a real LSTM model from collected training data CSV.
 * Replaces the dummy model with a properly trained classifier.
 *
 * Usage: npx ts-node src/ml/training/train-model.ts
 * Requires: 500+ rows in data/training_data.csv
 */

import * as tf from '@tensorflow/tfjs-node';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CSV_FILE = path.join(DATA_DIR, 'training_data.csv');
const MODEL_DIR = path.join(process.cwd(), 'src', 'ml', 'model');

interface TrainingRow {
  features: number[];   // [rsi, ema9_norm, ema21_norm, atrPct, ofi, arbSpread, socialScore]
  label: number;        // 0 = down, 1 = flat, 2 = up (based on outcome_15m)
}

function parseTrainingData(): TrainingRow[] {
  if (!fs.existsSync(CSV_FILE)) {
    console.error(`❌ No training data found at ${CSV_FILE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(CSV_FILE, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const rows: TrainingRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 21) continue;

    const outcome15m = parseFloat(parts[19]);
    if (isNaN(outcome15m)) continue; // Skip rows without outcome

    const price = parseFloat(parts[2]);
    const rsi = parseFloat(parts[3]) / 100;             // Normalize RSI to 0-1
    const ema9 = parseFloat(parts[4]);
    const ema21 = parseFloat(parts[5]);
    const ema9Norm = price > 0 ? (ema9 - price) / price : 0;  // Relative to price
    const ema21Norm = price > 0 ? (ema21 - price) / price : 0;
    const atrPct = parseFloat(parts[7]) / 10;           // Normalize
    const ofi = parseFloat(parts[11]);                    // Already -1 to 1
    const arbSpread = parseFloat(parts[12]) / 5;         // Normalize
    const socialScore = parseFloat(parts[13]);             // Already normalized

    // Classify outcome
    let label = 1; // flat
    if (outcome15m > 0.5) label = 2;   // up
    if (outcome15m < -0.5) label = 0;  // down

    rows.push({
      features: [rsi, ema9Norm, ema21Norm, atrPct, ofi, arbSpread, socialScore],
      label,
    });
  }

  return rows;
}

async function trainModel() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🧠 TENSORFLOW.JS ML MODEL TRAINER');
  console.log('═══════════════════════════════════════════════════════════\n');

  const allData = parseTrainingData();
  console.log(`📊 Loaded ${allData.length} labeled samples\n`);

  if (allData.length < 100) {
    console.error('❌ Need at least 100 samples to train. Keep the bot running!');
    console.error(`   Currently have: ${allData.length} samples`);
    process.exit(1);
  }

  // Shuffle and split 80/20
  for (let i = allData.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allData[i], allData[j]] = [allData[j], allData[i]];
  }

  const splitIdx = Math.floor(allData.length * 0.8);
  const trainData = allData.slice(0, splitIdx);
  const testData = allData.slice(splitIdx);

  console.log(`📐 Split: ${trainData.length} train / ${testData.length} test`);

  // Class distribution
  const classCounts = [0, 0, 0];
  for (const r of allData) classCounts[r.label]++;
  console.log(`📊 Classes: Down=${classCounts[0]}, Flat=${classCounts[1]}, Up=${classCounts[2]}\n`);

  // Prepare tensors — reshape features into [batch, 50, 7] sequences
  // We'll create sliding windows of 50 consecutive features
  const WINDOW_SIZE = 50;
  const NUM_FEATURES = 7;

  // Group by product and create sequences
  function createSequences(data: TrainingRow[]): { xs: number[][][]; ys: number[] } {
    const xs: number[][][] = [];
    const ys: number[] = [];

    // Simple sliding window over all data
    for (let i = 0; i <= data.length - WINDOW_SIZE; i++) {
      const window = data.slice(i, i + WINDOW_SIZE);
      const featureWindow = window.map(r => r.features);
      xs.push(featureWindow);
      ys.push(window[window.length - 1].label); // Label from last item in window
    }

    return { xs, ys };
  }

  const { xs: trainXs, ys: trainYs } = createSequences(trainData);
  const { xs: testXs, ys: testYs } = createSequences(testData);

  if (trainXs.length < 10) {
    console.error('❌ Not enough sequential data to create training windows.');
    console.error(`   Need at least ${WINDOW_SIZE + 10} samples. Have ${trainData.length}`);
    process.exit(1);
  }

  console.log(`🔧 Training sequences: ${trainXs.length} │ Test sequences: ${testXs.length}\n`);

  const xTrain = tf.tensor3d(trainXs);
  const yTrain = tf.oneHot(tf.tensor1d(trainYs, 'int32'), 3);
  const xTest = testXs.length > 0 ? tf.tensor3d(testXs) : null;
  const yTest = testYs.length > 0 ? tf.oneHot(tf.tensor1d(testYs, 'int32'), 3) : null;

  // Build LSTM model matching ml-predictor.ts expected shape: [batch, 50, 7]
  const model = tf.sequential();

  model.add(tf.layers.lstm({
    units: 32,
    inputShape: [WINDOW_SIZE, NUM_FEATURES],
    returnSequences: true,
  }));

  model.add(tf.layers.dropout({ rate: 0.3 }));

  model.add(tf.layers.lstm({
    units: 16,
    returnSequences: false,
  }));

  model.add(tf.layers.dropout({ rate: 0.2 }));

  model.add(tf.layers.dense({ units: 3, activation: 'softmax' }));

  model.compile({
    optimizer: tf.train.adam(0.001),
    loss: 'categoricalCrossentropy',
    metrics: ['accuracy'],
  });

  model.summary();
  console.log('\n🚀 Training...\n');

  // Train
  const history = await model.fit(xTrain, yTrain, {
    epochs: 50,
    batchSize: 32,
    validationSplit: 0.15,
    callbacks: {
      onEpochEnd: (epoch, logs) => {
        if ((epoch + 1) % 10 === 0 || epoch === 0) {
          console.log(
            `  Epoch ${epoch + 1}/50 — loss: ${logs?.loss?.toFixed(4)} │ acc: ${((logs?.acc || 0) * 100).toFixed(1)}% │ val_loss: ${logs?.val_loss?.toFixed(4)} │ val_acc: ${((logs?.val_acc || 0) * 100).toFixed(1)}%`
          );
        }
      },
    },
  });

  // Evaluate on test set
  if (xTest && yTest) {
    const evalResult = model.evaluate(xTest, yTest) as tf.Scalar[];
    const testLoss = (await evalResult[0].data())[0];
    const testAcc = (await evalResult[1].data())[0];
    console.log(`\n📊 TEST RESULTS:`);
    console.log(`   Loss: ${testLoss.toFixed(4)} │ Accuracy: ${(testAcc * 100).toFixed(1)}%`);

    // Per-class accuracy
    const predictions = model.predict(xTest) as tf.Tensor;
    const predLabels = predictions.argMax(-1);
    const trueLabels = tf.tensor1d(testYs, 'int32');
    const predArray = Array.from(await predLabels.data());
    const trueArray = Array.from(await trueLabels.data());

    const classNames = ['Down', 'Flat', 'Up'];
    for (let c = 0; c < 3; c++) {
      const total = trueArray.filter(t => t === c).length;
      const correct = trueArray.filter((t, i) => t === c && predArray[i] === c).length;
      const acc = total > 0 ? (correct / total) * 100 : 0;
      console.log(`   ${classNames[c]}: ${correct}/${total} (${acc.toFixed(1)}%)`);
    }
  }

  // Save model
  console.log(`\n💾 Saving model to ${MODEL_DIR}...`);
  if (!fs.existsSync(MODEL_DIR)) fs.mkdirSync(MODEL_DIR, { recursive: true });
  await model.save(`file://${MODEL_DIR}`);
  console.log('✅ Model saved! Restart the bot to load the new model.');

  // Cleanup
  xTrain.dispose();
  yTrain.dispose();
  xTest?.dispose();
  yTest?.dispose();
}

trainModel().catch(err => {
  console.error('❌ Training failed:', err);
  process.exit(1);
});
