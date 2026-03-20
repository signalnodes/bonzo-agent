/**
 * HBARX unstaking via Stader Labs.
 *
 * Reference: github.com/stader-labs/hbarx-cli
 * Process: deposit HBARX → burn → equivalent HBAR moves to undelegation contract → 1 day cooldown → withdraw
 */

import { ethers } from "ethers";

// Stader contract addresses on Hedera mainnet
// TODO: verify these from Stader docs or hbarx-cli source
export const STADER_CONTRACTS = {
  // The main staking contract that handles HBARX minting/burning
  stakingContract: "", // TODO: get from Stader docs
  // HBARX token address
  hbarx: "0x00000000000000000000000000000000000cba44",
} as const;

// Minimal ABI for Stader unstaking
// TODO: extract actual ABI from hbarx-cli repo
export const STADER_ABI = [
  "function unstake(uint256 amount) external",
  "function withdraw() external",
  "function getExchangeRate() external view returns (uint256)",
  "function getPendingWithdrawal(address user) external view returns (uint256 amount, uint256 unlockTime)",
] as const;

export interface UnstakePreview {
  hbarxAmount: bigint;
  expectedHbar: bigint;
  exchangeRate: number;
  cooldownEnds: Date;
}

/**
 * Get the current HBARX → HBAR exchange rate.
 * Rate increases over time as staking rewards accrue.
 * Currently ~1.36-1.39 HBAR per HBARX.
 */
export async function getExchangeRate(
  provider: ethers.Provider
): Promise<number> {
  // TODO: call Stader contract for live rate
  // For now, use approximate known rate
  console.warn("Using approximate HBARX exchange rate — implement live rate fetch");
  return 1.37;
}

/**
 * Preview an unstaking operation.
 */
export async function previewUnstake(
  provider: ethers.Provider,
  hbarxAmount: bigint
): Promise<UnstakePreview> {
  const exchangeRate = await getExchangeRate(provider);
  const hbarxFloat = parseFloat(ethers.formatUnits(hbarxAmount, 8)); // HBARX has 8 decimals
  const expectedHbarFloat = hbarxFloat * exchangeRate;

  return {
    hbarxAmount,
    expectedHbar: ethers.parseUnits(expectedHbarFloat.toFixed(8), 8),
    exchangeRate,
    cooldownEnds: new Date(Date.now() + 24 * 60 * 60 * 1000), // 1 day from now
  };
}

/**
 * Execute HBARX unstaking via Stader.
 * After calling this, user must wait ~1 day, then call withdraw().
 */
export async function executeUnstake(
  signer: ethers.Signer,
  hbarxAmount: bigint
): Promise<ethers.TransactionResponse> {
  if (!STADER_CONTRACTS.stakingContract) {
    throw new Error(
      "Stader staking contract address not configured. " +
      "Get it from Stader docs or hbarx-cli source."
    );
  }

  const stader = new ethers.Contract(
    STADER_CONTRACTS.stakingContract,
    STADER_ABI,
    signer
  );

  return stader.unstake(hbarxAmount);
}

/**
 * Withdraw HBAR after cooldown period.
 */
export async function executeWithdraw(
  signer: ethers.Signer
): Promise<ethers.TransactionResponse> {
  if (!STADER_CONTRACTS.stakingContract) {
    throw new Error("Stader staking contract address not configured.");
  }

  const stader = new ethers.Contract(
    STADER_CONTRACTS.stakingContract,
    STADER_ABI,
    signer
  );

  return stader.withdraw();
}
