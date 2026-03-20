/**
 * LangChain agent setup with Hedera Agent Kit + Bonzo plugin + custom tools.
 */

import { Client, AccountId, PrivateKey } from "@hashgraph/sdk";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { ethers } from "ethers";
import {
  HederaLangchainToolkit,
  type Configuration,
  AgentMode,
  type Plugin,
} from "hedera-agent-kit";
import { bonzoPlugin } from "@bonzofinancelabs/hak-bonzo-plugin";
import { env, validateEnv } from "../config/env.js";
import { CONTRACTS } from "../config/contracts.js";
import { HEDERA_JSON_RPC } from "../config/constants.js";
import { fetchMarketData, analyzeSpread } from "../strategy/spread.js";
import { checkPosition, formatStatus } from "../strategy/monitor.js";
import {
  evaluateEntry,
  getEntrySteps,
  getExitSteps,
  type StrategyConfig,
  type StrategyState,
} from "../strategy/orchestrator.js";
import {
  getExchangeRate,
  previewUnstake,
  executeUnstake,
  executeWithdraw,
  executeStake,
} from "../tools/stader-unstake.js";
import {
  previewDeposit as vaultPreviewDeposit,
  getVaultInfo,
  executeDeposit as vaultExecuteDeposit,
  getShareBalance,
  USDC_HBAR_VAULT,
  VAULT_ABI,
} from "../tools/vault-deposit.js";
import { getVaultAPY, recordPPSReading } from "../strategy/vault-apy.js";

import { SYSTEM_PROMPT } from "./system-prompt.js";

/**
 * Build custom LangChain tools wrapping strategy + execution helpers.
 */
