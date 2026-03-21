# Bonzo Vault Keeper Agent

AI-powered DeFi strategy copilot on Hedera that evaluates, routes, and executes a leveraged yield strategy across Bonzo Finance, SaucerSwap, and Stader Labs.

**Hedera Apex Hackathon 2026 — Bonzo Finance Bounty Submission**

## Strategy

Borrow HBARX cheaply on Bonzo Lend, convert it to HBAR via the best available route, and deploy into Bonzo's USDC-HBAR concentrated liquidity vault.

```
Supply collateral (HBAR/USDC) on Bonzo Lend (Aave v2 fork)
         |
Borrow HBARX at ~0.6% variable rate
         |
    ┌────┴────────────────────────────────┐
    │ Fast Mode            Max Yield Mode │
    │ Swap HBARX → HBAR    Unstake via    │
    │ on SaucerSwap        Stader Labs    │
    │ (instant, ~0.3%fee)  (0 fee, 1-day) │
    └────┬────────────────────────────────┘
         |
Deposit HBAR + USDC into Bonzo USDC-HBAR Vault (~60-90% APY)
         |
Monitor health factor + rate spread → unwind if risk increases
```

**Net yield = vault APY − HBARX borrow rate − conversion costs**

The agent compares both paths in real time and recommends the one with better net value.

## Features

- **Dual-path routing** — compares SaucerSwap swap (instant) vs Stader unstake (max value) and recommends the best path with a live on-chain quote
- **Natural language chat** — ask about rates, strategy viability, or execute steps conversationally
- **Web dashboard** — browser-based chat UI with live market data and real-time alerts
- **Proactive monitoring** — background loop checks positions every 60s, pushes alerts on risk changes
- **On-chain vault APY** — computes real vault APY from `getPricePerFullShare()` over time
- **Full execution toolset** — tools for every strategy step: supply, borrow, swap, unstake, deposit, repay, withdraw
- **HCS-10 reachable** — registered via HOL Standards SDK, accepts inbound connections and messages
- **Conservative risk controls** — refuses to proceed if health factor < 1.5, spread < 5%, or swap price impact > 5%

## Two Conversion Modes

### Fast Mode (SaucerSwap)
Swap borrowed HBARX → HBAR instantly on SaucerSwap V1. Best for demos and when swap price impact is low. Incurs ~0.3% swap fee plus slippage.

### Max Yield Mode (Stader)
Unstake HBARX through Stader Labs for full redemption value. Zero swap fee, but 1-day cooldown delays vault entry. Best when the cost of waiting (missed vault yield) is less than the swap cost.

The agent fetches a live SaucerSwap quote, computes the opportunity cost of the Stader cooldown, and recommends accordingly.

## Architecture

```
src/
  agent/
    setup.ts          LangChain ReAct agent + custom tools + HAK toolkit
    system-prompt.ts  Dual-path strategy copilot prompt
    hcs10.ts          HCS-10 inbound message listener + auto-accept
    monitor-loop.ts   Background health/spread monitoring with alert emission
    state.ts          Persistent agent state (.agent-state.json)
  tools/
    stader-unstake.ts Stader HBARX stake/unstake/withdraw (Hedera SDK)
    vault-deposit.ts  BonzoVaultConcLiq deposit/withdraw/preview (ethers.js)
    bonzo-lend.ts     Bonzo LendingPool deposit/borrow/repay/withdraw (Hedera SDK)
  strategy/
    spread.ts         Bonzo Lend API + spread analysis
    monitor.ts        Health factor + alert monitoring
    orchestrator.ts   Entry/exit evaluation, step generator (Fast + Max Yield)
    vault-apy.ts      On-chain vault APY from getPricePerFullShare() history
    path-compare.ts   SaucerSwap vs Stader comparison engine with live quotes
    health-monitor.ts Health factor polling + zone classification + auto-unwind
  config/
    contracts.ts      All contract addresses (Bonzo, Stader, SaucerSwap, vaults)
    env.ts            Environment config
    constants.ts      Shared constants (thresholds, defaults)
  server.ts           Express web server + chat API + SSE alerts
  chat.ts             Terminal chat interface
  monitor.ts          Standalone market monitor
  register.ts         HOL Standards SDK agent registration
public/
  index.html          Web chat UI (dark theme, real-time alerts, markdown)
```

## Agent Tools

