/**
 * Per-chain configuration. Everything chain-specific lives here: tokens, venues, free RPCs, gas token.
 * The router, arbitrage engine and risk limits are chain-agnostic and run one price graph per chain
 * (no cross-chain edges: moving value between chains needs a bridge, which is a separate design).
 *
 * Every address names its source and is re-checked on-chain by scripts/verify-onchain.ts (CHAIN=<key>).
 */
import { bsc, celo, type Chain } from 'viem/chains';
import { MENTO, TEXTILE, UNISWAP_V3 } from './addresses.ts';
import { CELO_TOKENS, type TokenInfo } from './tokens.ts';
import type { Address } from './types.ts';

export type ChainKey = 'celo' | 'bsc';

export interface V3DexConfig {
  /** Venue id used in the graph. */
  id: 'uniswap-v3' | 'pancake-v3';
  label: string;
  factory: Address;
  quoterV2: Address;
  /** Router used for execution. 'swaprouter02' = exactInputSingle without a deadline field. */
  router: Address;
  routerKind: 'swaprouter02' | 'v3-swaprouter';
  feeTiers: readonly number[];
}

export interface TextileChainConfig {
  chainId: number;
  reactor: Address;
  vaultOrderExecutor: Address;
  feeController: Address;
  takerFeeBps: number;
}

export interface ChainConfig {
  key: ChainKey;
  id: number;
  name: string;
  viem: Chain;
  explorer: string;
  /** Free endpoints in trust order. Vetted before use (chain id, reachability, lag). */
  freeRpcs: readonly string[];
  nativeSymbol: string;
  /** ERC-20 form of the gas token, priced from the graph to convert gas into dollars. */
  wrappedNative: Address;
  tokens: readonly TokenInfo[];
  /** Tokens every other token is paired against when discovering AMM pools. */
  hubs: readonly string[];
  /** Arbitrage cycles start and end in these (the wallet holds them). */
  startTokens: readonly string[];
  /** Pairs shown on the FX board. */
  corridors: readonly [string, string][];
  v3Dexes: readonly V3DexConfig[];
  mento: boolean;
  textile: TextileChainConfig | null;
}

const T = (t: TokenInfo): TokenInfo => ({ ...t, address: t.address.toLowerCase() as Address });

/* ---------------------------------------------------------------------------------------------- Celo */

export const CELO: ChainConfig = {
  key: 'celo',
  id: 42220,
  name: 'Celo',
  viem: celo,
  explorer: 'https://celoscan.io',
  // Forno is run by cLabs (docs.celo.org/build/tools/nodes/forno); PublicNode is Allnodes' free endpoint.
  freeRpcs: ['https://forno.celo.org', 'https://celo-rpc.publicnode.com'],
  nativeSymbol: 'CELO',
  wrappedNative: '0x471ece3750da237f93b8e339c536989b8978a438', // CELO's ERC-20 (docs.celo.org core contracts)
  tokens: CELO_TOKENS,
  hubs: ['USDT', 'USDC', 'USDm'],
  startTokens: ['USDT', 'USDC', 'USDm'],
  corridors: [
    ['USDT', 'USDC'], ['USDC', 'USDT'], ['USDT', 'USDm'], ['USDm', 'USDT'], ['USDC', 'USDm'],
    ['USDT', 'cNGN'], ['cNGN', 'USDT'], ['USDT', 'NGNm'], ['NGNm', 'USDT'],
    ['USDT', 'KESm'], ['KESm', 'USDT'], ['USDT', 'GHSm'], ['GHSm', 'USDT'], ['USDT', 'XOFm'], ['USDT', 'ZARm'],
    ['USDT', 'wBRL'], ['wBRL', 'USDT'], ['USDT', 'wARS'], ['wARS', 'USDT'], ['USDT', 'BRLA'], ['USDT', 'COPM'],
    ['cNGN', 'KESm'], ['cNGN', 'GHSm'], ['wBRL', 'wARS'], ['cNGN', 'NGNm'],
  ],
  v3Dexes: [
    {
      id: 'uniswap-v3',
      label: 'Uniswap',
      factory: UNISWAP_V3.factory,
      quoterV2: UNISWAP_V3.quoterV2,
      router: UNISWAP_V3.swapRouter02,
      routerKind: 'swaprouter02',
      feeTiers: UNISWAP_V3.feeTiers,
    },
  ],
  mento: true,
  textile: { chainId: 42220, reactor: TEXTILE.reactor, vaultOrderExecutor: TEXTILE.vaultOrderExecutor, feeController: TEXTILE.feeController, takerFeeBps: TEXTILE.takerFeeBps },
};

