/**
 * Background monitoring loop for the Bonzo Vault Keeper agent.
 *
 * Periodically checks market conditions, records vault PPS readings,
 * evaluates whether active positions should be unwound, and emits alerts
 * that can be consumed by the web UI (SSE) or HCS-10 handler.
 */

import { EventEmitter } from "node:events";
import {
  fetchMarketData,
  analyzeSpread,
  fetchHealthFactor,
  type MarketData,
} from "../strategy/spread.js";
import { getBestAPYEstimate, recordPPSReading } from "../strategy/vault-apy.js";
import {
  evaluateExit,
  type StrategyConfig,
  type StrategyState,
} from "../strategy/orchestrator.js";
import { loadState } from "./state.js";
import { env } from "../config/env.js";
import {
  HEALTH_FACTOR_CRITICAL,
  HEALTH_FACTOR_WARNING,
  BORROW_RATE_CHANGE_THRESHOLD,
  VAULT_APY_WARNING_THRESHOLD,
  UTILIZATION_WARNING_THRESHOLD,
  MONITOR_INTERVAL_MS,
  MAX_ALERTS,
} from "../config/constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Alert {
  id: string;
  timestamp: Date;
  level: "info" | "warning" | "critical";
  title: string;
  message: string;
}

export interface MonitorStatus {
  running: boolean;
  lastCheck: Date | null;
  checkCount: number;
  alerts: Alert[];
  latestMarket: MarketData | null;
  latestVaultApy: number | null;
  latestSpread: number | null;
  latestHealthFactor: number | null;
}

const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  collateralToken: "WHBAR",
  collateralAmount: "0",
  borrowAmountHbarx: "0",
  minSpread: 10,
  maxLeverage: 0.5,
  healthFactorTarget: 2.5,
};

// ---------------------------------------------------------------------------
// MonitorLoop
// ---------------------------------------------------------------------------

export class MonitorLoop extends EventEmitter {
  private intervalMs: number;
  private strategyConfig: StrategyConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastCheck: Date | null = null;
  private checkCount = 0;
  private alerts: Alert[] = [];
  private latestMarket: MarketData | null = null;
  private latestVaultApy: number | null = null;
  private latestSpread: number | null = null;
  private latestHealthFactor: number | null = null;
  private lastBorrowRate: number | null = null;
  private ppsReadingCount = 0;

  constructor(config?: { intervalMs?: number; strategyConfig?: StrategyConfig }) {
    super();
    this.intervalMs = config?.intervalMs ?? MONITOR_INTERVAL_MS;
    this.strategyConfig = config?.strategyConfig ?? DEFAULT_STRATEGY_CONFIG;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;

    // Run immediately on start, then on interval
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);

