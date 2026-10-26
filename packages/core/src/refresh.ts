import type { PriceGraph } from './graph.ts';
import type { Pricer } from './pricer.ts';
import type { Address, VenueAdapter, VenueId } from './types.ts';

export interface RefreshResult {
  venue: VenueId;
  ok: boolean;
  edges: number;
  ms: number;
  error?: string;
}

/**
 * One graph refresh across all venues. A failing venue keeps its previous edges, which then age out through
 * the router's freshness check instead of vanishing instantly on a transient RPC error.
 */
export async function refreshGraph(graph: PriceGraph, pricer: Pricer, adapters: readonly VenueAdapter[], nowMs = Date.now()): Promise<RefreshResult[]> {
  const ctx = { nowMs, sampleAmounts: (t: Address) => pricer.sampleAmounts(t, nowMs) };
  return Promise.all(
    adapters.map(async (a): Promise<RefreshResult> => {
      const t0 = Date.now();
      try {
        const edges = await a.fetchEdges(ctx);
        graph.replaceVenue(a.id, edges);
        return { venue: a.id, ok: true, edges: edges.length, ms: Date.now() - t0 };
      } catch (err) {
        return { venue: a.id, ok: false, edges: 0, ms: Date.now() - t0, error: (err as Error).message };
      }
    }),
  );
}
