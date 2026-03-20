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

async function main() {
  validateEnv();

  console.log("Bonzo Vault Keeper Agent");
  console.log("========================");
  console.log(`Network: ${env.hedera.network}`);
  console.log(`Account: ${env.hedera.accountId}`);
  console.log("");
  console.log("Available commands:");
  console.log("  npm run monitor  — Check current market rates and spread");
  console.log("  npm run chat     — Start interactive chat agent");
  console.log("");

  // TODO: initialize Hedera Agent Kit and start agent loop
  console.log("Agent initialization coming soon.");
}

main().catch(console.error);
