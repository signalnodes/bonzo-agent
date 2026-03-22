/**
 * On-chain vault APY calculation for Bonzo Vaults (Beefy fork).
 *
 * Beefy-style vaults expose getPricePerFullShare() which increases over time
 * as the vault auto-compounds yields. By sampling this value at intervals,
 * we can compute the real APY.
 *
 * APY = ((currentPPS / historicalPPS) ^ (365 / daysBetween) - 1) * 100
 */

import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACTS } from "../config/contracts.js";
import { HEDERA_JSON_RPC, MAX_PPS_HISTORY } from "../config/constants.js";
import { VAULT_ABI } from "../tools/vault-deposit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PPS_HISTORY_FILE = resolve(__dirname, "..", "..", ".vault-pps-history.json");

export interface PPSReading {
  timestamp: number; // unix ms
  pricePerShare: string; // bigint as string
  vaultAddress: string;
}

export interface VaultAPYResult {
  currentPPS: string;
  apy: number | null; // null if not enough data
  apy24h: number | null;
  apy7d: number | null;
  apy30d: number | null;
  readingCount: number;
  oldestReading: string | null; // ISO timestamp
  newestReading: string | null;
  source: "on-chain-computed";
}

/**
 * Load PPS history from disk.
 */
function loadHistory(): PPSReading[] {
  if (!existsSync(PPS_HISTORY_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PPS_HISTORY_FILE, "utf-8"));
  } catch {
    return [];
  }
}

/**
 * Save PPS history to disk.
 */
function saveHistory(history: PPSReading[]): void {
  const trimmed = history.slice(-MAX_PPS_HISTORY);
  writeFileSync(PPS_HISTORY_FILE, JSON.stringify(trimmed, null, 2) + "\n");
}

/**
 * Fetch current getPricePerFullShare() from the vault contract.
 */
export async function fetchPricePerShare(
  vaultAddress: string = CONTRACTS.vaults.usdcHbar,
  provider?: ethers.Provider
): Promise<bigint> {
  const p = provider ?? new ethers.JsonRpcProvider(HEDERA_JSON_RPC);
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, p);
  return vault.getPricePerFullShare();
}

/** Minimum ms between recorded readings — prevents duplicate writes on rapid tool calls. */
const MIN_READING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Record a new PPS reading and persist it.
 * Skips the write if a reading for this vault already exists within the last 5 minutes,
 * returning the most recent reading instead.
 */
export async function recordPPSReading(
  vaultAddress: string = CONTRACTS.vaults.usdcHbar,
  provider?: ethers.Provider
): Promise<PPSReading> {
  const history = loadHistory();
  const vaultHistory = history.filter((r) => r.vaultAddress === vaultAddress);
  const latest = vaultHistory[vaultHistory.length - 1];

  if (latest && Date.now() - latest.timestamp < MIN_READING_INTERVAL_MS) {
    return latest;
  }

  const pps = await fetchPricePerShare(vaultAddress, provider);
  const reading: PPSReading = {
    timestamp: Date.now(),
    pricePerShare: pps.toString(),
    vaultAddress,
  };

  history.push(reading);
  saveHistory(history);

  return reading;
}

/**
 * Compute APY between two PPS readings.
 * Returns null if the window is too short or the result is implausible.
 */
function computeAPY(older: PPSReading, newer: PPSReading): number | null {
  const oldPPS = BigInt(older.pricePerShare);
  const newPPS = BigInt(newer.pricePerShare);

  if (oldPPS === 0n) return null;

  const msBetween = newer.timestamp - older.timestamp;
  const daysBetween = msBetween / (24 * 60 * 60 * 1000);

  // Require at least 1 hour — short windows amplify noise into absurd APYs
  if (daysBetween < 1 / 24) return null;

  const ratio = Number(newPPS) / Number(oldPPS);
  const apy = (Math.pow(ratio, 365 / daysBetween) - 1) * 100;

  // Sanity cap — ConcLiq vault PPS fluctuates with price; reject garbage values
  if (!isFinite(apy) || apy > 500 || apy < -99) return null;

  return apy;
}

/**
 * Find the closest reading to a target time ago.
 */
function findReadingNear(
  history: PPSReading[],
  targetMs: number,
  vaultAddress: string
): PPSReading | null {
  const targetTime = Date.now() - targetMs;
  const vaultReadings = history.filter((r) => r.vaultAddress === vaultAddress);

  if (vaultReadings.length === 0) return null;

  let closest = vaultReadings[0];
  let closestDiff = Math.abs(closest.timestamp - targetTime);

  for (const reading of vaultReadings) {
    const diff = Math.abs(reading.timestamp - targetTime);
    if (diff < closestDiff) {
      closest = reading;
      closestDiff = diff;
    }
  }

  // Only use if within 50% of the target window
  if (closestDiff > targetMs * 0.5) return null;

  return closest;
}

/**
 * Get the current vault APY computed from on-chain PPS data.
 *
 * Takes a fresh reading, compares against historical readings,
 * and returns APY estimates over different time windows.
 *
 * The more readings over time, the more accurate the APY.
 * First call will return null APYs — they populate as readings accumulate.
 */
export async function getVaultAPY(
  vaultAddress: string = CONTRACTS.vaults.usdcHbar,
  provider?: ethers.Provider
): Promise<VaultAPYResult> {
  // Take a fresh reading
  const current = await recordPPSReading(vaultAddress, provider);
  const history = loadHistory().filter((r) => r.vaultAddress === vaultAddress);

  const MS_1H = 60 * 60 * 1000;
  const MS_24H = 24 * MS_1H;
  const MS_7D = 7 * MS_24H;
  const MS_30D = 30 * MS_24H;

  // Find readings at various lookback windows
  const reading24h = findReadingNear(history, MS_24H, vaultAddress);
  const reading7d = findReadingNear(history, MS_7D, vaultAddress);
  const reading30d = findReadingNear(history, MS_30D, vaultAddress);

  // Use the oldest available reading for a best-effort overall APY
  const oldest = history.length > 1 ? history[0] : null;

  return {
    currentPPS: current.pricePerShare,
    apy: oldest ? (computeAPY(oldest, current) ?? null) : null,
    apy24h: reading24h ? (computeAPY(reading24h, current) ?? null) : null,
    apy7d: reading7d ? (computeAPY(reading7d, current) ?? null) : null,
    apy30d: reading30d ? (computeAPY(reading30d, current) ?? null) : null,
    readingCount: history.length,
    oldestReading: oldest ? new Date(oldest.timestamp).toISOString() : null,
    newestReading: new Date(current.timestamp).toISOString(),
    source: "on-chain-computed",
  };
}

/**
 * Get the best available APY estimate.
 * Prefers 7d, falls back to 24h, then overall, then null.
 */
export async function getBestAPYEstimate(
  vaultAddress: string = CONTRACTS.vaults.usdcHbar,
  provider?: ethers.Provider
): Promise<number | null> {
  const result = await getVaultAPY(vaultAddress, provider);
  return result.apy7d ?? result.apy24h ?? result.apy ?? null;
}
