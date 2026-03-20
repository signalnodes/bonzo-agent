# Bonzo Vault Keeper Agent

Hedera Apex Hackathon 2026 — Bonzo Finance bounty submission ($8K pool).
Deadline: **March 23, 2026 11:59 PM ET**.

## What this is

An AI-powered DeFi agent that executes a leveraged yield strategy on Hedera:
1. Supply collateral on Bonzo Lend (Aave v2 fork)
2. Borrow HBARX at ~0.6% variable rate
3. Unstake HBARX via Stader Labs → receive HBAR (1-day cooldown)
4. Deposit HBAR + USDC into the dual-asset USDC-HBAR vault on Bonzo Vaults (Beefy Finance fork) at ~60-90% APY
5. Monitor health factor, rate spread, vault APY — unwind if spread narrows

## Bounty requirements

- Must use **Hedera Agent Kit** (`hedera-agent-kit` on npm)
- Must register agent via **HOL Standards SDK** (`@hashgraph-online/standards-sdk`)
- Must be reachable via HCS-10, A2A, XMTP, or MCP
- Must support **natural language chat interface**
- Suggested approaches: volatility-aware rebalancer, sentiment-based harvester, or intent-based UI
- We are building the **intent-based UI** approach with the HBARX spread strategy as flagship feature

## Tech stack

- Node.js / TypeScript
- Hedera Agent Kit + LangChain
- Existing `@bonzofinancelabs/hak-bonzo-plugin` for lending operations
- Custom vault interaction code for `BonzoVaultConcLiq.deposit()`
- Stader hbarx-cli as reference for unstaking
- HOL Standards SDK for agent registration

## Key technical facts

### Bonzo Lend (Aave v2 fork)
- LendingPool: `0x236897c518996163E7b313aD21D1C9fCC7BA1afc`
- AaveProtocolDataProvider: `0x78feDC4D7010E409A0c0c7aF964cc517D3dCde18`
- AaveOracle: `0xc0Bb4030b55093981700559a0B751DCf7Db03cBB`
- WETHGateway: `0x9a601543e9264255BebB20Cef0E7924e97127105`
- Data API: `https://mainnet-data-staging.bonzo.finance/market`
- HBARX borrow rate: ~0.6% (variable, 5.26% utilization)
- Existing Bonzo plugin handles: deposit, withdraw, borrow, repay, approve

### Bonzo Vaults (Beefy Finance fork)
- Repo: github.com/Bonzo-Labs/beefy-hedera-contracts
- Vault contract: `BonzoVaultConcLiq`
- Deposit signature: `deposit(uint256 _amount0, uint256 _amount1, uint256 _minShares)`
- Accepts native HBAR (auto-wraps to WHBAR), payable
- Both tokens required; vault fits what it can, returns leftovers
- `previewDeposit()` available to check proportions
- NOT ERC-4626 — custom Beefy interface
- USDC-HBAR dual vault: ~60-92% APY, ~$108K TVL
- Vaults are **mainnet only** (no testnet)

### Stader Labs HBARX
- HBARX token: `0x00000000000000000000000000000000000cba44`
- Unstaking cooldown: 1 day
- Exchange rate: ~1 HBARX = 1.36-1.39 HBAR (increases over time)
- Reference: github.com/stader-labs/hbarx-cli

### WHBAR
- Address: `0x0000000000000000000000000000000000163B5a`

## API endpoints

- Bonzo Lend data: `https://mainnet-data-staging.bonzo.finance/market`
- Bonzo dashboard: `https://mainnet-data-staging.bonzo.finance/dashboard/{accountId}`
- Bonzo stats: `https://mainnet-data-staging.bonzo.finance/stats`
- Bonzo info: `https://mainnet-data-staging.bonzo.finance/info`

## Project structure

```
src/
  agent/        — LangChain agent setup, chat interface
  tools/        — Custom Hedera Agent Kit tools (vault deposit, unstake HBARX)
  strategy/     — Spread calculation, health monitoring, entry/exit logic
  config/       — Contract addresses, ABIs, env config
```

## Workflow rules

- Package manager: npm
- Never commit secrets
- .env ignored, .env.example committed
- GitHub: `gh repo create <name> --private --source . --remote origin --push`
