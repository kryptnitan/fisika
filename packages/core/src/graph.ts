import { normalizeCurve } from './curve.ts';
import type { Address, Edge, VenueId } from './types.ts';

const lc = (a: string) => a.toLowerCase() as Address;

export function edgeKey(e: Pick<Edge, 'venue' | 'poolId' | 'tokenIn' | 'tokenOut'>): string {
  return `${e.venue}:${e.poolId}:${e.tokenIn}:${e.tokenOut}`.toLowerCase();
}

/** Serializable form for Redis / Postgres. */
export interface EdgeSnapshot extends Omit<Edge, 'points' | 'gasUnits' | 'asOfBlock'> {
  points: { amountIn: string; amountOut: string }[];
  gasUnits: string;
  asOfBlock?: string;
}

export class PriceGraph {
  private edges = new Map<string, Edge>();

  upsert(e: Edge): void {
    const points = normalizeCurve(e.points);
    if (!points.length) return;
    const edge: Edge = { ...e, tokenIn: lc(e.tokenIn), tokenOut: lc(e.tokenOut), points };
    this.edges.set(edgeKey(edge), edge);
  }

  /** Replace every edge of one venue, so pools that disappeared stop being routed through. */
  replaceVenue(venue: VenueId, edges: readonly Edge[]): void {
    for (const [k, e] of this.edges) if (e.venue === venue) this.edges.delete(k);
    for (const e of edges) this.upsert(e);
  }

  outgoing(token: string, nowMs: number, maxAgeMs: number): Edge[] {
    const t = lc(token);
    const res: Edge[] = [];
    for (const e of this.edges.values()) {
      if (e.tokenIn === t && nowMs - e.asOfMs <= maxAgeMs) res.push(e);
    }
    return res;
  }

  between(tokenIn: string, tokenOut: string, nowMs: number, maxAgeMs: number): Edge[] {
    const o = lc(tokenOut);
    return this.outgoing(tokenIn, nowMs, maxAgeMs).filter((e) => e.tokenOut === o);
  }

  all(): Edge[] {
    return [...this.edges.values()];
  }

  size(): number {
    return this.edges.size;
  }

  snapshot(): EdgeSnapshot[] {
    return this.all().map((e) => ({
      ...e,
      points: e.points.map((p) => ({ amountIn: p.amountIn.toString(), amountOut: p.amountOut.toString() })),
      gasUnits: e.gasUnits.toString(),
      asOfBlock: e.asOfBlock?.toString(),
    }));
  }

  static fromSnapshot(snap: readonly EdgeSnapshot[]): PriceGraph {
    const g = new PriceGraph();
    for (const s of snap) {
      g.upsert({
        ...s,
        points: s.points.map((p) => ({ amountIn: BigInt(p.amountIn), amountOut: BigInt(p.amountOut) })),
        gasUnits: BigInt(s.gasUnits),
        asOfBlock: s.asOfBlock === undefined ? undefined : BigInt(s.asOfBlock),
      });
    }
    return g;
  }
}