| Tool | Type | Description |
|------|------|-------------|
| `analyze_spread` | Read | Spread analysis: HBARX borrow rate vs vault APY |
| `fetch_market_data` | Read | Bonzo Lend rates, utilization, liquidity |
| `compare_conversion_paths` | Read | Fast Mode vs Max Yield Mode with live SaucerSwap quote |
| `check_position` | Read | Health factor + risk alerts |
| `evaluate_strategy_entry` | Read | Full entry viability check |
| `get_entry_steps` | Read | Step-by-step instructions (fast or maxYield mode) |
| `get_exit_steps` | Read | Unwind instructions based on current phase |
| `get_hbarx_exchange_rate` | Read | Live Stader exchange rate |
| `get_vault_apy` | Read | On-chain computed vault APY |
| `get_vault_info` | Read | Vault state (tokens, supply, price per share) |
| `get_vault_share_balance` | Read | User's vault share balance |
| `hbarx_unstake_preview` | Read | Preview unstake with live rate |
| `vault_preview_deposit` | Read | On-chain deposit preview |
| `monitor_health_status` | Read | Instant health check + monitor state |
| `bonzo_get_position` | Read | Current Bonzo Lend position (collateral, debt, HF) |
| `execute_saucerswap_swap` | Write | **Fast Mode**: swap HBARX → HBAR on SaucerSwap |
| `execute_hbarx_unstake` | Write | **Max Yield**: burn HBARX, start Stader cooldown |
| `execute_hbarx_withdraw` | Write | Claim HBAR after Stader cooldown |
| `execute_hbar_stake` | Write | Stake HBAR → HBARX via Stader (for repayment) |
| `execute_vault_deposit` | Write | Deposit HBAR + USDC into USDC-HBAR vault |
| `execute_vault_withdraw` | Write | Withdraw from vault (burns shares) |
| `bonzo_deposit` | Write | Supply collateral on Bonzo Lend |
| `bonzo_borrow` | Write | Borrow from Bonzo Lend |
| `bonzo_repay` | Write | Repay borrow on Bonzo Lend |
| `bonzo_withdraw` | Write | Withdraw collateral from Bonzo Lend |

Plus Hedera Agent Kit native tools (token transfer, account info, etc.).

## Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Fill in HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY, ANTHROPIC_API_KEY (or OPENAI_API_KEY)

# Register agent with HOL Standards SDK (one-time, required for bounty)
npm run register

# Start the web dashboard
npm run serve
# Open http://localhost:3000

# Or use the terminal chat
npm run chat

# Check market conditions
npm run monitor
npm run monitor:watch  # continuous polling
```

## Example Interactions

```
you> What is the best path right now to convert 500 HBARX to HBAR?

agent> [calls compare_conversion_paths, get_hbarx_exchange_rate]

Fast Mode (SaucerSwap):   ~682 HBAR received, instant, ~0.8% cost
Max Yield Mode (Stader):  ~689 HBAR received, 1-day wait, 0% fee
Opportunity cost of waiting: ~$0.18 in missed vault yield

Recommendation: Max Yield Mode — Stader gives 7 more HBAR (~$0.65) which
exceeds the $0.18 opportunity cost of the 1-day cooldown.
```

```
you> Enter the HBARX yield strategy with 1000 WHBAR and 50 USDC

agent> [evaluates spread, checks health factor, compares paths, asks confirmation]

Before proceeding:
• Supply 1000 WHBAR as collateral → health factor: ∞
• Borrow 400 HBARX → health factor: 2.8 (safe)
• Max Yield Mode: unstake 400 HBARX → ~548 HBAR (1-day wait)
• Vault deposit: ~$50 USDC + ~$50 HBAR worth into USDC-HBAR vault
• Estimated net APY: ~69.4% (vault 70% − borrow 0.6%)

Risks: variable rates, impermanent loss, 1-day deployment delay.
Proceed? (yes/no)
```

## Contract Addresses (Hedera Mainnet)

| Contract | Address |
|----------|---------|
| Bonzo LendingPool | `0x236897c518996163E7b313aD21D1C9fCC7BA1afc` |
| Bonzo DataProvider | `0x78feDC4D7010E409A0c0c7aF964cc517D3dCde18` |
| USDC-HBAR Vault | `0x724F19f52A3E0e9D2881587C997db93f9613B2C7` |
| SaucerSwap V1 Router | `0x00000000000000000000000000000000002E7A5D` |
| HBARX/WHBAR Pair | `0x000000000000000000000000000000000010932C` |
| Stader Staking | `0.0.1027588` |
| Stader Undelegation | `0.0.1027587` |
| HBARX Token | `0.0.834116` |

## Bounty Requirements

| Requirement | Implementation |
|-------------|---------------|
| Hedera Agent Kit | `HederaLangchainToolkit` with full tool suite |
| HOL Standards SDK | `npm run register` — HCS-10 + HCS-11 via `createAndRegisterAgent` |
| Reachable via HCS-10 | Inbound topic polling, auto-accept connections, message routing |
| Natural language chat | LangChain ReAct agent with 25+ custom tools |
| Intent-based UI | Web dashboard + terminal chat with full strategy execution |

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript
- **AI**: LangChain + Claude (Anthropic) or GPT-4o (OpenAI) — configurable via env
- **Hedera**: `@hashgraph/sdk` + `hedera-agent-kit` + `@bonzofinancelabs/hak-bonzo-plugin`
- **EVM**: ethers.js v6 (vault + SaucerSwap interactions via Hedera JSON-RPC relay)
- **Registration**: `@hashgraphonline/standards-sdk` (HCS-10/HCS-11)
- **Web**: Express + vanilla HTML/CSS/JS (no build step)
