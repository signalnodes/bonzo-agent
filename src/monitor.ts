/**
 * Standalone monitoring script.
 * Run: npm run monitor
 *
 * Fetches current market data and live vault APY, analyzes the HBARX spread strategy.
 * Can run as one-shot or continuous polling mode.
 */

import { fetchMarketData, analyzeSpread } from "./strategy/spread.js";
import { getVaultAPY, getBestAPYEstimate } from "./strategy/vault-apy.js";
import { evaluateEntry, type StrategyConfig } from "./strategy/orchestrator.js";

const POLL_INTERVAL_MS = 60_000; // 1 minute

const DEFAULT_CONFIG: StrategyConfig = {
  collateralToken: "WHBAR",
  collateralAmount: "1000",
  borrowAmountHbarx: "500",
  minSpread: 10,
  maxLeverage: 0.5,
  healthFactorTarget: 2.5,
};

async function runCheck() {
  const market = await fetchMarketData();

  console.log("=== Bonzo Lend Market Data ===");
  console.log(`HBARX Borrow APY:    ${market.hbarxBorrowApy}%`);
  console.log(`HBARX Supply APY:    ${market.hbarxSupplyApy}%`);
  console.log(`HBARX Utilization:   ${market.hbarxUtilization}%`);
  console.log(`HBARX Liquidity:     $${market.hbarxAvailableLiquidity.toLocaleString()}`);
  console.log(`WHBAR Borrow APY:    ${market.whbarBorrowApy}%`);
  console.log(`USDC Borrow APY:     ${market.usdcBorrowApy}%`);

  // Live vault APY from on-chain data
  console.log("\n=== Vault APY (on-chain) ===");
  try {
    const apyResult = await getVaultAPY();
    console.log(`Price Per Share:     ${apyResult.currentPPS}`);
    console.log(`APY (overall):       ${apyResult.apy !== null ? `${apyResult.apy.toFixed(2)}%` : "Accumulating data..."}`);
    console.log(`APY (24h):           ${apyResult.apy24h !== null ? `${apyResult.apy24h.toFixed(2)}%` : "Need ~24h of readings"}`);
    console.log(`APY (7d):            ${apyResult.apy7d !== null ? `${apyResult.apy7d.toFixed(2)}%` : "Need ~7d of readings"}`);
    console.log(`APY (30d):           ${apyResult.apy30d !== null ? `${apyResult.apy30d.toFixed(2)}%` : "Need ~30d of readings"}`);
    console.log(`Readings stored:     ${apyResult.readingCount}`);
  } catch (err) {
    console.log(`Vault APY fetch failed: ${err instanceof Error ? err.message : err}`);
  }

  // Spread analysis using best available APY
  const vaultApy = await getBestAPYEstimate().catch(() => null) ?? 70;
  const apyLabel = vaultApy === 70 ? "70% (fallback estimate)" : `${vaultApy.toFixed(1)}% (live)`;
  const spread = analyzeSpread(market, vaultApy);

  console.log("\n=== Spread Analysis ===");
  console.log(`HBARX Borrow Cost:   ${spread.hbarxBorrowRate}%`);
  console.log(`Vault Yield:         ${apyLabel}`);
  console.log(`Net Spread:          ${spread.netSpread.toFixed(1)}%`);
  console.log(`\n${spread.recommendation}`);

  // Strategy evaluation
  console.log("\n=== Strategy Evaluation ===");
  const evaluation = await evaluateEntry(DEFAULT_CONFIG);
  console.log(`Vault APY Source:    ${evaluation.vaultApySource}`);
  console.log(`Entry Viable:        ${evaluation.viable ? "YES" : "NO"}`);
  for (const reason of evaluation.reasons) {
    console.log(`  - ${reason}`);
  }
}

async function main() {
  const continuous = process.argv.includes("--watch") || process.argv.includes("-w");

  console.log("Bonzo Vault Keeper — Market Monitor");
  console.log(`Mode: ${continuous ? "Continuous (Ctrl+C to stop)" : "One-shot"}\n`);

  await runCheck();

  if (continuous) {
    console.log(`\n--- Polling every ${POLL_INTERVAL_MS / 1000}s ---\n`);
    setInterval(async () => {
      console.log(`\n[${new Date().toISOString()}]\n`);
      try {
        await runCheck();
      } catch (err) {
        console.error(`Check failed: ${err instanceof Error ? err.message : err}`);
      }
    }, POLL_INTERVAL_MS);
  }
}

main().catch(console.error);
