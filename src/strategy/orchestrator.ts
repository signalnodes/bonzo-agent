import {
  fetchMarketData,
  analyzeSpread,
  type MarketData,
  type SpreadAnalysis,
} from "../strategy/spread.js";
import {
  checkPosition,
  formatStatus,
  type PositionStatus,
} from "../strategy/monitor.js";
import { CONTRACTS } from "../config/contracts.js";
import {
  HEALTH_FACTOR_CRITICAL,
  HEALTH_FACTOR_WARNING,
  DEFAULT_VAULT_APY,
  UNSTAKE_COOLDOWN_MS,
} from "../config/constants.js";
import { getBestAPYEstimate } from "./vault-apy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StrategyConfig {
  collateralToken: "WHBAR" | "USDC";
  collateralAmount: string; // human-readable amount
  borrowAmountHbarx: string;
  minSpread: number; // minimum acceptable spread %
  maxLeverage: number; // max LTV ratio
  healthFactorTarget: number; // target health factor (e.g. 2.5)
}

export interface StrategyState {
  phase:
    | "idle"
    | "collateral_supplied"
    | "hbarx_borrowed"
    | "unstaking"
    | "vault_deposited"
    | "unwinding";
  collateralTx?: string;
  borrowTx?: string;
  unstakeInitiated?: Date;
  unstakeReady?: boolean;
  vaultDepositTx?: string;
  vaultShares?: string;
  lastHealthCheck?: Date;
  healthFactor?: number;
  currentSpread?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Entry evaluation
// ---------------------------------------------------------------------------

/**
 * Check whether current market conditions are favorable for entering the
 * leveraged yield strategy.
 *
 * Returns the spread analysis, raw market data, and human-readable reasons.
 */
export async function evaluateEntry(config: StrategyConfig): Promise<{
  viable: boolean;
  spread: SpreadAnalysis;
  market: MarketData;
  reasons: string[];
  vaultApySource: "live" | "fallback";
}> {
  const market = await fetchMarketData();

  // Try live vault APY, fall back to estimate
  let vaultApy = DEFAULT_VAULT_APY;
  let vaultApySource: "live" | "fallback" = "fallback";
  try {
    const liveApy = await getBestAPYEstimate();
    if (liveApy !== null && liveApy > 0) {
      vaultApy = liveApy;
      vaultApySource = "live";
    }
  } catch {
    // Fall through to default
  }

  const spread = analyzeSpread(market, vaultApy);
  const reasons: string[] = [];
  let viable = true;

  // Spread check
  if (spread.netSpread < config.minSpread) {
    viable = false;
    reasons.push(
      `Net spread (${spread.netSpread.toFixed(1)}%) is below the minimum threshold of ${config.minSpread}%.`
    );
  } else {
    reasons.push(
      `Net spread is ${spread.netSpread.toFixed(1)}% (above ${config.minSpread}% minimum).`
    );
  }

  // Liquidity check — make sure enough HBARX is available to borrow
  const borrowAmountUsd = parseFloat(config.borrowAmountHbarx);
  if (market.hbarxAvailableLiquidity < borrowAmountUsd * 0.5) {
    viable = false;
    reasons.push(
      `HBARX available liquidity ($${market.hbarxAvailableLiquidity.toLocaleString()}) may be insufficient for the requested borrow.`
    );
  } else {
    reasons.push(
      `HBARX available liquidity is $${market.hbarxAvailableLiquidity.toLocaleString()}.`
    );
  }

  // Utilization check — high utilization means borrow rates will climb
  if (market.hbarxUtilization > 60) {
    viable = false;
    reasons.push(
      `HBARX utilization is ${market.hbarxUtilization.toFixed(1)}% — borrow rates are likely to spike.`
    );
  } else if (market.hbarxUtilization > 40) {
    reasons.push(
      `HBARX utilization at ${market.hbarxUtilization.toFixed(1)}% — moderate, keep an eye on it.`
    );
  } else {
    reasons.push(
      `HBARX utilization is low at ${market.hbarxUtilization.toFixed(1)}%.`
    );
  }

  // Borrow rate sanity check
  if (market.hbarxBorrowApy > 5) {
    viable = false;
    reasons.push(
      `HBARX borrow rate (${market.hbarxBorrowApy.toFixed(2)}%) is above 5% — too expensive.`
    );
  }

  // Overall recommendation
  reasons.push(spread.recommendation);

  return { viable, spread, market, reasons, vaultApySource };
}

// ---------------------------------------------------------------------------
// Exit evaluation
// ---------------------------------------------------------------------------

/**
 * Determine whether the current position should be unwound, and how urgent
 * the exit is.
 */
export async function evaluateExit(
  state: StrategyState,
  config: StrategyConfig
): Promise<{
  shouldExit: boolean;
  urgency: "none" | "low" | "medium" | "high" | "critical";
  reasons: string[];
}> {
  const reasons: string[] = [];
  let urgency: "none" | "low" | "medium" | "high" | "critical" = "none";
  let shouldExit = false;

  // Nothing to exit if we're idle
  if (state.phase === "idle") {
    return { shouldExit: false, urgency: "none", reasons: ["No active position."] };
  }

  // Health factor checks (use cached value first, refresh if stale)
  if (state.healthFactor !== undefined) {
    if (state.healthFactor < HEALTH_FACTOR_CRITICAL) {
      shouldExit = true;
      urgency = "critical";
      reasons.push(
        `Health factor is ${state.healthFactor.toFixed(2)} — below critical threshold of ${HEALTH_FACTOR_CRITICAL}. Liquidation imminent.`
      );
    } else if (state.healthFactor < HEALTH_FACTOR_WARNING) {
      shouldExit = true;
      urgency = maxUrgency(urgency, "high");
      reasons.push(
        `Health factor is ${state.healthFactor.toFixed(2)} — below warning threshold of ${HEALTH_FACTOR_WARNING}.`
      );
    } else if (state.healthFactor < config.healthFactorTarget) {
      urgency = maxUrgency(urgency, "medium");
      reasons.push(
        `Health factor (${state.healthFactor.toFixed(2)}) is below target of ${config.healthFactorTarget}.`
      );
    }
  }

  // Spread checks
  if (state.currentSpread !== undefined) {
    if (state.currentSpread < 0) {
      shouldExit = true;
      urgency = maxUrgency(urgency, "high");
      reasons.push(
        `Spread is negative (${state.currentSpread.toFixed(1)}%). Strategy is losing money.`
      );
    } else if (state.currentSpread < config.minSpread) {
      shouldExit = true;
      urgency = maxUrgency(urgency, "medium");
      reasons.push(
        `Spread (${state.currentSpread.toFixed(1)}%) has fallen below minimum threshold of ${config.minSpread}%.`
      );
    }
  }

  // Fetch fresh market data for a live check if we have no cached spread
  if (state.currentSpread === undefined) {
    try {
      const market = await fetchMarketData();
      const liveApy = await getBestAPYEstimate().catch(() => null);
      const spread = analyzeSpread(market, liveApy ?? DEFAULT_VAULT_APY);
      if (spread.netSpread < config.minSpread) {
        shouldExit = true;
        urgency = maxUrgency(urgency, "medium");
        reasons.push(
          `Live spread (${spread.netSpread.toFixed(1)}%) is below minimum threshold of ${config.minSpread}%.`
        );
      }
    } catch {
      reasons.push("Unable to fetch live market data for spread check.");
    }
  }

  if (!shouldExit) {
    reasons.push("Position looks healthy. No exit required.");
  }

  return { shouldExit, urgency, reasons };
}

// ---------------------------------------------------------------------------
// Strategy status formatting
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable summary of the current strategy state suitable for
 * display in the chat interface.
 */
export function formatStrategyStatus(
  state: StrategyState,
  config: StrategyConfig
): string {
  const lines: string[] = [
    "=== Bonzo Vault Keeper — Strategy Status ===",
    "",
    `Phase: ${phaseLabel(state.phase)}`,
    `Collateral: ${config.collateralAmount} ${config.collateralToken}`,
    `HBARX Borrowed: ${config.borrowAmountHbarx}`,
  ];

  if (state.collateralTx) {
    lines.push(`Collateral Tx: ${state.collateralTx}`);
  }
  if (state.borrowTx) {
    lines.push(`Borrow Tx: ${state.borrowTx}`);
  }

  // Unstaking info
  if (state.unstakeInitiated) {
    const readyAt = new Date(state.unstakeInitiated.getTime() + UNSTAKE_COOLDOWN_MS);
    const now = new Date();
    if (now >= readyAt || state.unstakeReady) {
      lines.push("Unstake: READY to claim HBAR");
    } else {
      const remaining = readyAt.getTime() - now.getTime();
      const hours = Math.ceil(remaining / (60 * 60 * 1000));
      lines.push(`Unstake: cooling down (~${hours}h remaining)`);
    }
  }

  if (state.vaultDepositTx) {
    lines.push(`Vault Deposit Tx: ${state.vaultDepositTx}`);
  }
  if (state.vaultShares) {
    lines.push(`Vault Shares: ${state.vaultShares}`);
  }

  lines.push("");

  // Health & spread
  if (state.healthFactor !== undefined) {
    lines.push(`Health Factor: ${state.healthFactor.toFixed(2)}`);
  }
  if (state.currentSpread !== undefined) {
    lines.push(`Current Spread: ${state.currentSpread.toFixed(1)}%`);
  }

  lines.push(`Min Spread Threshold: ${config.minSpread}%`);
  lines.push(`Health Factor Target: ${config.healthFactorTarget}`);
  lines.push(`Max Leverage (LTV): ${config.maxLeverage}`);

  if (state.lastHealthCheck) {
    lines.push(`Last Check: ${state.lastHealthCheck.toISOString()}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Step generators
// ---------------------------------------------------------------------------

/**
 * Return ordered, human-readable instructions that the agent should follow
 * (executing each via the appropriate Hedera Agent Kit tool) to enter the
 * leveraged yield strategy.
 */
export function getEntrySteps(config: StrategyConfig): string[] {
  const collateralAddr =
    config.collateralToken === "WHBAR"
      ? CONTRACTS.tokens.WHBAR
      : CONTRACTS.tokens.USDC;

  return [
    `1. Approve ${config.collateralAmount} ${config.collateralToken} (${collateralAddr}) for the Bonzo LendingPool (${CONTRACTS.lend.lendingPool}).`,

    `2. Supply ${config.collateralAmount} ${config.collateralToken} as collateral on Bonzo Lend via the LendingPool deposit function.`,

    `3. Borrow ${config.borrowAmountHbarx} HBARX (${CONTRACTS.tokens.HBARX}) at the variable rate from Bonzo Lend. Ensure health factor stays above ${config.healthFactorTarget}.`,

    `4. Initiate HBARX unstake via Stader Labs to convert borrowed HBARX into HBAR. Note: 1-day cooldown applies.`,

    `5. (After cooldown) Claim unstaked HBAR from Stader.`,

    `6. Approve USDC (${CONTRACTS.tokens.USDC}) for the Bonzo Vault (${CONTRACTS.vaults.usdcHbar}).`,

    `7. Call BonzoVaultConcLiq.deposit(_amount0, _amount1, _minShares) on the USDC-HBAR vault, sending HBAR as msg.value. Use previewDeposit() first to check proportions.`,

    `8. Record vault share balance and begin monitoring health factor + spread.`,
  ];
}

/**
 * Return ordered, human-readable instructions for unwinding the position.
 * Steps depend on which phase the strategy is currently in.
 */
export function getExitSteps(state: StrategyState): string[] {
  const steps: string[] = [];
  let stepNum = 1;

  // Vault exit (if we have vault shares)
  if (
    state.phase === "vault_deposited" ||
    state.phase === "unwinding"
  ) {
    steps.push(
      `${stepNum++}. Withdraw all shares from the Bonzo USDC-HBAR vault to receive HBAR + USDC.`
    );
  }

  // If we're in unstaking phase, need to wait for claim
  if (state.phase === "unstaking") {
    if (!state.unstakeReady) {
      steps.push(
        `${stepNum++}. Wait for HBARX unstake cooldown to complete, then claim HBAR.`
      );
    } else {
      steps.push(
        `${stepNum++}. Claim unstaked HBAR from Stader.`
      );
    }
  }

  // Swap received HBAR back to HBARX to repay borrow (if we borrowed)
  if (
    state.phase === "hbarx_borrowed" ||
    state.phase === "unstaking" ||
    state.phase === "vault_deposited" ||
    state.phase === "unwinding"
  ) {
    steps.push(
      `${stepNum++}. Stake HBAR back into HBARX via Stader (or acquire HBARX via swap) to repay the borrow.`
    );
    steps.push(
      `${stepNum++}. Repay HBARX borrow on Bonzo Lend via the LendingPool repay function.`
    );
  }

  // Withdraw collateral (if we have collateral supplied)
  if (
    state.phase === "collateral_supplied" ||
    state.phase === "hbarx_borrowed" ||
    state.phase === "unstaking" ||
    state.phase === "vault_deposited" ||
    state.phase === "unwinding"
  ) {
    steps.push(
      `${stepNum++}. Withdraw collateral from Bonzo Lend via the LendingPool withdraw function.`
    );
  }

  steps.push(
    `${stepNum++}. Verify all positions are closed: no outstanding borrows, no remaining collateral, no vault shares.`
  );

  return steps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const URGENCY_RANK: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function maxUrgency(
  a: "none" | "low" | "medium" | "high" | "critical",
  b: "none" | "low" | "medium" | "high" | "critical"
): "none" | "low" | "medium" | "high" | "critical" {
  return (URGENCY_RANK[a] >= URGENCY_RANK[b] ? a : b);
}

function phaseLabel(phase: StrategyState["phase"]): string {
  const labels: Record<StrategyState["phase"], string> = {
    idle: "Idle — no active position",
    collateral_supplied: "Collateral supplied on Bonzo Lend",
    hbarx_borrowed: "HBARX borrowed — ready to unstake",
    unstaking: "HBARX unstaking via Stader (1-day cooldown)",
    vault_deposited: "HBAR + USDC deposited in Bonzo Vault",
    unwinding: "Unwinding position",
  };
  return labels[phase];
}
