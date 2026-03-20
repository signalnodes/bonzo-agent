// Bonzo Finance contract addresses (Hedera Mainnet)

export const CONTRACTS = {
  // Bonzo Lend (Aave v2 fork)
  lend: {
    lendingPool: "0x236897c518996163E7b313aD21D1C9fCC7BA1afc",
    dataProvider: "0x78feDC4D7010E409A0c0c7aF964cc517D3dCde18",
    oracle: "0xc0Bb4030b55093981700559a0B751DCf7Db03cBB",
    wethGateway: "0x9a601543e9264255BebB20Cef0E7924e97127105",
  },

  // Tokens
  tokens: {
    WHBAR: "0x0000000000000000000000000000000000163B5a",
    HBARX: "0x00000000000000000000000000000000000cba44",
    USDC: "0x000000000000000000000000000000000006f89a",
  },

  // Bonzo Lend aTokens (receipt tokens for supplied collateral)
  aTokens: {
    WHBAR: "0x6e96a607F2F5657b39bf58293d1A006f9415aF32",
    HBARX: "0x40EBC87627Fe4689567C47c8C9C84EDC4Cf29132",
    USDC: "", // TODO: get from contract or API
  },

  // Bonzo Lend variable debt tokens
  debtTokens: {
    WHBAR: "0xCD5A1FF3AD6EDd7e85ae6De3854f3915dD8c9103",
    HBARX: "0xF4167Af5C303ec2aD1B96316fE013CA96Eb141B5",
  },

  // Bonzo Vaults (Beefy fork) — TODO: get USDC-HBAR vault address from app
  vaults: {
    usdcHbar: "", // BonzoVaultConcLiq address for USDC-HBAR
  },
} as const;

// Bonzo data API
export const API = {
  market: "https://mainnet-data-staging.bonzo.finance/market",
  dashboard: (accountId: string) =>
    `https://mainnet-data-staging.bonzo.finance/dashboard/${accountId}`,
  stats: "https://mainnet-data-staging.bonzo.finance/stats",
  info: "https://mainnet-data-staging.bonzo.finance/info",
} as const;
