# Solana Copy Trade Bot

Local Solana copy-trading bot with a Node.js backend, SQLite storage, and a React/Vite dashboard.

The bot runs on your machine. It watches configured trader wallets, detects supported token buy transactions, copies the buy from the local trading wallet, tracks the opened position, and sells automatically when one of the configured exit rules is reached.

## What Works Now

- Local npm workspace monorepo with `backend` and `frontend`.
- Backend API on `127.0.0.1:3001`.
- Frontend dashboard on `127.0.0.1:5173`.
- SQLite persistence for settings, tracked traders, active positions, closed positions, processed signatures, and bot logs.
- Manual management of tracked trader wallets from the dashboard.
- Start/stop trading control from the dashboard.
- RPC polling monitor for tracked trader wallets.
- Buy detection for supported Solana venues.
- Automatic copy-buy execution through Jupiter.
- Automatic position tracking after a copied buy.
- Automatic sell execution through Jupiter.
- Manual sell button for open positions.
- Closed positions history with filtering and export.
- Bot logs page with polling updates.
- Wallet balance display from the backend.
- Configurable buy amount in SOL.
- Configurable take-profit multiplier.
- Configurable stop-loss multiplier.
- Configurable position timeout in minutes.
- Token safety warnings before buy.
- Backend tests for core detection, settings, position rules, validation, and token safety helpers.

## Supported Buy Detection

The backend attempts to detect trader buys on:

- Raydium AMM / CPMM / CLMM
- Orca Whirlpool
- Meteora
- Pump.fun bonding curve
- PumpSwap
- Jupiter routes

Execution currently goes through Jupiter routes. This lets the bot copy buys and sell positions when Jupiter can build a route for the token.

## Trading Flow

1. Add trader wallet addresses in the dashboard.
2. Set buy amount in SOL.
3. Set take-profit multiplier.
4. Set stop-loss multiplier.
5. Set position timeout.
6. Click `Start trading`.
7. The backend polls tracked trader wallets through the configured Solana RPC endpoint.
8. When a supported trader buy is detected, the backend checks token safety and writes warnings to logs if needed.
9. The bot buys the same token through Jupiter using the local trading wallet.
10. The opened token appears as an active position.
11. The profit watcher checks active positions using Jupiter quotes.
12. The bot sells automatically on take-profit, stop-loss, or timeout.
13. The position moves to closed positions.
14. The frontend shows positions, wallet state, settings, traders, and logs.

## Exit Rules

The bot can close an open position for four reasons:

- `take-profit`: current price reaches the configured profit multiplier.
- `stop-loss`: current price falls to the configured stop-loss multiplier.
- `timeout`: position stays open longer than the configured timeout.
- `manual`: user clicks manual sell from the dashboard.

## Token Safety Warnings

Before a buy, the backend checks the token and writes warnings to logs. These checks do not block the buy.

Current checks:

- freeze authority
- mint authority
- Token-2022 program
- Token-2022 transfer fee extension
- unavailable Jupiter buy route
- unavailable Jupiter sell route
- high round-trip quote loss
- possible tax or weak liquidity
- high price impact

Warnings are saved as `TOKEN_SAFETY_WARNING` log events. If the check itself fails, the backend writes `TOKEN_SAFETY_CHECK_FAILED` and continues with the buy attempt.

## Dashboard

The React dashboard includes:

- main overview with backend status
- trading start/stop control
- wallet balance card
- copy trading settings
- tracked traders management
- open positions
- closed positions
- export for closed positions
- export for tracked traders
- bot logs

The frontend reads backend state through polling.

## Local Storage

The backend uses SQLite for local persistence.

Stored data includes:

- settings
- tracked traders
- active positions
- closed positions
- processed trader transaction signatures
- bot logs

Processed signatures are stored to avoid copying the same trader transaction twice.

## Requirements

- Node.js `24.x`
- npm
- Solana HTTP RPC endpoint
- Local trading wallet private key in base58 format

## Environment

Create a local env file:

```text
backend/src/helpers/.env
```

Required values:

```env
PRIVATE_KEY=your_base58_private_key
MAINNET_ENDPOINT=your_solana_rpc_https_url
WS_MAINNET_ENDPOINT=your_solana_rpc_wss_url
```

Optional values:

```env
JUPITER_SWAP_API_URL=https://lite-api.jup.ag/swap/v1
JUPITER_API_KEY=
JUPITER_SLIPPAGE_BPS=500
COPY_TRADE_POLL_MS=5000
COPY_TRADE_SIGNATURE_LIMIT=20
COPY_TRADE_INCLUDE_HISTORY=false
```

The env file is ignored by git. Never commit private keys or RPC keys.

## Install

Install dependencies from the repository root:

```bash
npm install
```

## Run

Start backend:

```bash
npm run backend
```

Start frontend:

```bash
npm run frontend
```

Or run both together:

```bash
npm run dev
```

Frontend:

```text
http://127.0.0.1:5173
```

Backend:

```text
http://127.0.0.1:3001
```

## Tests

Run backend tests:

```bash
npm test
```

Run backend typecheck:

```bash
npm run typecheck:api
```

Build frontend:

```bash
npm run build:frontend
```

## Current Limitations

- Monitoring currently uses RPC polling, not gRPC streaming.
- Execution uses Jupiter routes instead of native per-platform swap adapters.
- Token safety checks are warning-only and do not block trades.
- Honeypot and tax detection is based on quote behavior, not a guaranteed sell simulation.
- Slippage is configured through backend env, not from the dashboard yet.
- Real trading can lose money because of latency, slippage, failed routes, low liquidity, price impact, and token contract risk.
