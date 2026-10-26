import { UNISWAP_V3 } from '../addresses.ts';
import type { Address, Edge, EdgeContext, Quote, VenueAdapter } from '../types.ts';

/** The chain reads this adapter needs. Implemented with viem in chain/viem.ts, mocked in tests. */
export interface UniV3Reader {
  /** factory.getPool; null for the zero address. */
  getPool(tokenA: Address, tokenB: Address, fee: number): Promise<Address | null>;
  /** QuoterV2.quoteExactInputSingle via eth_call; null when it reverts (no liquidity in range, etc.). */
  quoteExactInputSingle(p: { tokenIn: Address; tokenOut: Address; amountIn: bigint; fee: number }): Promise<{ amountOut: bigint; gasEstimate: bigint } | null>;
  blockNumber(): Promise<bigint>;
}

export interface UniV3Pool {
  address: Address;
  token0: Address;
  token1: Address;
  fee: number;
}

/** Quotes are valid for the block they were read at; one block is ~1 s on Celo. */
const QUOTE_TTL_MS = 2_000;

export class UniswapV3Adapter implements VenueAdapter {
  readonly id = 'uniswap-v3' as const;
  private pools: UniV3Pool[] = [];
  private readonly reader: UniV3Reader;
  private readonly feeTiers: readonly number[];

  constructor(reader: UniV3Reader, feeTiers: readonly number[] = UNISWAP_V3.feeTiers) {
    this.reader = reader;
    this.feeTiers = feeTiers;
  }

  /** Find every pool for the configured pairs across all fee tiers. Run at boot and periodically. */
  async discover(pairs: readonly [Address, Address][]): Promise<UniV3Pool[]> {
    const found: UniV3Pool[] = [];
    const jobs = pairs.flatMap(([a, b]) =>
      this.feeTiers.map(async (fee) => {
        const pool = await this.reader.getPool(a, b, fee).catch(() => null);
        if (!pool || found.some((p) => p.address === pool.toLowerCase())) return;
        const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
        found.push({ address: pool.toLowerCase() as Address, token0: t0.toLowerCase() as Address, token1: t1.toLowerCase() as Address, fee });
      }),
    );
    await Promise.all(jobs);
    this.pools = found;
    return found;
  }

  knownPools(): readonly UniV3Pool[] {
    return this.pools;
  }

  async fetchEdges(ctx: EdgeContext): Promise<Edge[]> {
    const block = await this.reader.blockNumber().catch(() => undefined);
    const edges: Edge[] = [];
    await Promise.all(
      this.pools.flatMap((pool) =>
        ([[pool.token0, pool.token1], [pool.token1, pool.token0]] as const).map(async ([tokenIn, tokenOut]) => {
          const sizes = ctx.sampleAmounts(tokenIn);
          if (!sizes?.length) return;
          const points: Edge['points'] = [];
          let gas = 0n;
          for (const amountIn of sizes) {
            const q = await this.reader.quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee: pool.fee }).catch(() => null);
            if (!q || q.amountOut === 0n) break; // deeper sizes will not do better
            points.push({ amountIn, amountOut: q.amountOut, gas: q.gasEstimate });
            if (q.gasEstimate > gas) gas = q.gasEstimate;
          }
          if (!points.length) return;
          edges.push({
            venue: this.id,
            poolId: pool.address,
            tokenIn,
            tokenOut,
            points,
            gasUnits: gas,
            feeBps: pool.fee / 100,
            firm: true,
            asOfMs: ctx.nowMs,
            asOfBlock: block,
            meta: { fee: pool.fee },
          });
        }),
      ),
    );
    return edges;
  }

  /** Best single-pool quote at an exact size. */
  async quote(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote | null> {
    const i = tokenIn.toLowerCase();
    const o = tokenOut.toLowerCase();
    const candidates = this.pools.filter((p) => (p.token0 === i && p.token1 === o) || (p.token0 === o && p.token1 === i));
    let best: Quote | null = null;
    for (const pool of candidates) {
      const q = await this.reader.quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee: pool.fee }).catch(() => null);
      if (!q) continue;
      if (!best || q.amountOut > best.amountOut) {
        best = { amountOut: q.amountOut, gasEstimate: q.gasEstimate, expiry: Date.now() + QUOTE_TTL_MS, firm: true, feeBps: pool.fee / 100, source: pool.address };
      }
    }
    return best;
  }
}
