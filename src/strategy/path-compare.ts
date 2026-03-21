/**
 * Path comparison engine for the HBARX → HBAR conversion decision.
 *
 * Fast Mode:    borrow HBARX → swap on SaucerSwap → instant HBAR
 * Max Yield:    borrow HBARX → unstake via Stader → 1-day cooldown → HBAR
 *
 * Uses on-chain getAmountsOut for SaucerSwap quotes (no API key required).
 */

import { ethers } from "ethers";
import { CONTRACTS } from "../config/contracts.js";
import { HEDERA_JSON_RPC } from "../config/constants.js";

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
];

// SaucerSwap V1 fee is 0.3%
const SAUCERSWAP_FEE_PCT = 0.3;

export interface ConversionQuote {
  hbarxAmountIn: number;
  hbarReceived: number;
  effectiveRate: number;      // HBAR per HBARX
  feesAndSlippagePct: number; // total cost as % of input value
  executionDelay: string;
  notes: string[];
}

export interface PathComparison {
  fastMode: ConversionQuote;
  maxYield: ConversionQuote;
  recommendation: "fast" | "maxYield" | "neither";
  rationale: string;
  opportunityCostNote: string;
}

/**
 * Get a live SaucerSwap quote for HBARX → WHBAR via on-chain getAmountsOut.
 * Returns null if the call fails (e.g. no liquidity, RPC issue).
 */
export async function getSaucerSwapQuote(
  hbarxAmount: number,
  spotRate?: number, // HBAR per HBARX from Stader oracle; if omitted falls back to a safe default
): Promise<{ hbarReceived: number; priceImpactPct: number } | null> {
  try {
    const provider = new ethers.JsonRpcProvider(HEDERA_JSON_RPC);
    const router = new ethers.Contract(CONTRACTS.saucerswap.router, ROUTER_ABI, provider);

    const amountIn = BigInt(Math.round(hbarxAmount * 1e8)); // HBARX has 8 decimals
    const path = [CONTRACTS.tokens.HBARX, CONTRACTS.tokens.WHBAR];

    const amounts: bigint[] = await router.getAmountsOut(amountIn, path);
    const hbarOut = Number(amounts[1]) / 1e8; // WHBAR also 8 decimals

    // Price impact = how much worse the swap is vs the Stader redemption rate
    const rate = spotRate ?? 1.37;
    const expectedWithoutSlippage = hbarxAmount * rate;
    const priceImpactPct = ((expectedWithoutSlippage - hbarOut) / expectedWithoutSlippage) * 100;

    return { hbarReceived: hbarOut, priceImpactPct };
  } catch {
    return null;
  }
}

/**
 * Compare Fast Mode (SaucerSwap swap) vs Max Yield Mode (Stader unstake)
 * for a given HBARX amount and current Stader exchange rate.
 */
export async function compareConversionPaths(
  hbarxAmount: number,
  staderExchangeRate: number,  // HBAR per HBARX from Stader oracle
  vaultApyPct: number,         // current vault APY for opportunity cost calc
): Promise<PathComparison> {
  // --- Max Yield Mode (Stader) ---
  // No swap fee, no slippage. But 1-day cooldown delays capital deployment.
  const staderHbarOut = hbarxAmount * staderExchangeRate;
  const dailyVaultReturn = vaultApyPct / 365 / 100;
  const opportunityCostUsd = staderHbarOut * 0.093 * dailyVaultReturn; // approx HBAR price

  const maxYield: ConversionQuote = {
    hbarxAmountIn: hbarxAmount,
    hbarReceived: staderHbarOut,
    effectiveRate: staderExchangeRate,
    feesAndSlippagePct: 0,
    executionDelay: "~24 hours (Stader cooldown)",
    notes: [
      "No swap fee or slippage — receives full Stader redemption value",
      `1-day cooldown delays vault entry by ~${opportunityCostUsd.toFixed(4)} USD in missed vault yield`,
      "Unwind: vault withdraw → stake HBAR→HBARX instantly → repay debt",
    ],
  };

  // --- Fast Mode (SaucerSwap) ---
  const swapQuote = await getSaucerSwapQuote(hbarxAmount, staderExchangeRate);

  let fastMode: ConversionQuote;
  if (swapQuote) {
    const slippageAndFee = ((staderHbarOut - swapQuote.hbarReceived) / staderHbarOut) * 100;
    fastMode = {
      hbarxAmountIn: hbarxAmount,
      hbarReceived: swapQuote.hbarReceived,
      effectiveRate: swapQuote.hbarReceived / hbarxAmount,
      feesAndSlippagePct: Math.max(slippageAndFee, SAUCERSWAP_FEE_PCT),
      executionDelay: "Instant (same block)",
      notes: [
        `SaucerSwap V1 swap fee: ${SAUCERSWAP_FEE_PCT}%`,
        swapQuote.priceImpactPct > 1
          ? `⚠️ Price impact ${swapQuote.priceImpactPct.toFixed(2)}% — consider smaller size`
          : `Price impact: ${swapQuote.priceImpactPct.toFixed(2)}% (acceptable)`,
        "Unwind: vault withdraw → swap HBAR→HBARX on SaucerSwap → repay debt",
      ],
    };
  } else {
    // RPC quote failed — surface the issue rather than guessing
    fastMode = {
      hbarxAmountIn: hbarxAmount,
      hbarReceived: 0,
      effectiveRate: 0,
      feesAndSlippagePct: 0,
      executionDelay: "Instant (same block)",
      notes: ["⚠️ Could not fetch live SaucerSwap quote — do not execute without a fresh quote"],
    };
  }

  // --- Recommendation ---
  let recommendation: PathComparison["recommendation"];
  let rationale: string;

  if (!swapQuote) {
    recommendation = "maxYield";
    rationale = "SaucerSwap quote unavailable. Defaulting to Stader path until quote can be fetched.";
  } else if (swapQuote.priceImpactPct > 3) {
    recommendation = "maxYield";
    rationale = `SaucerSwap price impact is ${swapQuote.priceImpactPct.toFixed(1)}% — too high. Stader gives better value despite the 1-day wait.`;
  } else {
    const hbarDiff = staderHbarOut - swapQuote.hbarReceived;
    const hbarDiffUsd = hbarDiff * 0.093;
    if (hbarDiffUsd < opportunityCostUsd * 0.5) {
      recommendation = "fast";
      rationale = `SaucerSwap costs ~${hbarDiff.toFixed(4)} HBAR (~$${hbarDiffUsd.toFixed(3)}) vs Stader, but saves a 1-day cooldown worth ~$${opportunityCostUsd.toFixed(3)} in missed vault yield. Fast Mode wins.`;
    } else {
      recommendation = "maxYield";
      rationale = `Stader gives ${hbarDiff.toFixed(4)} more HBAR (~$${hbarDiffUsd.toFixed(3)}) than the swap, exceeding the opportunity cost of the 1-day cooldown (~$${opportunityCostUsd.toFixed(3)}). Max Yield Mode wins.`;
    }
  }

  return {
    fastMode,
    maxYield,
    recommendation,
    rationale,
    opportunityCostNote: `Missing vault yield during 1-day Stader cooldown ≈ $${opportunityCostUsd.toFixed(4)} (at ${vaultApyPct.toFixed(0)}% APY on ~$${(staderHbarOut * 0.093).toFixed(2)} deployed)`,
  };
}
