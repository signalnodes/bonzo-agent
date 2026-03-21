import "dotenv/config";

export const env = {
  hedera: {
    accountId: process.env.HEDERA_ACCOUNT_ID ?? "",
    privateKey: process.env.HEDERA_PRIVATE_KEY ?? "",
    network: (process.env.HEDERA_NETWORK ?? "mainnet") as "mainnet" | "testnet",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  },
  hol: {
    apiKey: process.env.HOL_API_KEY ?? "",
  },
  monitor: {
    autoUnwind: process.env.MONITOR_AUTO_UNWIND === "true",
    statePath: process.env.MONITOR_STATE_PATH ?? ".health-monitor-state.json",
  },
} as const;

export function validateEnv(): void {
  if (!env.hedera.accountId || !env.hedera.privateKey) {
    throw new Error("HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are required in .env");
  }
  if (!env.openai.apiKey && !env.anthropic.apiKey) {
    throw new Error("Either OPENAI_API_KEY or ANTHROPIC_API_KEY is required in .env");
  }
}
