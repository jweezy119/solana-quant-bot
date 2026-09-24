import 'dotenv/config';

// ─── CONFIGURATION ─────────────────────────────────────────────
const STARTING_BANKROLL = 200;
const SIMULATION_PATHS = 5000;
const TRADES_PER_PATH = 500;

// Coinbase Bot Config
const CB_WIN_RATE = 0.55; // 55%
const CB_SIZE_PCT = 0.30;
const CB_MIN_TRADE = 10;
const CB_TAKE_PROFIT = 0.055;
const CB_STOP_LOSS = -0.035;
const CB_FEE_RATE = 0.012; // 1.2% round trip maker fee

// Meme Sniper Config
const MEME_WIN_RATE = 0.35; // 35%
const MEME_SIZE_PCT = 0.20;
const MEME_MIN_TRADE = 10;
const MEME_FIXED_FEE = 1.50; // $1.50 average gas/slippage round trip
const MEME_TAKE_PROFIT = 0.50;
const MEME_STOP_LOSS = -0.20;

// ─── UTILS ──────────────────────────────────────────────────
function random() {
  return Math.random();
}

function runPath(
  botName: string,
  winRate: number,
  sizePct: number,
  minTrade: number,
  takeProfit: number,
  stopLoss: number,
  feeRate: number,
  fixedFee: number
) {
  let bankroll = STARTING_BANKROLL;
  let peak = bankroll;
  let tradesTaken = 0;

  for (let i = 0; i < TRADES_PER_PATH; i++) {
    // Check if ruined
    if (bankroll < minTrade) {
      break;
    }

    // Determine trade size
    let tradeSize = bankroll * sizePct;
    if (tradeSize < minTrade) {
      tradeSize = bankroll; // Go all-in if less than target but above min
    }
    if (tradeSize > bankroll) tradeSize = bankroll;

    const isWin = random() <= winRate;
    let pnl = 0;
    
    if (isWin) {
      pnl = tradeSize * takeProfit;
    } else {
      pnl = tradeSize * stopLoss;
    }

    // Apply fees
    const feeDrag = (tradeSize * feeRate) + fixedFee;
    pnl -= feeDrag;

    bankroll += pnl;
    if (bankroll > peak) peak = bankroll;
    tradesTaken++;
  }

  return { finalBankroll: bankroll, peak, tradesTaken, ruined: bankroll < minTrade };
}

// ─── MAIN ───────────────────────────────────────────────────
function main() {
  console.log(`\n🎲 MONTE CARLO SIMULATOR 🎲`);
  console.log(`Starting Bankroll: $${STARTING_BANKROLL}`);
  console.log(`Simulating ${SIMULATION_PATHS} paths of ${TRADES_PER_PATH} trades each...`);
  
  const results = {
    coinbase: { finalSum: 0, peakSum: 0, ruins: 0, wins: 0, endVals: [] as number[] },
    meme: { finalSum: 0, peakSum: 0, ruins: 0, wins: 0, endVals: [] as number[] }
  };

  for (let i = 0; i < SIMULATION_PATHS; i++) {
    // Coinbase Path
    const cb = runPath('Coinbase', CB_WIN_RATE, CB_SIZE_PCT, CB_MIN_TRADE, CB_TAKE_PROFIT, CB_STOP_LOSS, CB_FEE_RATE, 0);
    results.coinbase.endVals.push(cb.finalBankroll);
    results.coinbase.finalSum += cb.finalBankroll;
    results.coinbase.peakSum += cb.peak;
    if (cb.ruined) results.coinbase.ruins++;
    if (cb.finalBankroll > STARTING_BANKROLL) results.coinbase.wins++;

    // Meme Path
    const meme = runPath('Meme', MEME_WIN_RATE, MEME_SIZE_PCT, MEME_MIN_TRADE, MEME_TAKE_PROFIT, MEME_STOP_LOSS, 0, MEME_FIXED_FEE);
    results.meme.endVals.push(meme.finalBankroll);
    results.meme.finalSum += meme.finalBankroll;
    results.meme.peakSum += meme.peak;
    if (meme.ruined) results.meme.ruins++;
    if (meme.finalBankroll > STARTING_BANKROLL) results.meme.wins++;
  }

  // Calculate Medians
  results.coinbase.endVals.sort((a, b) => a - b);
  results.meme.endVals.sort((a, b) => a - b);
  
  const cbMedian = results.coinbase.endVals[Math.floor(SIMULATION_PATHS / 2)];
  const memeMedian = results.meme.endVals[Math.floor(SIMULATION_PATHS / 2)];

  console.log(`\n🏦 COINBASE QUANT BOT (Win Rate: ${CB_WIN_RATE * 100}%, 1.2% Fee Drag)`);
  console.log(`  - Risk of Ruin (<$10): ${((results.coinbase.ruins / SIMULATION_PATHS) * 100).toFixed(2)}%`);
  console.log(`  - Paths Profitable: ${((results.coinbase.wins / SIMULATION_PATHS) * 100).toFixed(2)}%`);
  console.log(`  - Median Ending Bankroll: $${cbMedian.toFixed(2)}`);
  console.log(`  - Average Peak: $${(results.coinbase.peakSum / SIMULATION_PATHS).toFixed(2)}`);

  console.log(`\n💊 SOLANA MEME SNIPER (Win Rate: ${MEME_WIN_RATE * 100}%, $1.50 Gas/Slippage)`);
  console.log(`  - Risk of Ruin (<$10): ${((results.meme.ruins / SIMULATION_PATHS) * 100).toFixed(2)}%`);
  console.log(`  - Paths Profitable: ${((results.meme.wins / SIMULATION_PATHS) * 100).toFixed(2)}%`);
  console.log(`  - Median Ending Bankroll: $${memeMedian.toFixed(2)}`);
  console.log(`  - Average Peak: $${(results.meme.peakSum / SIMULATION_PATHS).toFixed(2)}`);
  console.log(`\n`);
}

main();
