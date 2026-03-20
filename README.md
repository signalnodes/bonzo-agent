# Bonzo Vault Keeper Agent

AI-powered DeFi agent that executes and manages a leveraged yield strategy on Hedera using Bonzo Finance.

**Hedera Apex Hackathon 2026 - Bonzo Finance Bounty Submission**

## Strategy

The agent automates a 5-step leveraged yield strategy:

```
1. Supply collateral (HBAR/USDC) on Bonzo Lend (Aave v2 fork)
         |
2. Borrow HBARX at ~0.6% variable rate
         |
3. Unstake HBARX via Stader Labs -> receive HBAR (1-day cooldown)
         |
4. Deposit HBAR + USDC into Bonzo Vault (Beefy fork) at ~60-90% APY
         |
5. Monitor health factor + rate spread -> unwind if risk increases
```

The spread between the low HBARX borrow rate (~0.6%) and the high vault APY (~60-90%) generates leveraged yield. The agent continuously monitors conditions and recommends or executes unwinding when the spread narrows or health factor drops.

## Features

- **Natural language chat** - Ask about rates, strategy viability, or execute steps conversationally
- **Web dashboard** - Browser-based chat UI with live market data and real-time alerts
- **Proactive monitoring** - Background loop checks positions every 60s, pushes alerts on risk changes
- **On-chain vault APY** - Computes real vault APY from `getPricePerFullShare()` over time (no hardcoded estimates)
- **Full strategy execution** - Agent tools for every step: supply, borrow, unstake, deposit, withdraw, repay
- **HCS-10 reachable** - Registered via HOL Standards SDK, accepts inbound connections and messages
- **Hedera Agent Kit** - Uses official HAK with Bonzo lending plugin for Aave v2 operations
- **Stader integration** - Direct contract calls to Stader staking/undelegation contracts from hbarx-cli reference

## Architecture

```
src/
  agent/
    setup.ts          LangChain ReAct agent (GPT-4o) + 17 custom tools + HAK toolkit
    hcs10.ts          HCS-10 inbound message listener + auto-accept connections
    monitor-loop.ts   Proactive background monitoring with alert emission
    state.ts          Persistent agent state (.agent-state.json)
  tools/
    stader-unstake.ts Stader HBARX stake/unstake/withdraw (Hedera SDK)
    vault-deposit.ts  BonzoVaultConcLiq deposit/withdraw/preview (ethers.js)
  strategy/
    spread.ts         Bonzo Lend API + spread analysis
    monitor.ts        Health factor + alert monitoring
    orchestrator.ts   Entry/exit evaluation, step generator, state machine
    vault-apy.ts      On-chain vault APY from getPricePerFullShare() history
  config/
    contracts.ts      All contract addresses (Bonzo, Stader, vaults)
    env.ts            Environment config
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
| `analyze_spread` | Read | Spread analysis with live vault APY |
| `fetch_market_data` | Read | Bonzo Lend rates and liquidity |
| `check_position` | Read | Health factor + risk alerts |
| `evaluate_strategy_entry` | Read | Full entry viability check |
| `get_entry_steps` / `get_exit_steps` | Read | Step-by-step strategy instructions |
| `get_hbarx_exchange_rate` | Read | Live Stader exchange rate |
| `get_vault_apy` | Read | On-chain computed vault APY |
| `get_vault_info` | Read | Vault state (tokens, supply, PPS) |
| `get_vault_share_balance` | Read | User's vault share balance |
| `hbarx_unstake_preview` | Read | Preview unstake with live rate |
| `vault_preview_deposit` | Read | On-chain deposit preview |
| `execute_hbarx_unstake` | Write | Burn HBARX, start cooldown |
| `execute_hbarx_withdraw` | Write | Claim HBAR after cooldown |
| `execute_hbar_stake` | Write | Stake HBAR to get HBARX |
| `execute_vault_deposit` | Write | Deposit into USDC-HBAR vault |
| `execute_vault_withdraw` | Write | Withdraw from vault |

Plus all Bonzo Lend tools from HAK plugin (deposit, withdraw, borrow, repay, approve, market data).

## Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Fill in HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY, OPENAI_API_KEY

# Register agent with HOL (one-time, required for bounty)
npm run register

# Start the web dashboard
npm run serve
# Open http://localhost:3000

# Or use the terminal chat
npm run chat

# Or just check market conditions
npm run monitor
npm run monitor:watch  # continuous polling
```

## Contract Addresses (Mainnet)

| Contract | Address |
|----------|---------|
| Bonzo LendingPool | `0x236897c518996163E7b313aD21D1C9fCC7BA1afc` |
| Bonzo DataProvider | `0x78feDC4D7010E409A0c0c7aF964cc517D3dCde18` |
| USDC-HBAR Vault | `0x724F19f52A3E0e9D2881587C997db93f9613B2C7` |
| Stader Staking | `0.0.1027588` |
| Stader Undelegation | `0.0.1027587` |
| HBARX Token | `0.0.834116` |

## Bounty Requirements

| Requirement | Implementation |
|-------------|---------------|
| Hedera Agent Kit | HederaLangchainToolkit with bonzoPlugin |
| HOL Standards SDK | `npm run register` - HCS-10 + HCS-11 via createAndRegisterAgent |
| Reachable via HCS-10 | Inbound topic polling, auto-accept connections, message routing |
| Natural language chat | LangChain ReAct agent with GPT-4o + 17 custom tools |
| Intent-based UI | Web chat dashboard with live monitoring and strategy execution |

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript
- **AI**: LangChain + GPT-4o via @langchain/openai
- **Hedera**: @hashgraph/sdk + hedera-agent-kit + @bonzofinancelabs/hak-bonzo-plugin
- **EVM**: ethers.js v6 (vault interactions via Hedera JSON-RPC relay)
- **Registration**: @hashgraphonline/standards-sdk (HCS-10/HCS-11)
- **Web**: Express + vanilla HTML/CSS/JS (no build step)