/* ---------------------------------------------------------------------------------------- BNB Chain */

export const BSC_TOKENS: readonly TokenInfo[] = [
  // Textile address book, BSC section ("USDT (BSC-USD)"); 18 decimals on BSC per the same page's testnet note.
  T({ symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, issuer: 'Tether (Binance-Peg)', fiat: 'USD', usd: true, tier: 1 }),
  // Textile address book, BSC section. 6 decimals read on-chain (decimals(), block 130426361; Textile API agrees).
  T({ symbol: 'cNGN', address: '0xa8AEA66B361a8d53e8865c62D142167Af28Af058', decimals: 6, issuer: 'Africa Stablecoin Consortium', fiat: 'NGN', usd: false, tier: 1 }),
  // Uniswap BNB deployments page (wrapped native token). Only used to price gas.
  T({ symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18, issuer: 'BNB Chain', fiat: 'BNB', usd: false, tier: 0 }),
];

export const BSC: ChainConfig = {
  key: 'bsc',
  id: 56,
  name: 'BNB Chain',
  viem: bsc,
  explorer: 'https://bscscan.com',
  // bsc-dataseed.bnbchain.org is BNB Chain's own endpoint (docs.bnbchain.org JSON-RPC page; 10k requests / 5 min);
  // PublicNode is Allnodes' free endpoint. Both vetted before use.
  freeRpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
  nativeSymbol: 'BNB',
  wrappedNative: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  tokens: BSC_TOKENS,
  hubs: ['USDT'],
  startTokens: ['USDT'],
  corridors: [['USDT', 'cNGN'], ['cNGN', 'USDT']],
  v3Dexes: [
    {
      // developers.uniswap.org/docs/protocols/v3/deployments/v3-bnb-deployments
      id: 'uniswap-v3',
      label: 'Uniswap',
      factory: '0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7',
      quoterV2: '0x78d78e420da98ad378d7799be8f4af69033eb077',
      router: '0xb971ef87ede563556b2ed4b1c0b0019111dd85d2',
      routerKind: 'swaprouter02',
      feeTiers: [100, 500, 3000, 10000],
    },
    {
      // developer.pancakeswap.finance/contracts/v3/addresses (BNB Smart Chain); fee tiers from PancakeSwap's
      // "Building trading agents on PancakeSwap v3" doc.
      id: 'pancake-v3',
      label: 'PancakeSwap',
      factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
      quoterV2: '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997',
      router: '0x1b81d678ffb9c0263b24a97847620c99d213eb14',
      routerKind: 'v3-swaprouter',
      feeTiers: [100, 500, 2500, 10000],
    },
  ],
  mento: false,
  // docs.textilecredit.com/protocol/address-book, BSC section (cNGN ↔ USDT, 1 bps taker fee).
  textile: {
    chainId: 56,
    reactor: '0xe03261c0436db575f92f09eddf3591e2566b7d97',
    vaultOrderExecutor: '0x23d61c82e1c38a6f115d4f5a8807f88d271e05b4',
    feeController: '0xbda5e4d85674fc3a4566b1080a3c59dc2526c057',
    takerFeeBps: 1,
  },
};

export const CHAINS: Record<ChainKey, ChainConfig> = { celo: CELO, bsc: BSC };

export function chainByKey(key: string | undefined): ChainConfig {
  const k = (key ?? 'celo').toLowerCase();
  const c = CHAINS[k as ChainKey];
  if (!c) throw new Error(`unknown chain "${key}" (supported: ${Object.keys(CHAINS).join(', ')})`);
  return c;
}

