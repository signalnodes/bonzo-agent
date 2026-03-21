/**
 * Standalone health factor monitor entry point.
 *
 * Usage:
 *   npm run monitor:health
 *
 * Outputs newline-delimited JSON logs to stdout.
 * Persists state to .health-monitor-state.json (configurable via MONITOR_STATE_PATH).
 *
 * Environment variables:
 *   HEDERA_PRIVATE_KEY     — used to derive ECDSA alias for on-chain queries
 *   HEDERA_ACCOUNT_ID      — used for REST API fallback
 *   MONITOR_AUTO_UNWIND    — set to "true" to enable auto-unwind (default: false)
 *   MONITOR_STATE_PATH     — path for state JSON file (default: .health-monitor-state.json)
 */

import "dotenv/config";
import { env, validateEnv } from "./config/env.js";
import { getEvmAlias } from "./tools/bonzo-lend.js";
import { startMonitorLoop, requestStop, emitLog } from "./strategy/health-monitor.js";

validateEnv();

const alias = getEvmAlias(env.hedera.privateKey);

const config = {
  alias,
  accountId: env.hedera.accountId,
  autoUnwind: env.monitor.autoUnwind,
  statePath: env.monitor.statePath,
};

emitLog({
  ts: new Date().toISOString(),
  level: "INFO",
  event: "startup",
  data: {
    alias,
    accountId: env.hedera.accountId,
    autoUnwind: config.autoUnwind,
    statePath: config.statePath,
    note: config.autoUnwind
      ? "AUTO-UNWIND ENABLED: will execute unwind sequence on CRITICAL health factor"
      : "Auto-unwind disabled (set MONITOR_AUTO_UNWIND=true to enable)",
  },
});

// Graceful shutdown
process.on("SIGINT", () => {
  emitLog({ ts: new Date().toISOString(), level: "INFO", event: "sigint_received" });
  requestStop();
  // Give the loop one poll cycle to notice the stop signal
  setTimeout(() => process.exit(0), 200);
});

process.on("SIGTERM", () => {
  emitLog({ ts: new Date().toISOString(), level: "INFO", event: "sigterm_received" });
  requestStop();
  setTimeout(() => process.exit(0), 200);
});

startMonitorLoop(config).catch((err) => {
  emitLog({
    ts: new Date().toISOString(),
    level: "ERROR",
    event: "fatal",
    data: { error: String(err) },
  });
  process.exit(1);
});
