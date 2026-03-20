/**
 * Bonzo Vault Keeper Agent
 *
 * AI-powered DeFi agent that executes a leveraged yield strategy on Hedera:
 * 1. Supply collateral on Bonzo Lend
 * 2. Borrow HBARX at low rates (~0.6%)
 * 3. Unstake HBARX via Stader → receive HBAR
 * 4. Deposit HBAR + USDC into high-yield dual-asset vault (~60-90% APY)
 * 5. Monitor and manage the position
 */

import { validateEnv, env } from "./config/env.js";
import { createAgent } from "./agent/setup.js";
import { isRegistered } from "./agent/state.js";
import { startHCS10Listener } from "./agent/hcs10.js";
import { evaluateEntry, type StrategyConfig } from "./strategy/orchestrator.js";

const DEFAULT_CONFIG: StrategyConfig = {
  collateralToken: "WHBAR",
  collateralAmount: "1000",
  borrowAmountHbarx: "500",
  minSpread: 10,
  maxLeverage: 0.5,
  healthFactorTarget: 2.5,
};

async function main() {
  validateEnv();

  console.log("Bonzo Vault Keeper Agent");
  console.log("========================");
  console.log(`Network: ${env.hedera.network}`);
  console.log(`Account: ${env.hedera.accountId}`);
  console.log("");

  // Quick market check
  console.log("Checking market conditions...\n");
  try {
    const evaluation = await evaluateEntry(DEFAULT_CONFIG);
    console.log(`HBARX Borrow Rate: ${evaluation.market.hbarxBorrowApy}%`);
    console.log(`Net Spread: ${evaluation.spread.netSpread.toFixed(1)}%`);
    console.log(`Entry Viable: ${evaluation.viable ? "YES" : "NO"}`);
    for (const reason of evaluation.reasons) {
      console.log(`  - ${reason}`);
    }
  } catch (err) {
    console.log(`Market check failed: ${err instanceof Error ? err.message : err}`);
  }

  console.log("");

  // Initialize agent
  console.log("Initializing LangChain agent...");
  const agentResult = await createAgent();
  console.log(`Agent ready with ${agentResult.config.toolCount} tools (${agentResult.config.modelName}).`);

  // Start HCS-10 listener if registered
  if (isRegistered()) {
    console.log("\nStarting HCS-10 message listener...");
    const hcs10 = await startHCS10Listener(agentResult);

    // Keep alive
    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      hcs10.stop();
      process.exit(0);
    });

    console.log("\nAgent is running. Listening for HCS-10 messages.");
    console.log("Press Ctrl+C to stop.\n");
  } else {
    console.log("\nAgent is not registered with HCS-10.");
    console.log("Run `npm run register` to register, then restart.\n");
    console.log("Available commands:");
    console.log("  npm run chat      — Start interactive chat agent");
    console.log("  npm run monitor   — Check current market rates and spread");
    console.log("  npm run register  — Register agent via HOL Standards SDK");
  }
}

main().catch(console.error);
