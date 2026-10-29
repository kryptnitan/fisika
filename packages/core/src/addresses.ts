import type { Address } from './types.ts';

/** Contract addresses on Celo mainnet (42220). Every entry names its source. Re-checked on-chain by scripts/verify-onchain.ts. */
export const CHAIN_ID = 42220;

export const UNISWAP_V3 = {
  // docs.uniswap.org/contracts/v3/reference/deployments/celo-deployments
  factory: '0xAfE208a311B21f13EF87E33A90049fC17A7acDEc',
  quoterV2: '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8',
  swapRouter02: '0x5615CDAb10dc425a742d643d949a7F474C01abc4',
  // Listed as "Multicall2" by Uniswap; it is UniswapInterfaceMulticall (not tryAggregate). fisika batches via Multicall3.
  multicall2: '0x633987602DE5C4F337e3DbF265303A1080324204',
  feeTiers: [100, 500, 3000, 10000] as const,
} as const satisfies Record<string, unknown>;

export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export const MENTO = {
  // docs.mento.org/mento-v3/build/deployments/addresses
  router: '0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6',
  fpmmFactory: '0xa849b475FE5a4B5C9C3280152c7a1945b907613b',
  virtualPoolFactory: '0x22abd4ADF6aab38aC1022352d496A07Acee5aCB3',
  factoryRegistry: '0x7b2f7d11eabD576782f77bF2CcA46a853410AdF6',
  breakerBox: '0x303ED1df62Fa067659B586EbEe8De0EcE824Ab39',
  sortedOracles: '0xefb84935239dacdecf7c5ba76d8de40b077b7b33',
  marketHoursBreaker: '0x0A18B8e7338eF8d6025529257aA5CCd5A14e0DAF',
  brokerV2: '0x777A8255cA72412f0d706dc03C9D1987306B4CaD',
  biPoolManagerV2: '0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901',
  fpmmPools: {
    'USDT/USDm': '0x0FEBa760d93423D127DE1B6ABECdB60E5253228D',
    'USDC/USDm': '0x462fe04b4FD719Cbd04C0310365D421D02AaA19E',
    'axlUSDC/USDm': '0xb285d4C7133d6f27BfB29224fb0D22E7EC3ddD2D',
    'GBPm/USDm': '0x8C0014afe032E4574481D8934504100bF23fCB56',
  },
} as const;

export const TEXTILE = {
  // docs.textilecredit.com/protocol/address-book (Celo section)
  apiBase: 'https://api.textilecredit.com',
  reactor: '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3',
  feeController: '0x7b005466F905DD882A959888154587fA76cd3Ea7',
  // Spender for single vault-order quotes (aggregator docs: read `spender` per quote). Address book, Celo section.
  vaultOrderExecutor: '0x01b006d5c687bde182aa36F542f1f014144742e2',
  takerFeeBps: 1,
} as const;

export const ERC8004 = {
  // docs.celo.org/build/agents/8004
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
} as const;

export const X402 = {
  // docs.celo.org/build-on-celo/build-with-ai/x402-get-discovered
  facilitator: 'https://api.x402.celo.org',
  network: 'eip155:42220',
} as const;

export const FEE_CURRENCY_ADAPTERS = {
  // docs.celo.org/build/agents/8004 example. USDT adapter deliberately absent until verified.
  USDC: '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B',
} as const;
