/**
 * HBARX unstaking via Stader Labs on Hedera.
 *
 * Reference: github.com/stader-labs/hbarx-cli
 *
 * Stader uses Hedera-native ContractExecuteTransaction (not EVM/ethers).
 * - Unstake: call stakingContract.unStake(uint256 amount) — amount in 8-decimal HBARX
 * - Withdraw: call undelegationContract.withdraw(uint256 index) — after 1 day cooldown
 * - Exchange rate: derived from Bonzo oracle prices (HBARX_USD / HBAR_USD).
 *   The on-chain getExchangeRate() returns 10^8 (base constant, not accrued rate).
 */

import {
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  Hbar,
} from "@hashgraph/sdk";
import { CONTRACTS } from "../config/contracts.js";
import { fetchMarketData } from "../strategy/spread.js";
import { HBARX_DECIMALS, UNSTAKE_COOLDOWN_MS, CONTRACT_GAS_LIMIT } from "../config/constants.js";

export interface UnstakePreview {
  hbarxAmount: number;
  expectedHbar: number;
  exchangeRate: number;
  cooldownEnds: Date;
}

/**
 * Get the current HBARX → HBAR exchange rate.
 *
 * Derived from Bonzo oracle prices (HBARX_USD / HBAR_USD) — the on-chain
 * getExchangeRate() returns a base constant (10^8 = 1.0) not the accrued rate.
 *
 * Uses the cached fetchMarketData() so callers that already triggered a market
 * fetch (e.g. compare_conversion_paths) pay zero additional API cost.
 * The client parameter is kept for API compatibility.
 */
export async function getExchangeRate(_client?: Client): Promise<number> {
  const market = await fetchMarketData();
  if (market.hbarPriceUsd === 0) throw new Error("HBAR price is zero");
  if (market.hbarxPriceUsd === 0) throw new Error("HBARX price is zero");
  return market.hbarxPriceUsd / market.hbarPriceUsd;
}

/**
 * Preview an unstaking operation without executing it.
 */
export async function previewUnstake(
  client: Client,
  hbarxAmount: number
): Promise<UnstakePreview> {
  const exchangeRate = await getExchangeRate(client);
  const expectedHbar = hbarxAmount * exchangeRate;

  return {
    hbarxAmount,
    expectedHbar,
    exchangeRate,
    cooldownEnds: new Date(Date.now() + UNSTAKE_COOLDOWN_MS),
  };
}

/**
 * Execute HBARX unstaking via Stader.
 *
 * Calls stakingContract.unStake(uint256) where amount is in 8-decimal HBARX units.
 * After calling this, user must wait ~1 day, then call withdraw().
 */
export async function executeUnstake(
  client: Client,
  hbarxAmount: number
): Promise<{ transactionId: string; status: string }> {
  const amountInSmallest = Math.floor(hbarxAmount * 10 ** HBARX_DECIMALS);

  const tx = new ContractExecuteTransaction()
    .setContractId(CONTRACTS.stader.stakingContract)
    .setGas(CONTRACT_GAS_LIMIT)
    .setFunction(
      "unStake",
      new ContractFunctionParameters().addUint256(amountInSmallest)
    );

  const response = await tx.execute(client);
  const record = await response.getRecord(client);

  return {
    transactionId: record.transactionId.toString(),
    status: record.receipt.status.toString(),
  };
}

/**
 * Withdraw HBAR after the unstaking cooldown period.
 *
 * Calls undelegationContract.withdraw(uint256 index).
 * Index starts at 0 and increments with each unstake request.
 */
export async function executeWithdraw(
  client: Client,
  withdrawIndex: number = 0
): Promise<{ transactionId: string; status: string }> {
  const tx = new ContractExecuteTransaction()
    .setContractId(CONTRACTS.stader.undelegationContract)
    .setGas(CONTRACT_GAS_LIMIT)
    .setFunction(
      "withdraw",
      new ContractFunctionParameters().addUint256(withdrawIndex)
    );

  const response = await tx.execute(client);
  const record = await response.getRecord(client);

  return {
    transactionId: record.transactionId.toString(),
    status: record.receipt.status.toString(),
  };
}

/**
 * Stake HBAR to receive HBARX.
 *
 * Calls stakingContract.stake() with HBAR as payable amount.
 */
export async function executeStake(
  client: Client,
  hbarAmount: number
): Promise<{ transactionId: string; status: string }> {
  const tx = new ContractExecuteTransaction()
    .setContractId(CONTRACTS.stader.stakingContract)
    .setGas(CONTRACT_GAS_LIMIT)
    .setPayableAmount(new Hbar(hbarAmount))
    .setFunction("stake");

  const response = await tx.execute(client);
  const record = await response.getRecord(client);

  return {
    transactionId: record.transactionId.toString(),
    status: record.receipt.status.toString(),
  };
}
