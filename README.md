# Solana Quant Trading Bot v3 ("No Box" Edition)

A highly performant, modular, and event-driven AI quant engine optimized for micro-capital on Solana.

## Tech Stack & Architecture

This is a complete ground-up rewrite from the v2 monolithic architecture, now featuring a decoupled event-driven data bus, mathematical risk sizing, and machine learning predictors.

| Component | Implementation |
|---|---|
| **Core Architecture** | Event-driven pub/sub (`DataBus`), TypeScript, Node.js |
| **Execution Layer** | Jupiter v6 API (Swaps), Jito Block Engine (MEV Protection) |
| **Data Layer** | Helius WebSocket (Whale/Liquidity), Jupiter Price Feeds |
| **Strategy Layer** | Fractional Kelly Criterion, Bayesian Signal Fusion, Risk Management |
| **Signal Engine** | EMA/ATR, VWAP, Bollinger, Order Flow, Cross-DEX, ML Predictor |
| **Regime Detection** | Hurst Exponent (Trending vs Mean-Reverting) |
| **Persistence** | File-based JSON store for Positions, Trade Journal, and Metrics |

## Enterprise Security & IAM (Identity and Access Management)

Designed with security and enterprise-grade access control patterns suitable for quantitative execution environments:

- **Identity & Access Management (IAM)**: Implements secure API authentication for the Coinbase Advanced Trade v3 API using cryptographically signed JSON Web Tokens (JWT) and restricted API keys with scoped permissions.
- **API Integration & WebSockets**: Robust integration with high-throughput external services (Jupiter v6, Helius, Coinbase) handling rate limits, paginated cursors, and state reconciliation across REST and WebSocket streams.
- **Granular Access Control**: Enforces strict execution boundaries. The `DataBus` and execution engine decouple read-only market data from write-action trading capabilities.
- **Conditional Access & Execution Gates**: Employs dynamic "Conditional Access" rules for trading operations. The execution layer ("GOD MODE") acts as a Policy Enforcement Point, instantly halting buy orders if daily fee budgets are exhausted, zero-fee verification fails, or market regime metrics (e.g., BTC 24h trend) fall below acceptable thresholds.


## Key Features

- **Event-Driven Data Bus**: Zero coupling between data feeds, signal generators, and execution.
- **Advanced Regime Detection**: Uses Hurst Exponent to adapt to market conditions (Trending, Mean-Reverting, High/Low Volatility).
- **Bayesian Signal Fusion**: Combines up to 7 distinct signal sources using dynamically weighted probabilities based on the current market regime.
- **Kelly Criterion Sizing**: Mathematically optimizes position sizing based on historical win rate and win/loss ratio, scaled by signal confidence.
- **Jito MEV Protection**: Submits bundles directly to Jito Block Engine to prevent sandwich attacks.
- **Machine Learning Integration**: XGBoost model predicts price direction using normalized feature vectors.
- **Meme Token Sniper**: Zero-block execution with strict Dev-Hold % filters to guarantee minimum developer skin-in-the-game on Pump.fun.
- **Cloudflare Tunnel Dashboard**: Automatically exposes the internal React UI securely to the public internet so you can monitor the bot without SSH.
- **Dockerized**: Fully containerized for resilient, automated local deployment.

## Project Structure

```
src/
├── core/         # Types, Config, Main Engine
├── data/         # DataBus, Jupiter Feed, Helius WS
├── execution/    # Jupiter Client, Jito Executor, Tx Engine
├── ml/           # Feature Engine, Python Training Scripts
├── persistence/  # Position Store, Trade Journal, Metrics
├── signals/      # Signal Generators (EMA, VWAP, ML, Whale, etc.)
└── strategy/     # Kelly Sizer, Signal Fusion, Risk Manager
```

## Setup & Execution

### Prerequisites
- Node.js v18+
- Docker & Docker Compose (Optional, for containerized deployment)
- A Solana wallet with USDC + SOL for gas

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/solana-quant-bot.git
cd solana-quant-bot
npm install
```

### Configuration

Copy the example environment file:
```bash
cp .env.example .env
```

Edit `.env` to configure your keys and API endpoints:
```env
PRIVATE_KEY=your_base58_private_key_here
HELIUS_API_KEY=your_helius_key
```

### Running Locally

**Simulation Mode** (Does not require a wallet or real funds):
Leave `PRIVATE_KEY=YOUR_PRIVATE_KEY_HERE` in your `.env` file to run in pure simulation mode.

```bash
npm run build
npm start
```

---

## Coinbase Quant & Social Sentiment Bot

An autonomous trading bot for Coinbase Advanced Trade that fuses technical signals with real-time social sentiment from Twitter / X and crypto news feeds.

### Features
- **Multi-Pair Continuous Scanning**: Tracks `BTC-USD`, `ETH-USD`, `SOL-USD` (customizable).
- **Technical Analysis Engine**: Real-time RSI(14), EMA(9/21) trend filtering, ATR volatility bands, and Bollinger Bands.
- **Early Momentum Capture**: Reduced 24h Return thresholds allow the bot to identify and buy into newly forming trends before exhaustion.
- **Social Media & Twitter Sentiment**: Ingests live sentiment and volume spikes from Twitter / X API v2 and breaking crypto news RSS feeds with NLP polarity scoring.
- **Bayesian Signal Fusion**: Only triggers high-conviction trades when technical setups and social sentiment confirm each other.
- **Risk Management & Position Sizing**: Kelly-style fractional allocation (max 25% exposure), automated Stop-Loss (2.5%), Take-Profit (5.0%), and extended Maker Order Timeouts (60s) for optimal, fee-less fills.
- **Simulation vs Live Execution**: Defaults to Paper Trading mode to test strategies safely without risking real funds.

### Running the Coinbase Bot

**1. Interactive Terminal (Simulation / Paper Mode)**:
```bash
npm run coinbase
```

**2. Run in Background**:
```bash
npm run coinbase:bg
```

**3. View Live Logs**:
```bash
npm run coinbase:logs
```

**4. Live Trading Execution (Uses Real Funds)**:
Set `COINBASE_SIMULATION=false` in `.env` or run:
```bash
npm run coinbase:live
```


### Docker Deployment

To run the bot in a resilient, isolated container:

```bash
docker-compose up -d
```

Check the logs:
```bash
docker-compose logs -f bot
```

## Signals & Indicators

- **EMA/ATR**: Momentum filter with volatility breakout thresholds.
- **VWAP**: Volume-Weighted Average Price tracking.
- **Bollinger Bands**: Mean-reversion signals based on standard deviation bands.
- **Order Flow**: Real-time buy/sell imbalance tracking via WebSocket.
- **Cross-DEX**: Arbitrage/spread detection across Raydium, Orca, and Meteora.
- **Whale Monitor**: Tracks large token movements via Helius Geyser RPC.
- **ML Predictor**: XGBoost model trained on historical normalized feature vectors.

## Disclaimer

This is an educational project demonstrating algorithmic trading concepts on Solana. Cryptocurrency trading carries significant financial risk. Past performance of any strategy does not guarantee future results. Only trade with capital you can afford to lose entirely.
