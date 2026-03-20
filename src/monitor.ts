/**
 * Standalone monitoring script.
 * Run: npm run monitor
 *
 * Fetches current market data and analyzes the HBARX spread strategy.
 * Useful for quick checks without spinning up the full agent.
 */

import { fetchMarketData, analyzeSpread } from "./strategy/spread.js";

async function main() {
  console.log("Fetching Bonzo Lend market data...\n");

  const market = await fetchMarketData();

  console.log("=== Bonzo Lend Market Data ===");
  console.log(`HBARX Borrow APY:    ${market.hbarxBorrowApy}%`);
  console.log(`HBARX Supply APY:    ${market.hbarxSupplyApy}%`);
  console.log(`HBARX Utilization:   ${market.hbarxUtilization}%`);
  console.log(`HBARX Liquidity:     $${market.hbarxAvailableLiquidity.toLocaleString()}`);
  console.log(`WHBAR Borrow APY:    ${market.whbarBorrowApy}%`);
  console.log(`USDC Borrow APY:     ${market.usdcBorrowApy}%`);

  // Use a placeholder vault APY — in production this comes from vault contract
  // TODO: fetch real vault APY from on-chain or Bonzo vault API
  const estimatedVaultApy = 60;
  console.log(`\nUsing estimated vault APY: ${estimatedVaultApy}% (update with live data)`);

  const spread = analyzeSpread(market, estimatedVaultApy);

  console.log("\n=== Spread Analysis ===");
  console.log(`HBARX Borrow Cost:   ${spread.hbarxBorrowRate}%`);
  console.log(`Vault Yield:         ${spread.vaultApy}%`);
  console.log(`Net Spread:          ${spread.netSpread.toFixed(1)}%`);
  console.log(`\n${spread.recommendation}`);
}

main().catch(console.error);
