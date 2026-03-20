/**
 * Custom Hedera Agent Kit tool for depositing into BonzoVaultConcLiq (Beefy fork).
 *
 * The existing @bonzofinancelabs/hak-bonzo-plugin only covers the Aave v2 lending pool.
 * This tool handles the concentrated liquidity vault deposits.
 */

import { ethers } from "ethers";
import { CONTRACTS } from "../config/contracts.js";

/** Default vault address for the USDC-HBAR dual vault. */
export const USDC_HBAR_VAULT = CONTRACTS.vaults.usdcHbar;

// BonzoVaultConcLiq ABI (minimal — just what we need)
export const VAULT_ABI = [
  "function deposit(uint256 _amount0, uint256 _amount1, uint256 _minShares) external payable",
  "function withdraw(uint256 _shares) external",
  "function previewDeposit(uint256 _amount0, uint256 _amount1) external view returns (uint256 shares, uint256 fee0, uint256 fee1)",
  "function previewDepositWithHBAR(uint256 _amount0, uint256 _amount1) external view returns (uint256 shares, uint256 fee0, uint256 fee1, uint256 totalHbar)",
  "function balanceOf(address) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function want() external view returns (address)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function getPricePerFullShare() external view returns (uint256)",
  "function strategy() external view returns (address)",
] as const;

export interface DepositPreview {
  shares: bigint;
  fee0: bigint;
  fee1: bigint;
  totalHbar?: bigint;
}

export interface VaultInfo {
  token0: string;
  token1: string;
  totalSupply: bigint;
  pricePerShare: bigint;
}

/**
 * Preview a deposit to see expected shares and fees.
 */
export async function previewDeposit(
  provider: ethers.Provider,
  vaultAddress: string,
  amount0: bigint,
  amount1: bigint,
  includeHbar: boolean = true
): Promise<DepositPreview> {
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);

  if (includeHbar) {
    const [shares, fee0, fee1, totalHbar] = await vault.previewDepositWithHBAR(amount0, amount1);
    return { shares, fee0, fee1, totalHbar };
  }

  const [shares, fee0, fee1] = await vault.previewDeposit(amount0, amount1);
  return { shares, fee0, fee1 };
}

/**
 * Get basic vault info.
 */
export async function getVaultInfo(
  provider: ethers.Provider,
  vaultAddress: string
): Promise<VaultInfo> {
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);

  const [token0, token1, totalSupply, pricePerShare] = await Promise.all([
    vault.token0(),
    vault.token1(),
    vault.totalSupply(),
    vault.getPricePerFullShare(),
  ]);

  return { token0, token1, totalSupply, pricePerShare };
}

/**
 * Execute a deposit into the vault.
 * amount0 = token0 amount, amount1 = token1 amount
 * For HBAR-paired vaults, msg.value must include HBAR amount + mint fees.
 */
export async function executeDeposit(
  signer: ethers.Signer,
  vaultAddress: string,
  amount0: bigint,
  amount1: bigint,
  minShares: bigint = 0n,
  hbarValue?: bigint
): Promise<ethers.TransactionResponse> {
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);

  const tx = await vault.deposit(amount0, amount1, minShares, {
    value: hbarValue ?? 0n,
  });

  return tx;
}

/**
 * Get user's vault share balance.
 */
export async function getShareBalance(
  provider: ethers.Provider,
  vaultAddress: string,
  userAddress: string
): Promise<bigint> {
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
  return vault.balanceOf(userAddress);
}
