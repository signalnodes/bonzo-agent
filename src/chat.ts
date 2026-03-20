/**
 * Interactive chat interface for the Bonzo Vault Keeper Agent.
 * Run: npm run chat
 *
 * Provides natural language interaction for:
 * - Checking current spread and rates
 * - Analyzing strategy profitability
 * - Executing strategy steps (borrow, unstake, deposit)
 * - Monitoring position health
 */

import * as readline from "readline";
import { fetchMarketData, analyzeSpread } from "./strategy/spread.js";
import { checkPosition, formatStatus } from "./strategy/monitor.js";

const SYSTEM_PROMPT = `You are the Bonzo Vault Keeper Agent, an AI that helps users execute and manage a leveraged yield strategy on Hedera's Bonzo Finance protocol.

The strategy:
1. Supply collateral (USDC or HBAR) on Bonzo Lend
2. Borrow HBARX at ~0.6% variable rate
3. Unstake HBARX via Stader Labs → receive HBAR (1-day cooldown)
4. Deposit HBAR + USDC into the dual-asset USDC-HBAR vault at ~60-90% APY
5. Monitor health factor and rate spread — unwind if spread narrows

You can help users:
- Check current rates and spread profitability
- Estimate returns for a given position size
- Execute strategy steps
- Monitor existing positions
- Recommend entry/exit timing

Always warn about risks: variable rates, liquidation, impermanent loss, 1-day unstaking cooldown.
Never give financial advice — present data and let the user decide.`;

async function handleCommand(input: string): Promise<string> {
  const cmd = input.trim().toLowerCase();

  if (cmd === "rates" || cmd === "spread" || cmd === "status") {
    const market = await fetchMarketData();
    const spread = analyzeSpread(market, 60); // TODO: live vault APY
    return [
      `HBARX Borrow Rate: ${market.hbarxBorrowApy}%`,
      `Estimated Vault APY: 60% (placeholder)`,
      `Net Spread: ${spread.netSpread.toFixed(1)}%`,
      ``,
      spread.recommendation,
    ].join("\n");
  }

  if (cmd === "health") {
    const status = await checkPosition("", 60);
    return formatStatus(status);
  }

  if (cmd === "help") {
    return [
      "Available commands:",
      "  rates / spread  — Show current rates and spread analysis",
      "  health          — Check position health and alerts",
      "  help            — Show this message",
      "  quit            — Exit",
      "",
      "Or ask any question in natural language (LLM integration coming soon).",
    ].join("\n");
  }

  // TODO: route to LangChain agent for natural language queries
  return "Natural language processing coming soon. Try: rates, health, or help";
}

async function main() {
  console.log("Bonzo Vault Keeper Agent — Interactive Chat");
  console.log("============================================");
  console.log('Type "help" for available commands, "quit" to exit.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("you> ", async (input) => {
      if (input.trim().toLowerCase() === "quit") {
        console.log("Goodbye.");
        rl.close();
        return;
      }

      try {
        const response = await handleCommand(input);
        console.log(`\nagent> ${response}\n`);
      } catch (err) {
        console.error(`\nError: ${err instanceof Error ? err.message : err}\n`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);
