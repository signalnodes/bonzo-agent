import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HCS10Client,
  AgentBuilder,
  AIAgentCapability,
} from "@hashgraphonline/standards-sdk";
import { env, validateEnv } from "./config/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dirname, "..", ".agent-state.json");

async function register(): Promise<void> {
  // 1. Validate env
  if (!env.hedera.accountId || !env.hedera.privateKey) {
    throw new Error(
      "HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are required in .env",
    );
  }

  console.log(
    `Registering agent on ${env.hedera.network} with account ${env.hedera.accountId}...`,
  );

  // 2. Create HCS-10 client
  const client = new HCS10Client({
    network: env.hedera.network,
    operatorId: env.hedera.accountId,
    operatorPrivateKey: env.hedera.privateKey,
  });

  // 3. Build agent metadata (HCS-11)
  const builder = new AgentBuilder()
    .setName("Bonzo Vault Keeper")
    .setBio(
      "AI-powered DeFi agent that executes leveraged yield strategies on Hedera " +
        "using Bonzo Finance. Supplies collateral, borrows HBARX at low rates, and " +
        "deposits into high-yield dual-asset vaults. Monitors health factors and rate " +
        "spreads for automated position management.",
    )
    .setCapabilities([
      AIAgentCapability.TRANSACTION_ANALYTICS,
      AIAgentCapability.MARKET_INTELLIGENCE,
      AIAgentCapability.WORKFLOW_AUTOMATION,
      AIAgentCapability.DATA_INTEGRATION,
    ])
    .setType("autonomous")
    .setModel("claude-opus-4-6")
    .setCreator("Bonzo Vault Keeper Team")
    .setNetwork(env.hedera.network)
    .setExistingAccount(env.hedera.accountId, env.hedera.privateKey)
    .setInboundTopicType("public" as any);

  // 4. Register with the Hashgraph Online Guarded Registry
  console.log("Creating and registering agent via HCS-10...\n");

  const result = await client.createAndRegisterAgent(builder, {
    progressCallback: (step: any) => {
      console.log(`  [progress] ${step.message ?? step}`);
    },
  });

  if (!result || !result.metadata) {
    throw new Error("Registration failed — no metadata returned");
  }

  const { inboundTopicId, outboundTopicId, accountId } = result.metadata;

  console.log("\nAgent registered successfully!");
  console.log(`  Account ID:       ${accountId}`);
  console.log(`  Inbound Topic:    ${inboundTopicId}`);
  console.log(`  Outbound Topic:   ${outboundTopicId}`);

  // 5. Persist topic IDs for the main agent to read at runtime
  const state = {
    accountId,
    inboundTopicId,
    outboundTopicId,
    registeredAt: new Date().toISOString(),
    network: env.hedera.network,
  };

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  console.log(`\nAgent state saved to ${STATE_FILE}`);
}

register().catch((err) => {
  console.error("Registration failed:", err);
  process.exit(1);
});
