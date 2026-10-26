import { curveCapacity, type TokenRegistry } from '@fisika/core';
import type { GraphState } from '@fisika/core/setup';

/** Where liquidity sits per corridor over time: direct-edge depth per venue, in USD of input, sampled every minute. */
export interface HeatSample {
  atMs: number;
  /** corridor "A-B" → venue → depth USD (deepest sampled size the venue could fill) */
  depth: Record<string, Record<string, number>>;
}

export class Heatmap {
  readonly samples: HeatSample[] = [];
  private readonly maxSamples: number;
  constructor(maxSamples = 24 * 60) {
    this.maxSamples = maxSamples;
  }

  record(st: GraphState, tokens: TokenRegistry, corridors: [string, string][], nowMs = Date.now()): void {
    const last = this.samples.at(-1);
    if (last && nowMs - last.atMs < 60_000) return;
    const depth: HeatSample['depth'] = {};
    for (const [a, b] of corridors) {
      const tin = tokens.bySymbol(a).address;
      const tout = tokens.bySymbol(b).address;
      const row: Record<string, number> = {};
      for (const e of st.graph.between(tin, tout, nowMs, 60_000)) {
        const usd = st.pricer.usdValue(tin, curveCapacity(e.points), nowMs);
        if (usd !== null) row[e.venue] = Math.max(row[e.venue] ?? 0, Math.round(usd));
      }
      depth[`${a}-${b}`] = row;
    }
    this.samples.push({ atMs: nowMs, depth });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }
}
