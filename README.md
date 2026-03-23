# Bonzo Vault Keeper — AI DeFi Agent for Hedera

**Hedera Apex Hackathon 2026 — Bonzo Finance Bounty Submission**

An AI strategy copilot that evaluates, routes, and executes a leveraged yield play on Hedera mainnet: borrow HBARX cheaply from Bonzo Lend, convert via the optimal path (SaucerSwap instant swap vs Stader zero-fee unstake), and deploy into Bonzo's USDC/HBAR concentrated liquidity vault at ~60–90% APY. All through a natural language chat interface reachable via web dashboard, terminal, or HCS-10.

---

## Judge Quick Start

**Prerequisites:** Node.js ≥ 20, an `.env` file (see below)

```bash
npm install
cp .env.example .env
# Fill in HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY, ANTHROPIC_API_KEY (or OPENAI_API_KEY)
```

**Verify connectivity (read-only, no transactions):**

```bash
npm run smoke-test
```

Expected output — no wallet balance required, all calls are read-only.
Values are live mainnet data and will vary:

```
=== Bonzo Vault Keeper — Smoke Test ===

1. Bonzo Lend market data...
   HBARX borrow APY : 0.600%      ← live, varies
   HBARX utilization: 5.3%        ← live, varies
   HBAR price (USD)  : $0.0930    ← live, varies
   Net spread (vs 70% vault APY): 69.4%
   Viable: true   OK

2. Stader HBARX exchange rate...
   1 HBARX = 1.371240 HBAR        ← increases over time   OK

3. SaucerSwap quote for 10 HBARX...
   HBAR received  : 13.6891
   Price impact   : 0.001%   OK

4. Path comparison for 10 HBARX (vault APY=70%)...
   Recommendation : maxYield
   Rationale      : Stader gives more HBAR and opportunity cost is low   OK
```

**Launch the web dashboard:**

```bash
npm run serve
# Open http://localhost:3000
```

**Or use the terminal chat:**

```bash
npm run chat
```

---

## Connecting via HCS-10

After running `npm run register`, the agent is reachable at the inbound topic ID printed during registration. Any HCS-10 client can connect and send messages.

**Using `@hashgraphonline/standards-sdk`:**

```ts
import { HCS10Client } from "@hashgraphonline/standards-sdk";

const client = new HCS10Client({
  network: "mainnet",
  operatorId: "0.0.YOUR_ACCOUNT",
  operatorPrivateKey: "YOUR_PRIVATE_KEY",
});

// Connect to the agent's inbound topic (printed by npm run register)
const AGENT_INBOUND_TOPIC = "0.0.XXXXXXX";

const { connectionTopicId } = await client.initiateConnection(AGENT_INBOUND_TOPIC);

// Send a message — the agent will reply on the connection topic
await client.sendMessage(connectionTopicId, "What is the current HBARX spread?");

// Poll the Hedera Mirror Node for the agent's reply
const MIRROR = "https://mainnet.mirrornode.hedera.com";
const res = await fetch(
  `${MIRROR}/api/v1/topics/${connectionTopicId}/messages?order=asc&limit=25`
);
const { messages } = await res.json();
for (const msg of messages) {
  const text = Buffer.from(msg.message, "base64").toString("utf-8");
  console.log(JSON.parse(text));
}
```

The agent auto-accepts connections and responds to every inbound message through its full LangChain tool suite — the same agent you chat with in the web UI.

---

## The Strategy

```
Supply collateral (WHBAR or USDC) on Bonzo Lend (Aave v2 fork)
         │
         ▼
Borrow HBARX at ~0.6% variable APY
         │
    ┌────┴────────────────────────────────────────┐
    │ Fast Mode                  Max Yield Mode   │
    │ Swap HBARX → HBAR          Unstake via      │
    │ on SaucerSwap V1           Stader Labs      │
    │ instant · ~0.3% fee        0 fee · 1-day    │
    └────┬────────────────────────────────────────┘
         │
         ▼
Deposit HBAR + USDC into Bonzo USDC-HBAR Vault (~60–90% APY)
         │
         ▼
Monitor health factor + rate spread → unwind if risk rises
```

**Net yield = Vault APY − HBARX borrow rate − conversion costs**

The agent fetches a live SaucerSwap on-chain quote, computes the opportunity cost of the Stader cooldown, and picks the path with better net value automatically.

---

## Bounty Requirements

This submission fulfills all Bonzo Finance bounty requirements. Every requirement runs against live Hedera mainnet — no mocks, no testnet.

