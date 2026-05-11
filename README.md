# Solana Quant Trading Bot

A production-grade Solana trading bot written in TypeScript that implements two complementary quant strategies: **Swing/DCA trading** and **Cross-DEX spread detection**, both powered by the Jupiter v6 Aggregator API.

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (Node.js) |
| Blockchain | Solana (via `@solana/web3.js`) |
| Aggregator | [Jupiter v6 API](https://jup.ag) (public endpoint) |
| DEXs covered | Raydium · Orca · Meteora |
| Key management | `.env` via `dotenv` |
| Execution | Versioned Transactions, Priority Fees, Auto CU |

## Strategies

### 1. Swing / DCA Bot
Monitors SOL, BONK, FARTCOIN, and TRUMP every 3 seconds and executes rules-based swing trades.

**Entry logic (all must be true):**
- EMA(10) > EMA(20) — uptrend filter, refuses to buy in downtrends
- Price dipped > ATR-adaptive threshold below rolling high
- Price is rising vs. 3 scans ago — momentum guard (no falling knives)
- Minimum 20 price samples collected (warm-up period)

**Exit logic:**
- **Partial exit** — sells 60% of position at +4% gain
- **Trailing stop** — activates at +2%, trails 1.5% below peak for the remaining 40%
- **Hard stop loss** — exits 100% if price drops -2% below entry

**Risk/Reward: 2:1** — profitable at just a 34% win rate.

### 2. Cross-DEX Spread Detection
Compares buy/sell prices across Raydium, Orca, and Meteora for each token. When a spread ≥ 0.6% is detected at the same time as a swing entry signal, the position size is boosted from $6 → $9 as a confidence multiplier.

## Quant Features

```
✅ 2:1 Risk/Reward ratio     (sell +4%, stop -2%)
✅ EMA(10/20) trend filter   (no buying in downtrends)
✅ ATR-adaptive thresholds   (volatility-aware entry/exit sizing)
✅ Momentum confirmation     (price must be rising before buy)
✅ Trailing stop             (locks in profits as price climbs)
✅ Partial profit taking     (60% at target, 40% trails)
✅ Cross-DEX as booster      (1.5× size when spread confirms signal)
✅ Position persistence      (positions.json survives restarts)
✅ Simulation mode           (runs safely with no wallet configured)
```

## Setup

### Prerequisites
- Node.js v18+
- A Solana wallet with USDC + SOL for gas

### Install

```bash
git clone https://github.com/YOUR_USERNAME/sol-arb-bot.git
cd sol-arb-bot
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
PRIVATE_KEY=your_base58_private_key_here
```

> ⚠️ Use a **dedicated hot wallet** funded with only the capital you intend to trade. Never use your main wallet.

### Run

```bash
# Simulation mode (no wallet needed — just logs signals)
npx ts-node index.ts

# Live trading (after setting PRIVATE_KEY in .env)
npx ts-node index.ts
```

## Capital Allocation (Default: $50 USDC)

| Pool | Amount | Purpose |
|---|---|---|
| Swing positions | $6–$9 each × up to 4 | Buy dips, sell rallies |
| Cross-DEX boost | +$3 when spread confirms | Higher-confidence entries |
| SOL gas buffer | ~0.05 SOL | Transaction fees |

## Configuration

All parameters are at the top of `index.ts`:

| Constant | Default | Description |
|---|---|---|
| `BASE_SELL_PCT` | `4.0` | Take-profit % above entry |
| `BASE_STOP_PCT` | `2.0` | Stop-loss % below entry |
| `TRAIL_ACTIVATION_PCT` | `2.0` | Trailing stop activates at this gain |
| `TRAIL_DISTANCE_PCT` | `1.5` | Trail distance below peak |
| `MIN_DIP_PCT` | `1.5` | Minimum dip % to consider a buy |
| `MAX_DIP_PCT` | `4.5` | Maximum dip % threshold |
| `MIN_SPREAD_PCT` | `0.6` | Minimum cross-DEX spread to boost |
| `POLL_INTERVAL_MS` | `3000` | Scan interval (3s = free tier safe) |

## Sample Output

```
─── Scan #24  [2026-05-11T14:38:11Z] ────────────────────────────────
  SOL      $94.61  ATR:0.18%  EMA↑  │ High:$95.20  Dip:-0.62%
  BONK     $0.000007  ATR:0.22%  EMA↑  │ High:$0.0000073  Dip:-2.41% ← 📉 2.41% dip | EMA✅ | Momentum✅
    🔀 Cross-DEX spread +0.74% confirms signal → BOOSTED $9
  🛒  BUY BONK [BOOSTED $9] | 📉 2.41% dip | ATR: 0.22% | EMA✅ | Momentum✅
    ✅ https://solscan.io/tx/5xK3j...

  📊  Stats │ Scans: 24 │ Trades: 1 │ P&L: +$0.0000 USDC │ Positions: 1/4
```

## Architecture

```
index.ts
├── CONFIG          — all tunable parameters
├── TOKENS          — mints + decimals (SOL, BONK, FARTCOIN, TRUMP)
├── updateHistory() — computes EMA(10), EMA(20), ATR per token
├── checkSwingSignal() — applies all entry/exit filters
├── checkCrossDexSpread() — queries 6 DEX-pair combos per token
├── executeSwingTrade()  — signs + sends VersionedTransactions
└── main()          — 3-second polling loop
```

## Disclaimer

This is an educational project demonstrating algorithmic trading concepts on Solana. Cryptocurrency trading carries significant financial risk. Past performance of any strategy does not guarantee future results. Only trade with capital you can afford to lose entirely.
