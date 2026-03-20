// Bonzo Finance + Stader contract addresses (Hedera Mainnet)

export const CONTRACTS = {
  // Bonzo Lend (Aave v2 fork)
  lend: {
    lendingPool: "0x236897c518996163E7b313aD21D1C9fCC7BA1afc",
    dataProvider: "0x78feDC4D7010E409A0c0c7aF964cc517D3dCde18",
    oracle: "0xc0Bb4030b55093981700559a0B751DCf7Db03cBB",
  },

  // Tokens
  tokens: {
    WHBAR: "0x0000000000000000000000000000000000163B5a",
    HBARX: "0x00000000000000000000000000000000000cba44",
    USDC: "0x000000000000000000000000000000000006f89a",
  },

  // Hedera-native token IDs (for Hedera SDK calls vs EVM calls)
  tokenIds: {
    HBARX: "0.0.834116",
  },

  // Bonzo Lend aTokens (receipt tokens for supplied collateral)
  aTokens: {
    WHBAR: "0x6e96a607F2F5657b39bf58293d1A006f9415aF32",
    HBARX: "0x40EBC87627Fe4689567C47c8C9C84EDC4Cf29132",
    USDC: "0xB7687538c7f4CAD022d5e97CC778d0b46457c5DB",
  },

  // Bonzo Lend variable debt tokens
  debtTokens: {
    WHBAR: "0xCD5A1FF3AD6EDd7e85ae6De3854f3915dD8c9103",
    HBARX: "0xF4167Af5C303ec2aD1B96316fE013CA96Eb141B5",
    USDC: "0x8a90C2f80Fc266e204cb37387c69EA2ed42A3cc1",
  },

  // Stader Labs (HBARX staking/unstaking)
  stader: {
    stakingContract: "0.0.1027588",
    undelegationContract: "0.0.1027587",
  },

  // Bonzo Vaults (Beefy fork)
  vaults: {
    usdcHbar: "0x724F19f52A3E0e9D2881587C997db93f9613B2C7",
    hbarxLeveraged: "0x10288A0F368c82922a421EEb4360537b93af3780",
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
