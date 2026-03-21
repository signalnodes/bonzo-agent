/**
 * Health factor monitoring engine for Bonzo Vault Keeper.
 *
 * Primary data source: on-chain getUserAccountData via ethers (authoritative).
 * Fallback: Bonzo REST API /dashboard/:accountId endpoint.
 *
 * Poll intervals adapt to health zone:
 *   SAFE     (HF >= 2.0): every 5 minutes
 *   WARN     (HF >= 1.5): every 1 minute
 *   DANGER   (HF >= 1.3): every 30 seconds
 *   CRITICAL (HF <  1.3): every 15 seconds — auto-unwind fires if enabled
 */

import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CONTRACTS } from "../config/contracts.js";
import {
  HEDERA_JSON_RPC,
  HEALTH_FACTOR_WARNING,
  HEALTH_FACTOR_CRITICAL,
  HEALTH_FACTOR_CRITICAL_HARD,
  POLL_SAFE_MS,
  POLL_WARN_MS,
  POLL_DANGER_MS,
  POLL_CRITICAL_MS,
} from "../config/constants.js";
import { fetchHealthFactor } from "./spread.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthZone = "SAFE" | "WARN" | "DANGER" | "CRITICAL";

export interface OnChainPosition {
  /** Collateral value in USD (Bonzo oracle base currency, scaled 1e18 internally) */
  collateralUSD: string;
  debtUSD: string;
  availableBorrowsUSD: string;
  healthFactor: number;
  source: "on-chain" | "api";
}

export interface HealthPollResult {
  timestamp: string;
  zone: HealthZone;
  healthFactor: number | null;
  position: OnChainPosition | null;
  nextPollMs: number;
  shouldAutoUnwind: boolean;
  errors: string[];
}

export interface MonitorState {
  startedAt: string;
  lastPollAt: string | null;
  pollCount: number;
  lastZone: HealthZone | null;
  lastHF: number | null;
  autoUnwindFired: boolean;
  autoUnwindAt: string | null;
}

export interface MonitorConfig {
  /** ECDSA alias (derived from private key) — used for on-chain queries */
  alias: string;
  /** Hedera account ID (e.g. 0.0.12345) — used for REST API fallback */
  accountId: string;
  /** Fire the auto-unwind sequence when zone reaches CRITICAL */
  autoUnwind: boolean;
  /** File path for persisting MonitorState between restarts */
  statePath: string;
}

// ---------------------------------------------------------------------------
// On-chain query
// ---------------------------------------------------------------------------

const LP_ABI = [
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
];

/**
 * Fetch the account's current lending position directly from the LendingPool.
 * Returns null if the call fails (caller should fall back to REST API).
 */