| Requirement | Status | Implementation |
|---|---|---|
| **Hedera Agent Kit** | ✅ | `HederaLangchainToolkit` + full HAK tool suite used throughout |
| **HOL Standards SDK** | ✅ | `npm run register` — creates HCS-10 inbound/outbound topics + HCS-11 profile metadata |
| **Reachable via HCS-10** | ✅ | Inbound topic listener (gRPC streaming), auto-accepts connections, routes to agent |
| **Natural language chat** | ✅ | LangChain ReAct agent, 25+ custom tools, full conversation history, web + terminal + HCS-10 |
| **Intent-based UI** | ✅ | Web dashboard with live market metrics — every action executes real on-chain strategy steps |

---

## Features

- **Dual-path routing** — compares SaucerSwap (instant swap) vs Stader (zero-fee unstake) with live on-chain quotes; recommends best path based on opportunity cost math
- **Natural language execution** — describe what you want; the agent calls the right tools, shows you what will happen, and asks for confirmation before any transaction
- **Live web dashboard** — dark-theme chat UI with real-time market metrics (HBARX borrow rate, vault APY, net spread, health factor), SSE alert stream
- **Background monitor** — checks market conditions every 60s, emits alerts on rate changes, utilization spikes, low health factor, or spread collapse
- **On-chain vault APY** — computes real APY from `getPricePerFullShare()` history (Beefy-style), no off-chain oracles
- **Adaptive health polling** — polls health factor at intervals that tighten as risk increases: 5min → 1min → 30s → 15s as HF drops toward 1.5
- **Auto-unwind trigger** — if both on-chain and REST API confirm HF < 1.5 and `MONITOR_AUTO_UNWIND=true`, the agent initiates exit steps automatically
- **HCS-10 reachable** — registered via HOL Standards SDK; accepts inbound connections and processes messages from any HCS-10 client

---

## Example Chat Session

```
you> hey

agent> Current spread is 69.4% — vault APY 70% minus 0.6% HBARX borrow. Strong entry
       window. HBARX utilization at 5.3%, rates are stable.

       I can help you enter the strategy, compare conversion paths, check your position,
       or monitor the market. What do you want to do?

you> Compare paths for 500 HBARX

agent> [calls compare_conversion_paths, get_hbarx_exchange_rate]

       Fast Mode (SaucerSwap)   → 682.1 HBAR  |  instant  |  ~0.9% cost
       Max Yield Mode (Stader)  → 688.7 HBAR  |  1-day    |  0% fee

       Opportunity cost of 1-day cooldown: ~$0.18 in missed vault yield
       Stader advantage: 6.6 HBAR ≈ $0.61

       Recommendation: Max Yield Mode — Stader wins by $0.43.

you> Enter the strategy with 1000 WHBAR and 50 USDC

agent> [evaluates spread, compares paths, estimates health factors]

       Before I proceed:
         • Supply 1000 WHBAR as collateral — health factor: ∞
         • Borrow 400 HBARX at 0.60% APY — health factor post-borrow: ~2.8 ✓
         • Max Yield Mode: unstake 400 HBARX → ~548 HBAR (1-day cooldown)
         • Vault deposit: 50 USDC + ~50 USDC worth of HBAR
         • Estimated net APY: ~69.4% (vault 70% − borrow 0.6%)

       Risks: variable borrow rates, impermanent loss on USDC/HBAR, liquidation if
       HF drops below 1.0. Keep HF above 2.0.

       Proceed? (yes/no)
```

---

## Architecture

```
src/
  agent/
    setup.ts          LangChain ReAct agent + 25+ custom tools + HAK toolkit
    system-prompt.ts  Strategy copilot persona and decision logic
    hcs10.ts          HCS-10 inbound listener — gRPC streaming (TopicMessageQuery), auto-accept connections
    monitor-loop.ts   Background monitor — market checks, alerts, health factor
    state.ts          Persistent state (.agent-state.json)
  tools/
    stader-unstake.ts Stader HBARX stake/unstake/withdraw (Hedera SDK)
    vault-deposit.ts  BonzoVaultConcLiq deposit/withdraw/preview (ethers.js)
    bonzo-lend.ts     Bonzo LendingPool supply/borrow/repay/withdraw
  strategy/
    spread.ts         Bonzo Lend API + spread analysis + 60s cache + retry
    orchestrator.ts   Entry/exit evaluation, step generator (Fast + Max Yield)
    path-compare.ts   SaucerSwap vs Stader comparison with live on-chain quotes
    vault-apy.ts      On-chain vault APY from getPricePerFullShare() history
    health-monitor.ts Adaptive health factor polling + zone classification
    monitor.ts        Position health check + alert formatting
  config/
    contracts.ts      All contract addresses
    constants.ts      All thresholds, intervals, limits (single source of truth)
    env.ts            Environment config + validation
  server.ts           Express web server + chat API + SSE alerts + health check
  chat.ts             Terminal chat interface
  monitor.ts          Standalone market monitor (one-shot or --watch)
  smoke-test.ts       Read-only connectivity verification (no transactions)
  register.ts         HOL Standards SDK agent registration

public/
  index.html          Web dashboard (dark theme, live metrics, real-time alerts)
```

