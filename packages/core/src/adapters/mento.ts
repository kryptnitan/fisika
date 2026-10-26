import type { Address, Edge, EdgeContext, Quote, VenueAdapter } from '../types.ts';

/**
 * The chain reads this adapter needs from Mento. The viem implementation (chain/viem.ts) calls the v3 Router;
 * its exact ABI is confirmed by scripts/verify-onchain.ts against the live USDC/USDm FPMM before use.
 */
export interface MentoReader {
  /** Single-hop amount out through the Mento Router, or null if the pair is not tradable / reverts. */
  getAmountOut(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint | null>;
  /** Circuit breakers, market hours and trading limits all allow this pair right now. */
  isTradable(tokenIn: Address, tokenOut: Address): Promise<boolean>;
  blockNumber(): Promise<bigint>;
}

export interface MentoPair {
  tokenA: Address;
  tokenB: Address;
  poolId: string;
  /** Pool fee if known from on-chain reads; used for display only, quotes are already net. */
  feeBps?: number;
}

/** Placeholder until measured on a fork; refreshed from the fork gas report in CI. */
export const MENTO_SWAP_GAS_ESTIMATE = 180_000n;
const QUOTE_TTL_MS = 2_000;

export class MentoAdapter implements VenueAdapter {
  readonly id: 'mento' | 'mento-v2';

  private readonly reader: MentoReader;
  private readonly pairs: readonly MentoPair[];

  /** One instance per Mento generation: 'mento' = v3 Router (FPMM), 'mento-v2' = v2 Broker exchanges. */
  constructor(reader: MentoReader, pairs: readonly MentoPair[], id: 'mento' | 'mento-v2' = 'mento') {
    this.reader = reader;
    this.pairs = pairs;
    this.id = id;
  }

  async fetchEdges(ctx: EdgeContext): Promise<Edge[]> {
    const block = await this.reader.blockNumber().catch(() => undefined);
    const edges: Edge[] = [];
    await Promise.all(
      this.pairs.flatMap((pair) =>
        ([[pair.tokenA, pair.tokenB], [pair.tokenB, pair.tokenA]] as const).map(async ([tokenIn, tokenOut]) => {
          // A paused or limit-hit pair must not appear in the graph at all.
          if (!(await this.reader.isTradable(tokenIn, tokenOut).catch(() => false))) return;
          const sizes = ctx.sampleAmounts(tokenIn);
          if (!sizes?.length) return;
          const points: Edge['points'] = [];
          for (const amountIn of sizes) {
            const out = await this.reader.getAmountOut(tokenIn, tokenOut, amountIn).catch(() => null);
            if (!out) break; // trading limit or depth reached
            points.push({ amountIn, amountOut: out });
          }
          if (!points.length) return;
          edges.push({
            venue: this.id,
            poolId: pair.poolId.toLowerCase(),
            tokenIn: tokenIn.toLowerCase() as Address,
            tokenOut: tokenOut.toLowerCase() as Address,
            points,
            gasUnits: MENTO_SWAP_GAS_ESTIMATE,
            feeBps: pair.feeBps ?? 0,
            firm: true,
            asOfMs: ctx.nowMs,
            asOfBlock: block,
          });
        }),
      ),
    );
    return edges;
  }

  async quote(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote | null> {
    const i = tokenIn.toLowerCase();
    const o = tokenOut.toLowerCase();
    const pair = this.pairs.find((p) => {
      const a = p.tokenA.toLowerCase();
      const b = p.tokenB.toLowerCase();
      return (a === i && b === o) || (a === o && b === i);
    });
    if (!pair) return null;
    if (!(await this.reader.isTradable(tokenIn, tokenOut).catch(() => false))) return null;
    const out = await this.reader.getAmountOut(tokenIn, tokenOut, amountIn).catch(() => null);
    if (!out) return null;
    return { amountOut: out, gasEstimate: MENTO_SWAP_GAS_ESTIMATE, expiry: Date.now() + QUOTE_TTL_MS, firm: true, feeBps: pair.feeBps ?? 0, source: pair.poolId };
  }
}
