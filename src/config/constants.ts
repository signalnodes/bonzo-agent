/**
 * Centralized constants for the Bonzo Vault Keeper agent.
 *
 * All thresholds, limits, URLs, and timing values live here so they're
 * easy to tune and impossible to accidentally diverge across files.
 */

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export const HEDERA_JSON_RPC = "https://mainnet.hashio.io/api";
export const HEDERA_MIRROR_NODE = "https://mainnet.mirrornode.hedera.com";

// ---------------------------------------------------------------------------
// Health factor thresholds
// ---------------------------------------------------------------------------

/** Below this: liquidation is imminent — auto-unwind fires */
export const HEALTH_FACTOR_CRITICAL_HARD = 1.3;
/** Below this: DANGER zone — 30s polling */
export const HEALTH_FACTOR_CRITICAL = 1.5;
/** Below this: WARN zone — 1min polling */
export const HEALTH_FACTOR_WARNING = 2.0;
export const HEALTH_FACTOR_TARGET = 2.5;

// ---------------------------------------------------------------------------
// Health monitor poll intervals
// ---------------------------------------------------------------------------

export const POLL_SAFE_MS     = 5 * 60 * 1000;   // 5 minutes
export const POLL_WARN_MS     = 60 * 1000;         // 1 minute
export const POLL_DANGER_MS   = 30 * 1000;         // 30 seconds
export const POLL_CRITICAL_MS = 15 * 1000;         // 15 seconds

// ---------------------------------------------------------------------------
// Strategy thresholds
// ---------------------------------------------------------------------------

export const MIN_SPREAD_THRESHOLD = 5.0;
export const DEFAULT_VAULT_APY = 70;
export const DEFAULT_MIN_SPREAD = 10;
export const DEFAULT_MAX_LEVERAGE = 0.5;

export const BORROW_RATE_CHANGE_THRESHOLD = 0.5; // percentage points
export const VAULT_APY_WARNING_THRESHOLD = 30;    // percent
export const UTILIZATION_WARNING_THRESHOLD = 50;   // percent
export const UTILIZATION_ENTRY_HARD = 60;          // percent — block entry above this
export const BORROW_RATE_MAX = 5;                  // percent — too expensive above this

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export const UNSTAKE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 day
export const MONITOR_INTERVAL_MS = 60_000;
export const HCS10_POLL_INTERVAL_MS = 10_000;
export const STATUS_POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_ALERTS = 50;
export const MAX_SESSION_HISTORY = 100;
export const SESSION_HISTORY_TRIM_TO = 80;
export const MAX_PPS_HISTORY = 1000; // ~40 days at 1 reading/hour
export const MAX_PROCESSED_TIMESTAMPS = 5000;

// ---------------------------------------------------------------------------
// Stader
// ---------------------------------------------------------------------------

export const HBARX_DECIMALS = 8;

// ---------------------------------------------------------------------------
// Price estimates (used only for opportunity-cost calculations, not execution)
// ---------------------------------------------------------------------------

/** Approximate HBAR/USD rate for opportunity cost math. Not used for trade sizing. */
export const HBAR_PRICE_USD_ESTIMATE = 0.093;