function buildCustomTools(hederaClient: Client): DynamicStructuredTool[] {
  // Ethers provider/signer for vault EVM calls
  const provider = new ethers.JsonRpcProvider(HEDERA_JSON_RPC);

  // --- Analysis / Read-only tools ---

  const spreadAnalysisTool = new DynamicStructuredTool({
    name: "analyze_spread",
    description:
      "Fetch current Bonzo Lend market data and analyze the spread between HBARX borrow cost and vault yield. " +
      "If vaultApy is omitted, automatically fetches live APY from on-chain vault data.",
    schema: z.object({
      vaultApy: z.number().optional().describe("Vault APY percentage. If omitted, fetched live from on-chain data."),
    }),
    func: async ({ vaultApy }) => {
      const market = await fetchMarketData();
      let effectiveApy = vaultApy;
      let apySource = "user-provided";
      if (effectiveApy === undefined) {
        try {
          const result = await getVaultAPY(USDC_HBAR_VAULT, provider);
          effectiveApy = result.apy7d ?? result.apy24h ?? result.apy ?? 70;
          apySource = result.apy7d !== null ? "on-chain-7d" :
                      result.apy24h !== null ? "on-chain-24h" :
                      result.apy !== null ? "on-chain-overall" : "fallback-estimate";
        } catch {
          effectiveApy = 70;
          apySource = "fallback-estimate";
        }
      }
      const spread = analyzeSpread(market, effectiveApy);
      return JSON.stringify({
        hbarxBorrowRate: `${spread.hbarxBorrowRate.toFixed(3)}%`,
        vaultApy: `${spread.vaultApy.toFixed(1)}%`,
        vaultApySource: apySource,
        netSpread: `${spread.netSpread.toFixed(1)}%`,
        isPositive: spread.isPositive,
        recommendation: spread.recommendation,
        market: {
          hbarxUtilization: `${market.hbarxUtilization.toFixed(1)}%`,
          hbarxAvailableLiquidity: `$${market.hbarxAvailableLiquidity.toLocaleString()}`,
          whbarBorrowApy: `${market.whbarBorrowApy.toFixed(3)}%`,
          usdcBorrowApy: `${market.usdcBorrowApy.toFixed(3)}%`,
        },
      }, null, 2);
    },
  });

  const fetchMarketTool = new DynamicStructuredTool({
    name: "fetch_market_data",
    description:
      "Fetch current lending market data from Bonzo Finance including borrow rates, supply rates, utilization, and liquidity.",
    schema: z.object({}),
    func: async () => {
      const market = await fetchMarketData();
      return JSON.stringify({
        hbarxBorrowApy: `${market.hbarxBorrowApy.toFixed(3)}%`,
        hbarxSupplyApy: `${market.hbarxSupplyApy.toFixed(3)}%`,
        hbarxUtilization: `${market.hbarxUtilization.toFixed(1)}%`,
        hbarxAvailableLiquidity: `$${market.hbarxAvailableLiquidity.toLocaleString()}`,
        whbarBorrowApy: `${market.whbarBorrowApy.toFixed(3)}%`,
        usdcBorrowApy: `${market.usdcBorrowApy.toFixed(3)}%`,
      }, null, 2);
    },
  });

  const positionMonitorTool = new DynamicStructuredTool({
    name: "check_position",
    description:
      "Run a full position health check. Returns market state, spread analysis, health factor, and risk alerts.",
    schema: z.object({
      accountId: z.string().describe("Hedera account ID (e.g. 0.0.12345).").optional(),
      currentVaultApy: z.number().describe("Current vault APY percentage estimate."),
    }),
    func: async ({ accountId, currentVaultApy }) => {
      const acct = accountId ?? env.hedera.accountId;
      const status = await checkPosition(acct, currentVaultApy);
      return formatStatus(status);
    },
  });

  const evaluateEntryTool = new DynamicStructuredTool({
    name: "evaluate_strategy_entry",
    description:
      "Evaluate whether current market conditions are favorable for entering the leveraged yield strategy.",
    schema: z.object({
      collateralToken: z.enum(["WHBAR", "USDC"]).default("WHBAR"),
      collateralAmount: z.string().default("1000"),
      borrowAmountHbarx: z.string().default("500"),
      minSpread: z.number().default(10),
    }),
    func: async ({ collateralToken, collateralAmount, borrowAmountHbarx, minSpread }) => {
      const config: StrategyConfig = {
        collateralToken, collateralAmount, borrowAmountHbarx, minSpread,
        maxLeverage: 0.5, healthFactorTarget: 2.5,
      };
      const result = await evaluateEntry(config);
      return JSON.stringify({
        viable: result.viable,
        spread: {
          netSpread: `${result.spread.netSpread.toFixed(1)}%`,
          hbarxBorrowRate: `${result.spread.hbarxBorrowRate.toFixed(3)}%`,
          vaultApy: `${result.spread.vaultApy.toFixed(1)}%`,
        },
        reasons: result.reasons,
      }, null, 2);
    },
  });

  const entryStepsTool = new DynamicStructuredTool({
    name: "get_entry_steps",
    description: "Get step-by-step instructions for entering the leveraged yield strategy.",
    schema: z.object({
      collateralToken: z.enum(["WHBAR", "USDC"]).default("WHBAR"),
      collateralAmount: z.string().default("1000"),
      borrowAmountHbarx: z.string().default("500"),
    }),
    func: async ({ collateralToken, collateralAmount, borrowAmountHbarx }) => {
      const config: StrategyConfig = {
        collateralToken, collateralAmount, borrowAmountHbarx,
        minSpread: 10, maxLeverage: 0.5, healthFactorTarget: 2.5,
      };
      return getEntrySteps(config).join("\n\n");
    },
  });

  const exitStepsTool = new DynamicStructuredTool({
    name: "get_exit_steps",
    description: "Get step-by-step instructions for unwinding the position based on current strategy phase.",
    schema: z.object({
      phase: z.enum([
        "idle", "collateral_supplied", "hbarx_borrowed",
        "unstaking", "vault_deposited", "unwinding",
      ]).describe("Current strategy phase"),
      unstakeReady: z.boolean().default(false).describe("Whether the HBARX unstake cooldown has completed"),
    }),
    func: async ({ phase, unstakeReady }) => {
      const state: StrategyState = { phase, unstakeReady };
      return getExitSteps(state).join("\n\n");
    },
  });

  // --- Stader HBARX tools (Hedera-native contract calls) ---

  const getHbarxExchangeRateTool = new DynamicStructuredTool({
    name: "get_hbarx_exchange_rate",
    description:
      "Get the live HBARX → HBAR exchange rate from the Stader staking contract on-chain. " +
      "The rate increases over time as staking rewards accrue.",
    schema: z.object({}),
    func: async () => {
      const rate = await getExchangeRate(hederaClient);
      return JSON.stringify({
        exchangeRate: rate,
        meaning: `1 HBARX = ${rate.toFixed(6)} HBAR`,
        source: `Stader staking contract ${CONTRACTS.stader.stakingContract}`,
      }, null, 2);
    },
  });

  const hbarxUnstakePreviewTool = new DynamicStructuredTool({
    name: "hbarx_unstake_preview",
    description:
      "Preview unstaking HBARX via Stader. Fetches live exchange rate and shows estimated HBAR received + cooldown time. Does NOT execute.",
    schema: z.object({
      hbarxAmount: z.number().describe("Amount of HBARX to unstake"),
    }),
    func: async ({ hbarxAmount }) => {
      const preview = await previewUnstake(hederaClient, hbarxAmount);
      return JSON.stringify({
        preview: true,
        hbarxAmount: preview.hbarxAmount,
        exchangeRate: preview.exchangeRate,
        estimatedHbarReceived: preview.expectedHbar.toFixed(4),
        cooldownEnds: preview.cooldownEnds.toISOString(),
        cooldownPeriod: "~1 day",
        note: "Call execute_hbarx_unstake to proceed. After unstaking, wait for cooldown, then call execute_hbarx_withdraw.",
      }, null, 2);
    },
  });

  const executeHbarxUnstakeTool = new DynamicStructuredTool({
    name: "execute_hbarx_unstake",
    description:
      "EXECUTE: Unstake HBARX via Stader Labs. This sends a real transaction that burns HBARX and initiates a 1-day cooldown. " +
      "After cooldown, call execute_hbarx_withdraw to claim HBAR. Always preview and confirm with user first.",
    schema: z.object({
      hbarxAmount: z.number().describe("Amount of HBARX to unstake"),
    }),
    func: async ({ hbarxAmount }) => {
      const result = await executeUnstake(hederaClient, hbarxAmount);
      return JSON.stringify({
        executed: true,
        operation: "unstake_hbarx",
        hbarxAmount,
        transactionId: result.transactionId,
        status: result.status,
        cooldownEnds: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        nextStep: "Wait ~1 day for cooldown, then call execute_hbarx_withdraw with index 0.",
      }, null, 2);
    },
  });

  const executeHbarxWithdrawTool = new DynamicStructuredTool({
    name: "execute_hbarx_withdraw",
    description:
      "EXECUTE: Withdraw HBAR after HBARX unstaking cooldown completes. Calls Stader undelegation contract. " +
      "Only call after the 1-day cooldown from unstaking has passed.",
    schema: z.object({
      withdrawIndex: z.number().default(0).describe("Withdrawal index (0 for first unstake, increments with each)"),
    }),
    func: async ({ withdrawIndex }) => {
      const result = await executeWithdraw(hederaClient, withdrawIndex);
      return JSON.stringify({
        executed: true,
        operation: "withdraw_hbar",
        withdrawIndex,
        transactionId: result.transactionId,
        status: result.status,
      }, null, 2);
    },
  });

  const executeHbarStakeTool = new DynamicStructuredTool({
    name: "execute_hbar_stake",
    description:
      "EXECUTE: Stake HBAR to receive HBARX via Stader Labs. Useful for repaying HBARX borrow when unwinding. " +
      "Sends HBAR to the staking contract and receives HBARX at the current exchange rate.",
    schema: z.object({
      hbarAmount: z.number().describe("Amount of HBAR to stake"),
    }),
    func: async ({ hbarAmount }) => {
      const result = await executeStake(hederaClient, hbarAmount);
      return JSON.stringify({
        executed: true,
        operation: "stake_hbar",
        hbarAmount,
        transactionId: result.transactionId,
        status: result.status,
      }, null, 2);
    },
  });

  // --- Bonzo Vault tools (EVM calls via ethers) ---

  const vaultInfoTool = new DynamicStructuredTool({
    name: "get_vault_info",
    description:
      "Get info about the Bonzo USDC-HBAR vault including token pair, total supply, and price per share.",
    schema: z.object({
      vaultAddress: z.string().default(USDC_HBAR_VAULT).describe("Vault contract address (defaults to USDC-HBAR)"),
    }),
    func: async ({ vaultAddress }) => {
      const info = await getVaultInfo(provider, vaultAddress);
      return JSON.stringify({
        vaultAddress,
        token0: info.token0,
        token1: info.token1,
        totalSupply: info.totalSupply.toString(),
        pricePerShare: info.pricePerShare.toString(),
      }, null, 2);
    },
  });

  const vaultPreviewDepositTool = new DynamicStructuredTool({
    name: "vault_preview_deposit",
    description:
      "Preview a deposit into the Bonzo USDC-HBAR vault on-chain. Returns expected shares and fees without executing. " +
      "amount0 is USDC (6 decimals), amount1 is HBAR (8 decimals, or send as native).",
    schema: z.object({
      usdcAmount: z.string().describe("USDC amount in smallest units (6 decimals, e.g. '1000000' = 1 USDC)"),
      hbarAmount: z.string().describe("HBAR amount in smallest units (8 decimals, e.g. '100000000' = 1 HBAR)"),
      vaultAddress: z.string().default(USDC_HBAR_VAULT),
    }),
    func: async ({ usdcAmount, hbarAmount, vaultAddress }) => {
      const preview = await vaultPreviewDeposit(
        provider, vaultAddress,
        BigInt(usdcAmount), BigInt(hbarAmount), true
      );
      return JSON.stringify({
        preview: true,
        expectedShares: preview.shares.toString(),
        fee0: preview.fee0.toString(),
        fee1: preview.fee1.toString(),
        totalHbar: preview.totalHbar?.toString(),
        note: "Call execute_vault_deposit to proceed. The vault accepts both tokens and returns leftovers.",
      }, null, 2);
    },
  });

  const vaultExecuteDepositTool = new DynamicStructuredTool({
    name: "execute_vault_deposit",
    description:
      "EXECUTE: Deposit USDC + HBAR into the Bonzo USDC-HBAR vault. This sends a real transaction. " +
      "The vault auto-wraps native HBAR to WHBAR. Both tokens are required; vault fits what it can and returns leftovers. " +
      "Always preview first and confirm with user.",
    schema: z.object({
      usdcAmount: z.string().describe("USDC amount in smallest units (6 decimals)"),
      hbarAmount: z.string().describe("HBAR amount in smallest units (8 decimals)"),
      minShares: z.string().default("0").describe("Minimum shares to accept (slippage protection)"),
      hbarValue: z.string().describe("Native HBAR to send as msg.value (in wei/tinybars)"),
      vaultAddress: z.string().default(USDC_HBAR_VAULT),
    }),
    func: async ({ usdcAmount, hbarAmount, minShares, hbarValue, vaultAddress }) => {
      const signer = new ethers.Wallet(env.hedera.privateKey, provider);
      const tx = await vaultExecuteDeposit(
        signer, vaultAddress,
        BigInt(usdcAmount), BigInt(hbarAmount),
        BigInt(minShares), BigInt(hbarValue)
      );
      const receipt = await tx.wait();
      return JSON.stringify({
        executed: true,
        operation: "vault_deposit",
        transactionHash: receipt?.hash,
        blockNumber: receipt?.blockNumber,
        status: receipt?.status === 1 ? "SUCCESS" : "FAILED",
        vaultAddress,
      }, null, 2);
    },
  });

  const vaultWithdrawTool = new DynamicStructuredTool({
    name: "execute_vault_withdraw",
    description:
      "EXECUTE: Withdraw from the Bonzo USDC-HBAR vault by burning vault shares. Returns USDC + HBAR. " +
      "Always confirm with user first.",
    schema: z.object({
      shares: z.string().describe("Number of vault shares to withdraw (full precision)"),
      vaultAddress: z.string().default(USDC_HBAR_VAULT),
    }),
    func: async ({ shares, vaultAddress }) => {
      const signer = new ethers.Wallet(env.hedera.privateKey, provider);
      const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);
      const tx = await vault.withdraw(BigInt(shares));
      const receipt = await tx.wait();
      return JSON.stringify({
        executed: true,
        operation: "vault_withdraw",
        sharesWithdrawn: shares,
        transactionHash: receipt?.hash,
        blockNumber: receipt?.blockNumber,
        status: receipt?.status === 1 ? "SUCCESS" : "FAILED",
      }, null, 2);
    },
  });

  const vaultShareBalanceTool = new DynamicStructuredTool({
    name: "get_vault_share_balance",
    description:
      "Check a user's vault share balance for the Bonzo USDC-HBAR vault.",
    schema: z.object({
      userAddress: z.string().describe("EVM address of the user to check"),
      vaultAddress: z.string().default(USDC_HBAR_VAULT),
    }),
    func: async ({ userAddress, vaultAddress }) => {
      const balance = await getShareBalance(provider, vaultAddress, userAddress);
      return JSON.stringify({
        userAddress,
        vaultAddress,
        shareBalance: balance.toString(),
      }, null, 2);
    },
  });

  const getVaultAPYTool = new DynamicStructuredTool({
    name: "get_vault_apy",
    description:
      "Get the real APY of the Bonzo USDC-HBAR vault computed from on-chain data. " +
      "Reads getPricePerFullShare() from the vault contract, records it, and computes APY " +
      "over 24h, 7d, and 30d windows by comparing against historical readings. " +
      "The first call starts tracking — APY estimates improve as more readings accumulate over time.",
    schema: z.object({
      vaultAddress: z.string().default(USDC_HBAR_VAULT).describe("Vault address (defaults to USDC-HBAR)"),
    }),
    func: async ({ vaultAddress }) => {
      const result = await getVaultAPY(vaultAddress, provider);
      return JSON.stringify({
        currentPricePerShare: result.currentPPS,
        apy: result.apy !== null ? `${result.apy.toFixed(2)}%` : "Not enough data yet",
        apy24h: result.apy24h !== null ? `${result.apy24h.toFixed(2)}%` : "Need ~24h of readings",
        apy7d: result.apy7d !== null ? `${result.apy7d.toFixed(2)}%` : "Need ~7d of readings",
        apy30d: result.apy30d !== null ? `${result.apy30d.toFixed(2)}%` : "Need ~30d of readings",
        readingCount: result.readingCount,
        oldestReading: result.oldestReading,
        newestReading: result.newestReading,
        source: result.source,
        note: result.readingCount < 2
          ? "This is the first reading. Run this tool again later to compute APY from price changes."
          : undefined,
      }, null, 2);
    },
  });

  return [
    // Analysis / read-only
    spreadAnalysisTool,
    fetchMarketTool,
    positionMonitorTool,
    evaluateEntryTool,
    entryStepsTool,
    exitStepsTool,
    // Stader HBARX
    getHbarxExchangeRateTool,
    hbarxUnstakePreviewTool,
    executeHbarxUnstakeTool,
    executeHbarxWithdrawTool,
    executeHbarStakeTool,
    // Bonzo Vault
    vaultInfoTool,
    vaultPreviewDepositTool,
    vaultExecuteDepositTool,
    vaultWithdrawTool,
    vaultShareBalanceTool,
    // Vault APY
    getVaultAPYTool,
  ];
}

