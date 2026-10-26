import { PriceGraph } from '../src/graph.ts';
import { Pricer } from '../src/pricer.ts';
import { TokenRegistry, type TokenInfo } from '../src/tokens.ts';
import type { Address, Edge, VenueId } from '../src/types.ts';

export const A = {
  USDT: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e' as Address,
  USDC: '0xceba9300f2b948710d2653dd7b07f33a8b32118c' as Address,
  USDm: '0x765de816845861e75a25fca122bb6898b8b1282a' as Address,
  cNGN: '0xf6829d7393dae24509eb1e52ee8e572e2e271a4f' as Address,
  wBRL: '0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0' as Address,
  wARS: '0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d' as Address,
};

export function testTokens(): TokenRegistry {
  return new TokenRegistry();
}

export const U6 = (n: number) => BigInt(Math.round(n * 1e6));
export const U18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/**
 * Constant-product curve sampled at given input sizes, with a fee. reserveIn/Out in atomic units.
 * Gives realistic concave curves for routing tests.
 */
export function cpEdge(
  venue: VenueId,
  poolId: string,
  tokenIn: Address,
  tokenOut: Address,
  reserveIn: bigint,
  reserveOut: bigint,
  sizes: bigint[],
  feeBps = 5,
  extra: Partial<Edge> = {},
): Edge {
  const points = sizes.map((x) => {
    const xf = (x * BigInt(10_000 - feeBps)) / 10_000n;
    return { amountIn: x, amountOut: (reserveOut * xf) / (reserveIn + xf) };
  });
  return { venue, poolId, tokenIn, tokenOut, points, gasUnits: 150_000n, feeBps, firm: venue !== 'textile', asOfMs: 1_000, ...extra };
}

export function setup(edges: Edge[]): { graph: PriceGraph; pricer: Pricer; tokens: TokenRegistry } {
  const tokens = testTokens();
  const graph = new PriceGraph();
  for (const e of edges) graph.upsert(e);
  const pricer = new Pricer(tokens, graph, 60_000);
  return { graph, pricer, tokens };
}

export const NOW = 2_000;
export const GAS = { gasPriceWei: 25_000_000_000n, celoUsd: 0.08 };
export type { TokenInfo };
