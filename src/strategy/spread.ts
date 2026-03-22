import { API } from "../config/contracts.js";
import {
  MIN_SPREAD_THRESHOLD,
  HBAR_PRICE_USD_ESTIMATE,
  SPREAD_CACHE_TTL_MS,
  API_RETRY_ATTEMPTS,
  API_RETRY_BASE_MS,
} from "../config/constants.js";

export interface MarketData {
  hbarxBorrowApy: number;
  hbarxSupplyApy: number;
  hbarxUtilization: number;
  hbarxAvailableLiquidity: number;
  whbarBorrowApy: number;
  usdcBorrowApy: number;
  /** HBAR/USD spot price from Bonzo oracle (used to convert getUserAccountData values to USD) */
  hbarPriceUsd: number;
  /** HBARX/USD spot price from Bonzo oracle (used to compute HBARX→HBAR exchange rate) */
  hbarxPriceUsd: number;
}

export interface SpreadAnalysis {
  hbarxBorrowRate: number;
  vaultApy: number;
  netSpread: number;
  isPositive: boolean;
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

/** Fetch with exponential-backoff retries. Only retries on 5xx or network errors. */
async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: Error = new Error("fetch failed");
  for (let attempt = 0; attempt < API_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return res; // don't retry 4xx
      lastError = new Error(`Bonzo API error: ${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < API_RETRY_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, API_RETRY_BASE_MS * 2 ** attempt));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Market data cache
// ---------------------------------------------------------------------------

interface MarketCache {
  data: MarketData;
  expiresAt: number;
}

let _marketCache: MarketCache | null = null;

/** Invalidate the cache (useful in tests or after a forced refresh). */
export function clearMarketCache(): void {
  _marketCache = null;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch current lending market data from Bonzo's API.
 * Results are cached for SPREAD_CACHE_TTL_MS to prevent duplicate calls
 * across the monitor loop and orchestrator within the same cycle.
 */
export async function fetchMarketData(): Promise<MarketData> {
  const now = Date.now();
  if (_marketCache && now < _marketCache.expiresAt) {
    return _marketCache.data;
  }

  const res = await fetchWithRetry(API.market);
  if (!res.ok) {
    throw new Error(`Bonzo API error: ${res.status} ${res.statusText}`);
  }

  const data: unknown = await res.json();

  // The API returns an array of reserve objects (or wraps them in a key)
  const raw = data as Record<string, unknown>;
  const reserves: Record<string, unknown>[] =
    Array.isArray(data) ? data : (raw.reserves ?? raw.data ?? []) as Record<string, unknown>[];

  const findReserve = (symbol: string) =>
    reserves.find(
      (r) =>
        String(r.symbol ?? "").toUpperCase() === symbol.toUpperCase() ||
        String(r.name ?? "").toUpperCase() === symbol.toUpperCase()
    ) as Record<string, unknown> | undefined;

  const hbarx = findReserve("HBARX");
  const whbar = findReserve("WHBAR") ?? findReserve("HBAR");
  const usdc = findReserve("USDC");

  if (!hbarx) {
    throw new Error("HBARX reserve not found in market data");
  }

  /**
   * Parse a value from the Bonzo API that can be a number, string, or
   * an object with display/usd fields (the API uses all three shapes).
   */
  const parseValue = (val: unknown, objectKeys: string[] = ["display", "value"]): number => {
    if (typeof val === "number") return val;
    if (typeof val === "string") return parseFloat(val);
    if (typeof val === "object" && val !== null) {
      const obj = val as Record<string, unknown>;
      for (const key of objectKeys) {
        if (obj[key] !== undefined) {
          return parseFloat(String(obj[key]).replace(/[,$a-zA-Z]/g, ""));
        }
      }
    }
    return 0;
  };

  const hbarPriceUsd = parseValue(whbar?.price_usd_display ?? whbar?.priceUsdDisplay);

  // HBARX price: try WAD (hex) first, then strip-and-parse the display string.
  // parseValue for raw strings calls parseFloat which silently returns NaN on "$0.12"
  // style formatting — strip non-numeric chars first to match the original approach.
  const parseWadOrDisplay = (r: Record<string, unknown>): number => {
    const wad = r.price_usd_wad;
    if (typeof wad === "string" && wad.startsWith("0x")) {
      return Number(BigInt(wad)) / 1e18;
    }
    const display = r.price_usd_display ?? r.priceUsdDisplay;
    if (display === undefined || display === null) return 0;
    return parseFloat(String(display).replace(/[^0-9.]/g, "")) || 0;
  };
  const hbarxPriceUsd = parseWadOrDisplay(hbarx);

  const result: MarketData = {
    hbarxBorrowApy: parseValue(hbarx.variable_borrow_apy ?? hbarx.variableBorrowRate),
    hbarxSupplyApy: parseValue(hbarx.supply_apy ?? hbarx.liquidityRate),
    hbarxUtilization: parseValue(hbarx.utilization_rate ?? hbarx.utilization ?? hbarx.utilizationRate),
    hbarxAvailableLiquidity: parseValue(hbarx.available_liquidity ?? hbarx.availableLiquidity, ["usd_display", "usd_abbreviated"]),
    whbarBorrowApy: parseValue(whbar?.variable_borrow_apy ?? whbar?.variableBorrowRate),
    usdcBorrowApy: parseValue(usdc?.variable_borrow_apy ?? usdc?.variableBorrowRate),
    hbarPriceUsd: hbarPriceUsd > 0 ? hbarPriceUsd : HBAR_PRICE_USD_ESTIMATE,
    hbarxPriceUsd,
  };

  _marketCache = { data: result, expiresAt: Date.now() + SPREAD_CACHE_TTL_MS };
  return result;
}

/**
 * Analyze the spread between HBARX borrow cost and vault yield.
 * vaultApy should be passed in from vault monitoring (not available via lending API).
 */
export function analyzeSpread(market: MarketData, vaultApy: number): SpreadAnalysis {
  const netSpread = vaultApy - market.hbarxBorrowApy;
  const isPositive = netSpread > MIN_SPREAD_THRESHOLD;

  let recommendation: string;
  if (netSpread > 30) {
    recommendation = `Excellent spread of ${netSpread.toFixed(1)}%. Strategy is highly profitable. Recommend entering position.`;
  } else if (netSpread > 10) {
    recommendation = `Good spread of ${netSpread.toFixed(1)}%. Strategy is profitable. Consider entering with moderate size.`;
  } else if (netSpread > 5) {
    recommendation = `Marginal spread of ${netSpread.toFixed(1)}%. Proceed with caution and small position size.`;
  } else if (netSpread > 0) {
    recommendation = `Thin spread of ${netSpread.toFixed(1)}%. Risk-adjusted return may be negative. Recommend waiting.`;
  } else {
    recommendation = `Negative spread of ${netSpread.toFixed(1)}%. Do NOT enter this strategy. Borrow cost exceeds vault yield.`;
  }

  return {
    hbarxBorrowRate: market.hbarxBorrowApy,
    vaultApy,
    netSpread,
    isPositive,
    recommendation,
  };
}

/**
 * Fetch user's lending position health from Bonzo API.
 */
export async function fetchHealthFactor(accountId: string): Promise<number | null> {
  try {
    const res = await fetch(API.dashboard(accountId));
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return parseFloat(String(data.healthFactor ?? data.health_factor ?? "0"));
  } catch {
    return null;
  }
}
