import { API } from "../config/contracts.js";

export interface MarketData {
  hbarxBorrowApy: number;
  hbarxSupplyApy: number;
  hbarxUtilization: number;
  hbarxAvailableLiquidity: number;
  whbarBorrowApy: number;
  usdcBorrowApy: number;
}

export interface SpreadAnalysis {
  hbarxBorrowRate: number;
  vaultApy: number;
  netSpread: number;
  isPositive: boolean;
  recommendation: string;
}

/**
 * Fetch current lending market data from Bonzo's API.
 */
export async function fetchMarketData(): Promise<MarketData> {
  const res = await fetch(API.market);
  if (!res.ok) {
    throw new Error(`Bonzo API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as any;

  // The API returns an array of reserve objects
  const reserves = Array.isArray(data) ? data : data.reserves ?? data.data ?? [];

  const findReserve = (symbol: string) =>
    reserves.find(
      (r: any) =>
        r.symbol?.toUpperCase() === symbol.toUpperCase() ||
        r.name?.toUpperCase() === symbol.toUpperCase()
    );

  const hbarx = findReserve("HBARX");
  const whbar = findReserve("WHBAR") ?? findReserve("HBAR");
  const usdc = findReserve("USDC");

  if (!hbarx) {
    throw new Error("HBARX reserve not found in market data");
  }

  // API returns nested objects for amounts, and direct numbers for APYs
  const parseApy = (val: any): number => {
    if (typeof val === "number") return val;
    if (typeof val === "string") return parseFloat(val);
    return 0;
  };

  const parseLiquidity = (val: any): number => {
    if (typeof val === "object" && val !== null) {
      // Bonzo API returns { usd_display: "3,790,731.46", ... }
      const usd = val.usd_display ?? val.usd_abbreviated ?? "0";
      return parseFloat(String(usd).replace(/[,$a-zA-Z]/g, ""));
    }
    return parseFloat(String(val ?? "0"));
  };

  const parseUtilization = (val: any): number => {
    if (typeof val === "object" && val !== null) {
      return parseFloat(val.display ?? val.value ?? "0");
    }
    return parseApy(val);
  };

  return {
    hbarxBorrowApy: parseApy(hbarx.variable_borrow_apy ?? hbarx.variableBorrowRate),
    hbarxSupplyApy: parseApy(hbarx.supply_apy ?? hbarx.liquidityRate),
    hbarxUtilization: parseUtilization(hbarx.utilization ?? hbarx.utilizationRate),
    hbarxAvailableLiquidity: parseLiquidity(hbarx.available_liquidity ?? hbarx.availableLiquidity),
    whbarBorrowApy: parseApy(whbar?.variable_borrow_apy ?? whbar?.variableBorrowRate),
    usdcBorrowApy: parseApy(usdc?.variable_borrow_apy ?? usdc?.variableBorrowRate),
  };
}

/**
 * Analyze the spread between HBARX borrow cost and vault yield.
 * vaultApy should be passed in from vault monitoring (not available via lending API).
 */
export function analyzeSpread(market: MarketData, vaultApy: number): SpreadAnalysis {
  const netSpread = vaultApy - market.hbarxBorrowApy;
  const isPositive = netSpread > 5; // at least 5% spread to be worth the risk

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
    const data = await res.json() as any;
    return parseFloat(data.healthFactor ?? data.health_factor ?? "0");
  } catch {
    return null;
  }
}
