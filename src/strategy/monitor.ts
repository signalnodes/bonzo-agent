import { fetchMarketData, analyzeSpread, fetchHealthFactor, type SpreadAnalysis, type MarketData } from "./spread.js";
import {
  HEALTH_FACTOR_CRITICAL,
  HEALTH_FACTOR_WARNING,
  UTILIZATION_WARNING_THRESHOLD,
} from "../config/constants.js";

export interface PositionStatus {
  market: MarketData;
  spread: SpreadAnalysis;
  healthFactor: number | null;
  alerts: string[];
  timestamp: Date;
}

/**
 * Run a full position health check.
 * Returns current market state, spread analysis, health factor, and any alerts.
 */
export async function checkPosition(
  accountId: string,
  currentVaultApy: number
): Promise<PositionStatus> {
  const alerts: string[] = [];

  const [market, healthFactor] = await Promise.all([
    fetchMarketData(),
    fetchHealthFactor(accountId),
  ]);
  const spread = analyzeSpread(market, currentVaultApy);

  // Health factor alerts
  if (healthFactor !== null) {
    if (healthFactor < HEALTH_FACTOR_CRITICAL) {
      alerts.push(
        `CRITICAL: Health factor is ${healthFactor.toFixed(2)} — liquidation risk! Consider repaying debt or adding collateral immediately.`
      );
    } else if (healthFactor < HEALTH_FACTOR_WARNING) {
      alerts.push(
        `WARNING: Health factor is ${healthFactor.toFixed(2)} — approaching danger zone. Monitor closely.`
      );
    }
  }

  // Spread alerts
  if (!spread.isPositive) {
    alerts.push(
      `WARNING: Spread has narrowed to ${spread.netSpread.toFixed(1)}%. Consider unwinding position.`
    );
  }

  // HBARX utilization alerts (high utilization = rising borrow rates)
  if (market.hbarxUtilization > UTILIZATION_WARNING_THRESHOLD) {
    alerts.push(
      `NOTICE: HBARX utilization at ${market.hbarxUtilization.toFixed(1)}% — borrow rates may increase.`
    );
  }

  return {
    market,
    spread,
    healthFactor,
    alerts,
    timestamp: new Date(),
  };
}

/**
 * Format position status for display / chat response.
 */
export function formatStatus(status: PositionStatus): string {
  const lines: string[] = [
    `--- Position Status (${status.timestamp.toISOString()}) ---`,
    "",
    `HBARX Borrow Rate: ${status.market.hbarxBorrowApy.toFixed(3)}%`,
    `Vault APY: ${status.spread.vaultApy.toFixed(1)}%`,
    `Net Spread: ${status.spread.netSpread.toFixed(1)}%`,
    "",
  ];

  if (status.healthFactor !== null) {
    lines.push(`Health Factor: ${status.healthFactor.toFixed(2)}`);
  }

  lines.push(`HBARX Utilization: ${status.market.hbarxUtilization.toFixed(1)}%`);
  lines.push(`HBARX Available Liquidity: $${status.market.hbarxAvailableLiquidity.toLocaleString()}`);
  lines.push("");
  lines.push(`Recommendation: ${status.spread.recommendation}`);

  if (status.alerts.length > 0) {
    lines.push("");
    lines.push("ALERTS:");
    for (const alert of status.alerts) {
      lines.push(`  - ${alert}`);
    }
  }

  return lines.join("\n");
}
