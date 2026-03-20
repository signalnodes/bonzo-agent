# Bonzo Vault Keeper Agent

AI-powered DeFi agent for Hedera that executes and manages a leveraged yield strategy using Bonzo Finance.

## Strategy

1. **Supply collateral** on Bonzo Lend
2. **Borrow HBARX** at ~0.6% variable rate
3. **Unstake HBARX** via Stader Labs → receive HBAR
4. **Deposit HBAR + USDC** into high-yield dual-asset vault (~60-90% APY)
5. **Monitor** health factor, rate spread, and vault APY — unwind if conditions change

## Quick Start

```bash
cp .env.example .env
# Fill in your Hedera credentials and AI API key

npm install
npm run monitor   # Check current rates and spread
npm run chat      # Interactive agent chat
```

## Architecture

- **Bonzo Lend** (Aave v2 fork) — borrowing HBARX at low variable rates
- **Bonzo Vaults** (Beefy Finance fork) — concentrated liquidity vaults on SaucerSwap
- **Stader Labs** — HBARX liquid staking / unstaking
- **Hedera Agent Kit** — on-chain interaction framework
- **LangChain** — natural language chat interface

## Tech Stack

- TypeScript / Node.js
- Hedera Agent Kit + Bonzo Plugin
- ethers.js for custom vault interactions
- LangChain for AI agent orchestration

## Built for

[Hedera Hello Future: Apex Hackathon 2026](https://hellofuturehackathon.dev) — Bonzo Finance Bounty