---

## Agent Tools

| Tool | Type | Description |
|------|------|-------------|
| `analyze_spread` | Read | Live spread: HBARX borrow rate vs vault APY |
| `fetch_market_data` | Read | Bonzo Lend rates, utilization, liquidity |
| `compare_conversion_paths` | Read | Fast Mode vs Max Yield Mode with live SaucerSwap quote |
| `check_position` | Read | Health factor + risk alerts |
| `evaluate_strategy_entry` | Read | Full entry viability (spread, liquidity, utilization, rate) |
| `get_entry_steps` | Read | Ordered execution steps for fast or maxYield mode |
| `get_exit_steps` | Read | Unwind instructions based on current phase |
| `get_hbarx_exchange_rate` | Read | Live Stader exchange rate (on-chain) |
| `get_vault_apy` | Read | On-chain computed vault APY from PPS history |
| `get_vault_info` | Read | Vault state (tokens, supply, price per share) |
| `get_vault_share_balance` | Read | User's vault share balance |
| `hbarx_unstake_preview` | Read | Preview unstake output with live rate |
| `vault_preview_deposit` | Read | On-chain deposit proportion preview |
| `monitor_health_status` | Read | Instant health check + monitor state |
| `bonzo_get_position` | Read | Current Bonzo Lend position (collateral, debt, HF) |
| `execute_saucerswap_swap` | **Write** | **Fast Mode**: swap HBARX → HBAR on SaucerSwap V1 |
| `execute_hbarx_unstake` | **Write** | **Max Yield**: burn HBARX, start Stader cooldown |
| `execute_hbarx_withdraw` | **Write** | Claim HBAR after Stader cooldown |
| `execute_hbar_stake` | **Write** | Stake HBAR → HBARX via Stader (for repayment) |
| `execute_vault_deposit` | **Write** | Deposit HBAR + USDC into USDC-HBAR vault |
| `execute_vault_withdraw` | **Write** | Withdraw from vault (burns shares, returns tokens) |
| `bonzo_deposit` | **Write** | Supply collateral on Bonzo Lend |
| `bonzo_borrow` | **Write** | Borrow from Bonzo Lend |
| `bonzo_repay` | **Write** | Repay borrow on Bonzo Lend |
| `bonzo_withdraw` | **Write** | Withdraw collateral from Bonzo Lend |

Plus Hedera Agent Kit native tools (token transfer, account info, balance queries).

---

## Contract Addresses (Hedera Mainnet)

| Contract | Address |
|----------|---------|
| Bonzo LendingPool | `0x236897c518996163E7b313aD21D1C9fCC7BA1afc` |
| Bonzo DataProvider | `0x78feDC4D7010E409A0c0c7aF964cc517D3dCde18` |
| Bonzo Oracle | `0xc0Bb4030b55093981700559a0B751DCf7Db03cBB` |
| USDC-HBAR Vault | `0x724F19f52A3E0e9D2881587C997db93f9613B2C7` |
| SaucerSwap V1 Router | `0x00000000000000000000000000000000002E7A5D` |
| HBARX/WHBAR Pair | `0x000000000000000000000000000000000010932C` |
| WHBAR | `0x0000000000000000000000000000000000163B5a` |
| Stader Staking | `0.0.1027588` |
| Stader Undelegation | `0.0.1027587` |
| HBARX Token | `0.0.834116` |

---

## Pre-Submission Checklist

Things to complete before the March 23 deadline that cannot be done in code:

