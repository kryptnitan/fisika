import { curveCapacity, curveOut, type TokenRegistry } from '@fisika/core';
import type { GraphState } from '@fisika/core/setup';

/** Where liquidity sits per corridor over time: direct-edge depth per venue, in USD of input, sampled every minute. */
export interface HeatSample {
  atMs: number;
  /** corridor "A-B" → venue → depth USD (deepest sampled size the venue could fill) */
  depth: Record<string, Record<string, number>>;
  /** Largest size sampled, in USD: a depth equal to this means "at least this much". */
  maxSampledUsd: number;
}

export class Heatmap {
  readonly samples: HeatSample[] = [];
  private readonly maxSamples: number;
  constructor(maxSamples = 24 * 60) {
    this.maxSamples = maxSamples;
  }

  record(st: GraphState, tokens: TokenRegistry, corridors: readonly (readonly [string, string])[], nowMs = Date.now()): void {
    const last = this.samples.at(-1);
    if (last && nowMs - last.atMs < 60_000) return;
    const depth: HeatSample['depth'] = {};
    for (const [a, b] of corridors) {
      const tin = tokens.bySymbol(a).address;
      const tout = tokens.bySymbol(b).address;
      const row: Record<string, number> = {};
      const edges = st.graph.between(tin, tout, nowMs, 60_000);
      // Depth only counts at a real price: a pool paying >20% less than the best venue is dust or broken
      // (same rule as the board's venue spread), however much it could technically absorb.
      const probe = st.pricer.amountForUsd(tin, 10, nowMs);
      const outAt = (pts: (typeof edges)[number]['points']) => (probe ? curveOut(pts, probe) : null);
      const best = edges.reduce((m, e) => {
        const o = outAt(e.points);
        return o !== null && o > m ? o : m;
      }, 0n);
      for (const e of edges) {
        const o = outAt(e.points);
        if (best > 0n && o !== null && o * 10n < best * 8n) continue;
        const usd = st.pricer.usdValue(tin, curveCapacity(e.points), nowMs);
        if (usd !== null) row[e.venue] = Math.max(row[e.venue] ?? 0, Math.round(usd));
      }
      depth[`${a}-${b}`] = row;
    }
    this.samples.push({ atMs: nowMs, depth, maxSampledUsd: 10_000 });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }
}
