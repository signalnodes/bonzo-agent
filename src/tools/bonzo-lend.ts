/**
 * Direct Bonzo Lend (Aave v2 fork) operations via ContractExecuteTransaction.
 *
 * KEY FINDING: On Hedera, msg.sender inside the EVM for ContractExecuteTransaction
 * is the account's ECDSA alias (derived from public key), NOT the long-form EVM address
 * (0x00...accountNum). The Bonzo plugin's getEvmAliasAddress() falls back to long-form
 * because AccountInfo.evmAddress is undefined in the Hedera SDK — causing a mismatch
 * between msg.sender (alias) and onBehalfOf (long-form) that triggers delegation checks.
 *
 * Fix: derive alias from the ECDSA private key via ethers.Wallet and use it for all
 * onBehalfOf / to parameters in LendingPool calls.
 */

import {
  Client,
  ContractExecuteTransaction,
  ContractId,
} from "@hashgraph/sdk";
import { ethers } from "ethers";
import { CONTRACTS } from "../config/contracts.js";

// LendingPool ABI fragments
const LP_ABI = [
  "function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) returns (uint256)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralETH, uint256 totalDebtETH, uint256 availableBorrowsETH, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const LP_IFACE = new ethers.Interface(LP_ABI);
const LP_CONTRACT_ID = ContractId.fromSolidityAddress(CONTRACTS.lend.lendingPool);

const GAS = 2_000_000;

/**
 * Derive the ECDSA alias from a raw hex private key.
 * This is the address Hedera uses as msg.sender in EVM calls.
 */
export function getEvmAlias(privateKeyHex: string): string {
  return new ethers.Wallet(privateKeyHex).address;
}

/**
 * Execute a raw calldata payload on the LendingPool.
 */
async function execLP(
  client: Client,
  data: string
): Promise<{ transactionId: string; status: string }> {
  const tx = new ContractExecuteTransaction()
    .setContractId(LP_CONTRACT_ID)
    .setGas(GAS)
    .setFunctionParameters(Buffer.from(data.slice(2), "hex"));

  const response = await tx.execute(client);
  const receipt = await response.getReceipt(client);
  return {
    transactionId: response.transactionId.toString(),
    status: receipt.status.toString(),
  };
}

/**
 * Deposit an asset into Bonzo Lend.
 * onBehalfOf defaults to the ECDSA alias so position lands under alias (matches msg.sender).
 */
export async function lendDeposit(
  client: Client,
  privateKeyHex: string,
  asset: string,
  amountWei: bigint,
  onBehalfOf?: string
): Promise<{ transactionId: string; status: string }> {
  const alias = onBehalfOf ?? getEvmAlias(privateKeyHex);
  const data = LP_IFACE.encodeFunctionData("deposit", [asset, amountWei, alias, 0]);
  return execLP(client, data);
}

/**
 * Borrow an asset from Bonzo Lend.
 * onBehalfOf must equal msg.sender (alias) or have credit delegation.
 */
export async function lendBorrow(
  client: Client,
  privateKeyHex: string,
  asset: string,
  amountWei: bigint,
  rateMode: 1 | 2 = 2,
  onBehalfOf?: string
): Promise<{ transactionId: string; status: string }> {
  const alias = onBehalfOf ?? getEvmAlias(privateKeyHex);
  const data = LP_IFACE.encodeFunctionData("borrow", [asset, amountWei, rateMode, 0, alias]);
  return execLP(client, data);
}

/**
 * Repay a borrow on Bonzo Lend.
 * Caller must have approved LendingPool to spend the asset first.
 */
export async function lendRepay(
  client: Client,
  privateKeyHex: string,
  asset: string,
  amountWei: bigint,
  rateMode: 1 | 2 = 2,
  onBehalfOf?: string
): Promise<{ transactionId: string; status: string }> {
  const alias = onBehalfOf ?? getEvmAlias(privateKeyHex);
  const data = LP_IFACE.encodeFunctionData("repay", [asset, amountWei, rateMode, alias]);
  return execLP(client, data);
}

/**
 * Withdraw an asset from Bonzo Lend (burns aTokens, returns underlying).
 * The aTokens must be held by msg.sender (alias).
 */
export async function lendWithdraw(
  client: Client,
  privateKeyHex: string,
  asset: string,
  amountWei: bigint,
  to?: string
): Promise<{ transactionId: string; status: string }> {
  const alias = to ?? getEvmAlias(privateKeyHex);
  const data = LP_IFACE.encodeFunctionData("withdraw", [asset, amountWei, alias]);
  return execLP(client, data);
}

/**
 * Token symbol → EVM address lookup.
 */
export function tokenAddress(symbol: string): string {
  const sym = symbol.toUpperCase() as keyof typeof CONTRACTS.tokens;
  const addr = CONTRACTS.tokens[sym];
  if (!addr) throw new Error(`Unknown token symbol: ${symbol}`);
  return addr;
}

/**
 * Token symbol → decimals.
 */
export function tokenDecimals(symbol: string): number {
  const map: Record<string, number> = {
    USDC: 6, WHBAR: 8, HBARX: 8,
  };
  return map[symbol.toUpperCase()] ?? 8;
}

/**
 * Parse a human-readable amount to wei given a token symbol.
 */
export function toWei(amount: string | number, symbol: string): bigint {
  const decimals = tokenDecimals(symbol);
  return BigInt(Math.round(Number(amount) * 10 ** decimals));
}