- [ ] **Run `npm run register`** — creates the HCS-10 inbound/outbound topics and writes `.agent-state.json`. Without this the HCS-10 bounty requirement is not verifiable by judges.
- [ ] **Run `npm run smoke-test`** — confirm all 5/5 checks pass on mainnet before submitting. Catches any connectivity issues early.
- [ ] **Push to a public GitHub repo** — judges need a repo link. Run: `gh repo create bonzo-vault-keeper --public --source . --remote origin --push`
- [ ] **Record a short demo video** — 60–90 seconds showing live mainnet data. Suggested flow: (1) dashboard loads — point out live HBARX borrow rate, vault APY, net spread, and "Entry Viable?" metrics; (2) type "hey" — agent gives opening spread read with live numbers; (3) type "compare paths for 500 HBARX" — show dual-path comparison with Stader vs SaucerSwap recommendation; (4) type "enter the strategy with 1000 WHBAR and 50 USDC" — show the agent's full step preview and confirmation prompt; (5) optionally show the HCS-10 badge in the header. Narrate: "all market data is live Hedera mainnet — no hardcoded numbers, no mocks."
- [ ] **Submit the repo + demo URL** to the Apex Hackathon portal before 11:59 PM ET March 23.

---

## Setup Reference

```bash
npm install                # install dependencies
cp .env.example .env       # configure credentials
npm run smoke-test         # verify connectivity (read-only)
npm run register           # one-time: register agent via HOL Standards SDK
npm run serve              # web dashboard at http://localhost:3000
npm run chat               # terminal chat
npm run monitor            # one-shot market check
npm run monitor:watch      # continuous market monitor
npm run build              # compile TypeScript
```

**Environment variables** (see `.env.example`):

| Variable | Required | Description |
|---|---|---|
| `HEDERA_ACCOUNT_ID` | ✅ | e.g. `0.0.12345` |
| `HEDERA_PRIVATE_KEY` | ✅ | ECDSA hex or DER encoded |
| `HEDERA_NETWORK` | ✅ | `mainnet` |
| `ANTHROPIC_API_KEY` | one of | Claude (recommended) |
| `OPENAI_API_KEY` | one of | GPT-4o fallback |
| `HOL_API_KEY` | for registration | Required only for `npm run register` |
| `MONITOR_AUTO_UNWIND` | optional | `true` to auto-exit when HF < 1.5 |

---

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript (strict)
- **AI**: LangChain ReAct + Claude Sonnet (Anthropic) or GPT-4o — configurable
- **Hedera**: `@hashgraph/sdk` · `hedera-agent-kit` · `@bonzofinancelabs/hak-bonzo-plugin`
- **EVM**: `ethers` v6 via Hedera JSON-RPC relay (vault + SaucerSwap)
- **Registration**: `@hashgraphonline/standards-sdk` (HCS-10 / HCS-11)
- **Web**: Express 5 + vanilla HTML/CSS/JS (zero client build step)

---

## Deployment (Docker — planned)

> **Status: not yet implemented.** Notes below capture the design intent for when we circle back to containerization.

### Design decisions to make before writing the Dockerfile

1. **Base image** — `node:20-slim` (smaller than `node:20`) or `node:20-alpine` (smallest, but requires `libc6-compat` for some native deps).  Check whether `@hashgraph/sdk` or `hedera-agent-kit` have native bindings that break on musl before choosing Alpine.

2. **Build stage vs. single stage** — Two-stage is cleaner: `node:20-slim` builder compiles TypeScript (`npm run build`), then a fresh `node:20-slim` runtime copies only `dist/` + `node_modules` + `public/`. Cuts image size significantly.

3. **`.agent-state.json` persistence** — The file is written at registration time and read on every startup. It must survive container restarts.  Mount it as a named volume or bind mount: `-v ./data:/app/data` (move `STATE_FILE` path to `data/agent-state.json`).

4. **Secrets** — All env vars come from `.env`. Pass them with `--env-file .env` or via the host environment; do NOT bake them into the image layer.

5. **Port** — Container exposes `3000`. Map with `-p 3000:3000` or configure `PORT` env var to match the platform's convention (Railway/Render inject `PORT` automatically).

6. **`.dockerignore`** — Must exclude: `.env`, `.env.*`, `.agent-state.json`, `node_modules/`, `.git/`, `*.md` (optional).

7. **Health check** — `HEALTHCHECK CMD curl -f http://localhost:3000/api/health || exit 1` — the `/api/health` endpoint already exists and hits the Bonzo API to confirm connectivity.

### Deployment targets considered

| Platform | Notes |
|---|---|
| **Railway** | Auto-detects `Dockerfile`, injects `PORT`, one-click deploy from GitHub. Best for quick demo. Needs volume for `.agent-state.json`. |
| **Render** | Similar to Railway. Free tier has cold starts (agent would lose gRPC subscriptions on idle). |
| **Fly.io** | Supports persistent volumes natively. More config but most reliable for the long-running gRPC stream. |
| **Self-hosted VPS** | Simplest for production — `docker run` with bind mount. No cold starts. |
