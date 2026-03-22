/**
 * Read-only smoke test — no transactions sent.
 * Tests: Bonzo API, Stader exchange rate, SaucerSwap quote, path comparison.
 */

import "dotenv/config";
import { Client, AccountId, PrivateKey } from "@hashgraph/sdk";
import { fetchMarketData, analyzeSpread, type MarketData } from "./strategy/spread.js";
import { getExchangeRate } from "./tools/stader-unstake.js";
import { getSaucerSwapQuote, compareConversionPaths } from "./strategy/path-compare.js";
import { getBestAPYEstimate } from "./strategy/vault-apy.js";

const HBARX_TEST_AMOUNT = 10; // tiny amount for quote test

function parsePrivateKey(k: string) {
  if (/^[0-9a-fA-F]{64}$/.test(k)) {
    try { return PrivateKey.fromStringECDSA(k); } catch {}
    return PrivateKey.fromStringED25519(k);
  }
  try { return PrivateKey.fromStringDer(k); } catch {}
  return PrivateKey.fromStringECDSA(k);
}

async function run() {
  const accountId = process.env.HEDERA_ACCOUNT_ID!;
  const privateKey = process.env.HEDERA_PRIVATE_KEY!;

  const client = Client.forMainnet();
  client.setOperator(AccountId.fromString(accountId), parsePrivateKey(privateKey));

  console.log("=== Bonzo Vault Keeper — Smoke Test ===\n");

  let passed = 0;
  let failed = 0;
  let market: MarketData | null = null;

  function ok(label: string) {
    console.log(`   ✓ ${label}\n`);
    passed++;
  }
  function fail(label: string, err: unknown) {
    console.error(`   ✗ ${label}: ${err instanceof Error ? err.message : err}\n`);
    failed++;
  }

  // 1. Bonzo market data
  console.log("1. Bonzo Lend market data...");
  try {
    market = await fetchMarketData();
    console.log(`   HBARX borrow APY : ${market.hbarxBorrowApy.toFixed(3)}%`);
    console.log(`   HBARX utilization: ${market.hbarxUtilization.toFixed(1)}%`);
    console.log(`   HBAR price (USD)  : $${market.hbarPriceUsd.toFixed(4)}`);
    console.log(`   HBARX price (USD) : $${market.hbarxPriceUsd.toFixed(4)}`);
    console.log(`   WHBAR borrow APY  : ${market.whbarBorrowApy.toFixed(3)}%`);
    const spread = analyzeSpread(market, 70);
    console.log(`   Net spread (vs 70% vault APY): ${spread.netSpread.toFixed(1)}%`);
    console.log(`   Viable: ${spread.isPositive}`);
    ok("Bonzo API");
  } catch (e) {
    fail("Bonzo API", e);
  }

  // 2. Stader exchange rate
  console.log("2. Stader HBARX exchange rate...");
  let staderRate = 1.37;
  try {
    staderRate = await getExchangeRate(client);
    console.log(`   1 HBARX = ${staderRate.toFixed(6)} HBAR`);
    ok("Stader exchange rate");
  } catch (e) {
    fail("Stader exchange rate", e);
  }

  // 3. SaucerSwap quote
  console.log(`3. SaucerSwap quote for ${HBARX_TEST_AMOUNT} HBARX...`);
  try {
    const quote = await getSaucerSwapQuote(HBARX_TEST_AMOUNT, staderRate);
    if (quote) {
      console.log(`   HBAR received  : ${quote.hbarReceived.toFixed(4)}`);
      console.log(`   Price impact   : ${quote.priceImpactPct.toFixed(3)}%`);
      ok("SaucerSwap quote");
    } else {
      fail("SaucerSwap quote", "null quote — RPC unreachable or no liquidity");
    }
  } catch (e) {
    fail("SaucerSwap quote", e);
  }

  // 4. Full path comparison
  console.log(`4. Path comparison for ${HBARX_TEST_AMOUNT} HBARX (vault APY=70%)...`);
  try {
    const cmp = await compareConversionPaths(HBARX_TEST_AMOUNT, staderRate, 70, market?.hbarPriceUsd);
    console.log(`   Recommendation : ${cmp.recommendation}`);
    console.log(`   Rationale      : ${cmp.rationale}`);
    console.log(`   Fast Mode HBAR : ${cmp.fastMode.hbarReceived.toFixed(4)}`);
    console.log(`   MaxYield HBAR  : ${cmp.maxYield.hbarReceived.toFixed(4)}`);
    ok("Path comparison");
  } catch (e) {
    fail("Path comparison", e);
  }

  // 5. Vault APY (ethers.js RPC + on-chain PPS read)
  console.log("5. Vault APY from on-chain data...");
  try {
    const apy = await getBestAPYEstimate();
    if (apy !== null) {
      console.log(`   Best APY estimate: ${apy.toFixed(2)}%`);
      ok("Vault APY (live)");
    } else {
      console.log("   No historical data yet — first reading stored.");
      ok("Vault APY (first reading recorded)");
    }
  } catch (e) {
    fail("Vault APY", e);
  }

  client.close();

  const total = passed + failed;
  console.log("━".repeat(40));
  if (failed === 0) {
    console.log(`  ✓ All ${total}/${total} checks passed — ready to submit`);
  } else {
    console.log(`  ${passed}/${total} checks passed — ${failed} failed (see above)`);
    process.exit(1);
  }
  console.log("━".repeat(40));
}

run().catch(e => { console.error(e); process.exit(1); });