    this.emitStatus();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.emitStatus();
  }

  getStatus(): MonitorStatus {
    return {
      running: this.running,
      lastCheck: this.lastCheck,
      checkCount: this.checkCount,
      alerts: [...this.alerts],
      latestMarket: this.latestMarket,
      latestVaultApy: this.latestVaultApy,
      latestSpread: this.latestSpread,
      latestHealthFactor: this.latestHealthFactor,
    };
  }

  getAlerts(): Alert[] {
    return [...this.alerts];
  }

  clearAlerts(): void {
    this.alerts = [];
    this.emitStatus();
  }

  // -------------------------------------------------------------------------
  // Core loop
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    try {
      await this.runCheck();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.addAlert("warning", "Monitor check failed", message);
    }

    this.lastCheck = new Date();
    this.checkCount++;
    this.emitStatus();
  }

  private async runCheck(): Promise<void> {
    // 1. Fetch market data
    const market = await fetchMarketData();
    this.latestMarket = market;

    // 2. Check for significant borrow rate change
    if (this.lastBorrowRate !== null) {
      const delta = Math.abs(market.hbarxBorrowApy - this.lastBorrowRate);
      if (delta > BORROW_RATE_CHANGE_THRESHOLD) {
        this.addAlert(
          "info",
          "HBARX borrow rate changed",
          `HBARX borrow rate moved from ${this.lastBorrowRate.toFixed(2)}% to ${market.hbarxBorrowApy.toFixed(2)}% (${delta > 0 ? "+" : ""}${(market.hbarxBorrowApy - this.lastBorrowRate).toFixed(2)}pp).`,
        );
      }
    }
    this.lastBorrowRate = market.hbarxBorrowApy;

    // 3. HBARX utilization warning
    if (market.hbarxUtilization > UTILIZATION_WARNING_THRESHOLD) {
      this.addAlert(
        "warning",
        "High HBARX utilization",
        `HBARX utilization is ${market.hbarxUtilization.toFixed(1)}% — borrow rates may spike.`,
      );
    }

    // 4. Record vault PPS reading
    let vaultApy: number | null = null;
    try {
      await recordPPSReading();
      this.ppsReadingCount++;

      // Log every 10th reading
      if (this.ppsReadingCount % 10 === 0) {
        this.addAlert(
          "info",
          "Vault PPS recorded",
          `Recorded PPS reading #${this.ppsReadingCount}.`,
        );
      }
    } catch {
      // PPS recording is best-effort; vault may be unreachable
    }

    // 5. Fetch vault APY estimate
    try {
      vaultApy = await getBestAPYEstimate();
      this.latestVaultApy = vaultApy;

      if (vaultApy !== null && vaultApy < VAULT_APY_WARNING_THRESHOLD) {
        this.addAlert(
          "warning",
          "Vault APY dropped",
          `Vault APY is ${vaultApy.toFixed(1)}% — below the ${VAULT_APY_WARNING_THRESHOLD}% threshold.`,
        );
      }
    } catch {
      // APY estimation is best-effort
    }

    // 6. Compute spread
    const effectiveVaultApy = vaultApy ?? 70; // fallback estimate
    const spread = analyzeSpread(market, effectiveVaultApy);
    this.latestSpread = spread.netSpread;

    if (spread.netSpread < this.strategyConfig.minSpread) {
      this.addAlert(
        "warning",
        "Spread below threshold",
        `Net spread is ${spread.netSpread.toFixed(1)}% — below the minimum of ${this.strategyConfig.minSpread}%.`,
      );
    }

    // 7. Check position health — always fetch so the dashboard shows the live
    // health factor regardless of whether strategy state has been explicitly tracked.
    const agentState = loadState();
    const strategyState = agentState.strategy;

    await this.checkPositionHealth(strategyState ?? null, agentState.accountId);
  }

  private async checkPositionHealth(
    state: StrategyState | null,
    accountId?: string,
  ): Promise<void> {
    // Fetch health factor if we have an account
    const effectiveAccountId = accountId || env.hedera.accountId;
    if (effectiveAccountId) {
      try {
        const hf = await fetchHealthFactor(effectiveAccountId);
        if (hf !== null) {
          this.latestHealthFactor = hf;
          if (hf < HEALTH_FACTOR_CRITICAL) {
            this.addAlert(
              "critical",
              "Health factor critical",
              `Health factor is ${hf.toFixed(2)} — below ${HEALTH_FACTOR_CRITICAL}. Liquidation risk is imminent. Consider unwinding immediately.`,
            );
          } else if (hf < HEALTH_FACTOR_WARNING) {
            this.addAlert(
              "warning",
              "Health factor low",
              `Health factor is ${hf.toFixed(2)} — below the ${HEALTH_FACTOR_WARNING} warning threshold.`,
            );
          }
        }
      } catch {
        // Health factor check is best-effort
      }
    }

    // Evaluate exit conditions via the orchestrator (only when strategy is active)
    if (!state) return;
    try {
      const exitEval = await evaluateExit(state, this.strategyConfig);
      if (exitEval.shouldExit) {
        const level = exitEval.urgency === "critical" ? "critical" : "warning";
        this.addAlert(
          level,
          `Position unwind recommended (${exitEval.urgency})`,
          exitEval.reasons.join(" "),
        );
      }
    } catch {
      // Exit evaluation is best-effort
    }
  }

  // -------------------------------------------------------------------------
  // Alert management
  // -------------------------------------------------------------------------

  private addAlert(level: Alert["level"], title: string, message: string): void {
    const alert: Alert = {
      id: Date.now().toString(36),
      timestamp: new Date(),
      level,
      title,
      message,
    };

    this.alerts.push(alert);

    // Trim to last MAX_ALERTS
    if (this.alerts.length > MAX_ALERTS) {
      this.alerts = this.alerts.slice(-MAX_ALERTS);
    }

    this.emit("alert", alert);
  }

  private emitStatus(): void {
    this.emit("status", this.getStatus());
  }
}