export async function fetchOnChainPosition(alias: string): Promise<OnChainPosition | null> {
  try {
    const provider = new ethers.JsonRpcProvider(HEDERA_JSON_RPC);
    const lp = new ethers.Contract(CONTRACTS.lend.lendingPool, LP_ABI, provider);
    const [collateral, debt, available, , , hf] = await lp.getUserAccountData(alias);

    const healthFactor =
      hf === ethers.MaxUint256
        ? Infinity
        : parseFloat(ethers.formatEther(hf as bigint));

    return {
      collateralUSD: `$${parseFloat(ethers.formatEther(collateral as bigint)).toFixed(2)}`,
      debtUSD: `$${parseFloat(ethers.formatEther(debt as bigint)).toFixed(2)}`,
      availableBorrowsUSD: `$${parseFloat(ethers.formatEther(available as bigint)).toFixed(2)}`,
      healthFactor,
      source: "on-chain",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

export function classifyHealthZone(hf: number): HealthZone {
  if (hf >= HEALTH_FACTOR_WARNING) return "SAFE";
  if (hf >= HEALTH_FACTOR_CRITICAL) return "WARN";
  if (hf >= HEALTH_FACTOR_CRITICAL_HARD) return "DANGER";
  return "CRITICAL";
}

export function getAdaptivePollInterval(zone: HealthZone): number {
  switch (zone) {
    case "SAFE":     return POLL_SAFE_MS;
    case "WARN":     return POLL_WARN_MS;
    case "DANGER":   return POLL_DANGER_MS;
    case "CRITICAL": return POLL_CRITICAL_MS;
  }
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

/**
 * Execute one monitoring poll. Fetches position data from both sources
 * using Promise.allSettled so one failure doesn't block the other.
 */
export async function pollHealth(config: MonitorConfig): Promise<HealthPollResult> {
  const errors: string[] = [];
  const timestamp = new Date().toISOString();

  const [onChainResult, apiResult] = await Promise.allSettled([
    fetchOnChainPosition(config.alias),
    fetchHealthFactor(config.accountId),
  ]);

  let position: OnChainPosition | null = null;
  let healthFactor: number | null = null;

  // Primary: on-chain
  if (onChainResult.status === "fulfilled" && onChainResult.value !== null) {
    position = onChainResult.value;
    healthFactor = isFinite(position.healthFactor) ? position.healthFactor : null;
  } else if (onChainResult.status === "rejected") {
    errors.push(`on-chain: ${String(onChainResult.reason)}`);
  }

  // Fallback: REST API (only used if on-chain gave no position or no debt)
  const apiHF =
    apiResult.status === "fulfilled" ? apiResult.value : null;

  if (apiResult.status === "rejected") {
    errors.push(`api: ${String(apiResult.reason)}`);
  }

  // If both sources succeeded, use on-chain as primary but warn on divergence
  if (healthFactor !== null && apiHF !== null) {
    const delta = Math.abs(healthFactor - apiHF);
    if (delta > 0.2) {
      errors.push(
        `HF source divergence: on-chain=${healthFactor.toFixed(3)}, api=${apiHF.toFixed(3)}`
      );
    }
  }

  // Fall back to API HF if on-chain failed
  if (healthFactor === null && apiHF !== null) {
    healthFactor = apiHF;
    if (position === null) {
      position = {
        collateralUSD: "unknown",
        debtUSD: "unknown",
        availableBorrowsUSD: "unknown",
        healthFactor: apiHF,
        source: "api",
      };
    }
  }

  // If no HF, the account has no open position (nothing borrowed)
  if (healthFactor === null || healthFactor === 0) {
    const zone: HealthZone = "SAFE";
    return {
      timestamp,
      zone,
      healthFactor: null,
      position: null,
      nextPollMs: POLL_SAFE_MS,
      shouldAutoUnwind: false,
      errors,
    };
  }

  const zone = classifyHealthZone(healthFactor);
  const nextPollMs = getAdaptivePollInterval(zone);

  // Both sources must independently confirm CRITICAL before auto-unwind fires.
  // If the API is unreachable (null), we do NOT treat that as confirmation —
  // a network blip should never trigger an unwind on its own.
  const bothCritical =
    zone === "CRITICAL" &&
    apiHF !== null &&
    apiHF < HEALTH_FACTOR_CRITICAL_HARD;

  const shouldAutoUnwind = config.autoUnwind && bothCritical;

  return {
    timestamp,
    zone,
    healthFactor,
    position,
    nextPollMs,
    shouldAutoUnwind,
    errors,
  };
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

export function loadState(statePath: string): MonitorState {
  if (!existsSync(statePath)) {
    return {
      startedAt: new Date().toISOString(),
      lastPollAt: null,
      pollCount: 0,
      lastZone: null,
      lastHF: null,
      autoUnwindFired: false,
      autoUnwindAt: null,
    };
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as MonitorState;
  } catch {
    return {
      startedAt: new Date().toISOString(),
      lastPollAt: null,
      pollCount: 0,
      lastZone: null,
      lastHF: null,
      autoUnwindFired: false,
      autoUnwindAt: null,
    };
  }
}

export function saveState(statePath: string, state: MonitorState): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: string;
  level: "INFO" | "WARN" | "DANGER" | "CRITICAL" | "ERROR";
  event: string;
  data?: Record<string, unknown>;
}

export function emitLog(entry: LogEntry): void {
  process.stdout.write(JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// Main monitor loop
// ---------------------------------------------------------------------------

let _loopRunning = false;

/**
 * Stop signal — set to true from outside to break the loop gracefully.
 */
export let stopSignal = false;

export function requestStop(): void {
  stopSignal = true;
}

/**
 * Start the adaptive health factor monitoring loop.
 * Runs until `requestStop()` is called or process exits.
 *
 * The loop:
 *  1. Polls health on-chain + via API
 *  2. Logs structured JSON to stdout
 *  3. Persists state to statePath
 *  4. Fires auto-unwind callback if zone=CRITICAL and autoUnwind=true
 *  5. Waits adaptive interval before next poll
 */
export async function startMonitorLoop(
  config: MonitorConfig,
  onAutoUnwind?: (result: HealthPollResult) => Promise<void>
): Promise<void> {
  if (_loopRunning) {
    throw new Error("Monitor loop is already running");
  }
  _loopRunning = true;
  stopSignal = false;

  const state = loadState(config.statePath);
  state.startedAt = new Date().toISOString();
  saveState(config.statePath, state);

  emitLog({
    ts: new Date().toISOString(),
    level: "INFO",
    event: "monitor_start",
    data: {
      alias: config.alias,
      accountId: config.accountId,
      autoUnwind: config.autoUnwind,
      statePath: config.statePath,
    },
  });

  while (!stopSignal) {
    let result: HealthPollResult;
    try {
      result = await pollHealth(config);
    } catch (err) {
      emitLog({
        ts: new Date().toISOString(),
        level: "ERROR",
        event: "poll_error",
        data: { error: String(err) },
      });
      await sleep(POLL_SAFE_MS);
      continue;
    }

    // Update state
    state.lastPollAt = result.timestamp;
    state.pollCount++;
    state.lastZone = result.zone;
    state.lastHF = result.healthFactor;

    // Log the poll result
    const logLevel: LogEntry["level"] =
      result.zone === "SAFE"     ? "INFO"
      : result.zone === "WARN"   ? "WARN"
      : result.zone === "DANGER" ? "DANGER"
      : "CRITICAL";

    emitLog({
      ts: result.timestamp,
      level: logLevel,
      event: "health_poll",
      data: {
        zone: result.zone,
        healthFactor: result.healthFactor,
        collateralUSD: result.position?.collateralUSD,
        debtUSD: result.position?.debtUSD,
        source: result.position?.source,
        nextPollMs: result.nextPollMs,
        errors: result.errors.length > 0 ? result.errors : undefined,
      },
    });

    // Log zone changes
    if (state.lastZone !== null && state.lastZone !== result.zone) {
      emitLog({
        ts: result.timestamp,
        level: logLevel,
        event: "zone_change",
        data: { from: state.lastZone, to: result.zone, hf: result.healthFactor },
      });
    }

    // Fire auto-unwind if conditions met and not already fired
    if (result.shouldAutoUnwind && !state.autoUnwindFired) {
      emitLog({
        ts: result.timestamp,
        level: "CRITICAL",
        event: "auto_unwind_triggered",
        data: { hf: result.healthFactor },
      });
      state.autoUnwindFired = true;
      state.autoUnwindAt = result.timestamp;

      if (onAutoUnwind) {
        try {
          await onAutoUnwind(result);
        } catch (err) {
          emitLog({
            ts: new Date().toISOString(),
            level: "ERROR",
            event: "auto_unwind_error",
            data: { error: String(err) },
          });
        }
      }
    }

    saveState(config.statePath, state);

    if (!stopSignal) {
      await sleep(result.nextPollMs);
    }
  }

  _loopRunning = false;
  emitLog({
    ts: new Date().toISOString(),
    level: "INFO",
    event: "monitor_stop",
    data: { totalPolls: state.pollCount },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
