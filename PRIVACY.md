# Privacy & Data Policy

**Solana Quant Trading Bot** is built with a focus on strict privacy and zero telemetry. 

## 1. Zero Telemetry
This software does **not** send any data, logs, API keys, trading history, or metrics back to the author, GitHub, or any third-party analytics services. 

## 2. Local Execution
All processes run locally on your hardware (or your designated Docker container/server).
- **API Keys:** Your `.env` file and API keys are stored entirely locally. They are only transmitted directly to the exchange APIs (e.g., Coinbase, Jupiter, Helius) using secure HTTPS/TLS.
- **Data Storage:** The local `data/` directory (which contains `positions.json`, metrics, and your trade journal) remains completely localized to your machine. 

## 3. Best Practices for Users
- **Never commit your `.env` file:** The `.gitignore` is configured to ignore `.env`, but you should always verify before running `git commit`.
- **Use Restricted API Keys:** When creating API keys on exchanges, ensure they are strictly scoped to the capabilities you need (e.g., Trade execution only, no Withdrawal permissions).
- **Secure your host environment:** The security of the bot relies entirely on the security of the host machine running it.

*By using this software, you acknowledge that you are responsible for maintaining the security of your own API keys and local environment.*