/**
 * Create a Hedera SDK client from env credentials.
 */
function createHederaClient(): Client {
  const client =
    env.hedera.network === "mainnet"
      ? Client.forMainnet()
      : Client.forTestnet();

  client.setOperator(
    AccountId.fromString(env.hedera.accountId),
    PrivateKey.fromStringDer(env.hedera.privateKey),
  );

  return client;
}

/**
 * Select an LLM based on available API keys.
 * Prefers Anthropic Claude if ANTHROPIC_API_KEY is set, falls back to OpenAI GPT-4o.
 */
function createLLM(): { llm: BaseChatModel; modelName: string } {
  if (env.anthropic.apiKey) {
    console.log("Using Anthropic Claude (claude-opus-4-6)");
    return {
      llm: new ChatAnthropic({
        model: "claude-opus-4-6",
        temperature: 0,
        apiKey: env.anthropic.apiKey,
      }),
      modelName: "claude-opus-4-6",
    };
  }

  console.log("Using OpenAI GPT-4o");
  return {
    llm: new ChatOpenAI({
      model: "gpt-4o",
      temperature: 0,
      apiKey: env.openai.apiKey,
    }),
    modelName: "gpt-4o",
  };
}

export interface AgentResult {
  agent: ReturnType<typeof createReactAgent>;
  config: { modelName: string; toolCount: number };
}

/**
 * Create and return a LangChain ReAct agent wired up with Hedera Agent Kit tools,
 * the Bonzo plugin, and custom strategy tools.
 */
export async function createAgent(): Promise<AgentResult> {
  validateEnv();

  const client = createHederaClient();

  const configuration: Configuration = {
    plugins: [bonzoPlugin as Plugin],
    context: {
      accountId: env.hedera.accountId,
      mode: AgentMode.AUTONOMOUS,
    },
  };

  const toolkit = new HederaLangchainToolkit({ client: client as any, configuration });
  const hakTools = toolkit.getTools();
  const customTools = buildCustomTools(client);
  const allTools = [...hakTools, ...customTools] as any[];

  const { llm, modelName } = createLLM();

  const agent = createReactAgent({
    llm,
    tools: allTools,
    prompt: SYSTEM_PROMPT,
  });

  return {
    agent,
    config: {
      modelName,
      toolCount: allTools.length,
    },
  };
}

export { buildCustomTools, createHederaClient };
