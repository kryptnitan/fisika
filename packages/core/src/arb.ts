import { curveGas, curveOut } from './curve.ts';
import { edgeKey, type PriceGraph } from './graph.ts';
import type { Pricer } from './pricer.ts';
import { TX_BASE_GAS, simulatePath } from './router.ts';
import type { Address, Edge, VenueAdapter, VenueId } from './types.ts';

/* ------------------------------------------------------------------ detection */

/**
 * Bellman-Ford negative-cycle detection on w = -ln(rate at size). Rates are taken at the curve point for a
 * given USD notional, so a cycle that only exists for dust does not show up at $1k. Decimals cancel around a
 * cycle, so atomic-unit ratios are fine. Returns each distinct cycle found as an edge list.
 */
export function bellmanFordCycles(graph: PriceGraph, pricer: Pricer, sizeUsd: number, nowMs: number, maxAgeMs: number): Edge[][] {
  const edges: { e: Edge; w: number }[] = [];
  for (const e of graph.all()) {
    if (nowMs - e.asOfMs > maxAgeMs) continue;
    const amt = pricer.amountForUsd(e.tokenIn, sizeUsd, nowMs);
    if (!amt || amt === 0n) continue;
    const out = curveOut(e.points, amt);
    if (!out) continue;
    const rate = Number(out) / Number(amt);
    if (rate > 0) edges.push({ e, w: -Math.log(rate) });
  }
  const nodes = [...new Set(edges.flatMap(({ e }) => [e.tokenIn, e.tokenOut]))];
  const dist = new Map<string, number>(nodes.map((n) => [n, 0])); // virtual source to every node
  const pred = new Map<string, { e: Edge; w: number }>();
  let lastRelaxed: string | null = null;
  for (let i = 0; i < nodes.length; i++) {
    lastRelaxed = null;
    for (const x of edges) {
      const nd = dist.get(x.e.tokenIn)! + x.w;
      if (nd < dist.get(x.e.tokenOut)! - 1e-12) {
        dist.set(x.e.tokenOut, nd);
        pred.set(x.e.tokenOut, x);
        lastRelaxed = x.e.tokenOut;
      }
    }
    if (!lastRelaxed) return [];
  }
  // Any node relaxed on the n-th pass leads back into a negative cycle; walk preds to extract it.
  const cycles: Edge[][] = [];
  const seen = new Set<string>();
  for (const start of nodes) {
    let v: string = start;
    for (let i = 0; i < nodes.length; i++) v = pred.get(v)?.e.tokenIn ?? v;
    if (!pred.has(v)) continue;
    const cyc: Edge[] = [];
    let u = v;
    do {
      const p = pred.get(u);
      if (!p) break;
      cyc.unshift(p.e);
      u = p.e.tokenIn;
    } while (u !== v && cyc.length <= nodes.length);
    if (u !== v) continue;
    const key = cyc.map(edgeKey).sort().join('|');
    if (!seen.has(key)) {
      seen.add(key);
      cycles.push(cyc);
    }
  }
  return cycles;
}

/** Every simple cycle of length 2..maxLen starting and ending at `start`. Exact, and cheap on Celo-sized graphs. */
export function cyclesFrom(graph: PriceGraph, start: Address, maxLen: number, nowMs: number, maxAgeMs: number): Edge[][] {
  const s = start.toLowerCase();
  const res: Edge[][] = [];
  const stack: Edge[] = [];
  const visited = new Set<string>([s]);
  const dfs = (tok: string) => {
    if (stack.length >= maxLen) return;
    for (const e of graph.outgoing(tok, nowMs, maxAgeMs)) {
      if (e.tokenOut === s) {
        // A round trip through the same pool can never profit; skip it.
        const samePoolRoundTrip = stack.length === 1 && stack[0]!.venue === e.venue && stack[0]!.poolId === e.poolId;
        if (stack.length >= 1 && !samePoolRoundTrip) res.push([...stack, e]);
        continue;
      }
      if (visited.has(e.tokenOut)) continue;
      visited.add(e.tokenOut);
      stack.push(e);
      dfs(e.tokenOut);
      stack.pop();
      visited.delete(e.tokenOut);
    }
  };
  dfs(s);
  return res;
}

/** Rotate a cycle so it starts at the first token in `preferred` it touches (cycles are booked in USD tokens). */
export function rotateTo(cycle: readonly Edge[], preferred: readonly Address[]): Edge[] | null {
  for (const p of preferred) {
    const i = cycle.findIndex((e) => e.tokenIn === p.toLowerCase());
    if (i >= 0) return [...cycle.slice(i), ...cycle.slice(0, i)];
  }
  return null;
}

/* ------------------------------------------------------------------ evaluation */

export interface ArbConfig {
  startTokens: Address[];
  sizesUsd: number[];
  maxLen: number;
  maxAgeMs: number;
  minEdgeBps: number;
  minEdgeUsd: number;
  maxTradeUsd: number;
  slippageBps: number;
  dailyLossLimitUsd: number;
  maxTokenExposureUsd: number;
  textileAtomic: boolean;
  gasPriceWei: bigint;
  celoUsd: number;
}

export interface Opportunity {
  id: string;
  cycle: Edge[];
  start: Address;
  amountIn: bigint;
  /** Token amounts entering each leg, then the final amount back in `start`. */
  amounts: bigint[];
  grossProfit: bigint;
  gasUnits: bigint;
  gasInStart: bigint;
  netProfit: bigint;
  netBps: number;
  netUsd: number;
  txCount: number;
  venues: VenueId[];
  indicativeLegs: number;
  sizeUsd: number;
}

function cycleTxCount(cycle: readonly Edge[], textileAtomic: boolean): number {
  if (textileAtomic || !cycle.some((e) => e.venue === 'textile')) return 1;
  let txs = 0;
  let inSeg = false;
  for (const e of cycle) {
    if (e.venue === 'textile') {
      txs++;
      inSeg = false;
    } else if (!inSeg) {
      txs++;
      inSeg = true;
    }
  }
  return txs;
}

/** Exact BigInt evaluation of a cycle at one size. The cycle starts and ends in the same token: no FX price in P&L. */
export function evaluateCycle(cycle: Edge[], amountIn: bigint, pricer: Pricer, cfg: ArbConfig, nowMs: number, sizeUsd: number): Opportunity | null {
  const amounts = simulatePath(cycle, amountIn);
  if (!amounts) return null;
  const start = cycle[0]!.tokenIn;
  const final = amounts[amounts.length - 1]!;
  const txCount = cycleTxCount(cycle, cfg.textileAtomic);
  const gasUnits = cycle.reduce((s, e, i) => s + curveGas(e.points, amounts[i]!, e.gasUnits), 0n) + TX_BASE_GAS * BigInt(txCount);
  const gasUsd = (Number(gasUnits * cfg.gasPriceWei) / 1e18) * cfg.celoUsd;
  const gasInStart = pricer.amountForUsd(start, gasUsd, nowMs);
  if (gasInStart === null) return null;
  const grossProfit = final - amountIn;
  const netProfit = grossProfit - gasInStart;
  const netBps = Number((netProfit * 1_000_000n) / amountIn) / 100;
  const netUsd = pricer.usdValue(start, netProfit < 0n ? -netProfit : netProfit, nowMs)! * (netProfit < 0n ? -1 : 1);
  return {
    id: `${cycle.map(edgeKey).join('>')}@${sizeUsd}`,
    cycle,
    start,
    amountIn,
    amounts,
    grossProfit,
    gasUnits,
    gasInStart,
    netProfit,
    netBps,
    netUsd,
    txCount,
    venues: [...new Set(cycle.map((e) => e.venue))],
    indicativeLegs: cycle.filter((e) => !e.firm).length,
    sizeUsd,
  };
}

/* ------------------------------------------------------------------ risk */

export interface RiskState {
  dayKey: string;
  realizedUsd: number;
  halted: boolean;
  haltReason?: string;
}

export type RiskVerdict = { ok: true } | { ok: false; reason: string };

export class RiskGate {
  state: RiskState;
  private readonly cfg: ArbConfig;
  private readonly killSwitch: () => boolean;
  private readonly pricer: Pricer;

  constructor(cfg: ArbConfig, pricer: Pricer, killSwitch: () => boolean, state?: RiskState) {
    this.cfg = cfg;
    this.pricer = pricer;
    this.killSwitch = killSwitch;
    this.state = state ?? { dayKey: '', realizedUsd: 0, halted: false };
  }

  private roll(nowMs: number) {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (day !== this.state.dayKey) {
      // A loss-limit halt persists across the day boundary until a human clears it.
      this.state = { dayKey: day, realizedUsd: 0, halted: this.state.halted, haltReason: this.state.haltReason };
    }
  }

  check(o: Opportunity, nowMs: number): RiskVerdict {
    this.roll(nowMs);
    if (this.killSwitch()) return { ok: false, reason: 'kill_switch' };
    if (this.state.halted) return { ok: false, reason: `halted: ${this.state.haltReason}` };
    if (o.sizeUsd > this.cfg.maxTradeUsd) return { ok: false, reason: 'size_above_max' };
    if (o.netBps < this.cfg.minEdgeBps) return { ok: false, reason: 'edge_bps_below_min' };
    if (o.netUsd < this.cfg.minEdgeUsd) return { ok: false, reason: 'edge_usd_below_min' };
    if (o.cycle.some((e) => nowMs - e.asOfMs > this.cfg.maxAgeMs)) return { ok: false, reason: 'stale_edge' };
    if (o.txCount > 1) {
      // Multi-tx cycles leave us holding intermediate tokens between transactions: cap that exposure.
      for (let i = 1; i < o.cycle.length; i++) {
        const tok = o.cycle[i]!.tokenIn;
        const usd = this.pricer.usdValue(tok, o.amounts[i]!, nowMs);
        if (usd === null || usd > this.cfg.maxTokenExposureUsd) return { ok: false, reason: 'inventory_exposure' };
      }
    }
    return { ok: true };
  }

  /** Record a realized result; trips the daily loss halt. */
  record(pnlUsd: number, nowMs: number): void {
    this.roll(nowMs);
    this.state.realizedUsd += pnlUsd;
    if (this.state.realizedUsd <= -this.cfg.dailyLossLimitUsd) {
      this.state.halted = true;
      this.state.haltReason = `daily loss ${this.state.realizedUsd.toFixed(2)} USD`;
    }
  }

  clearHalt(): void {
    this.state.halted = false;
    this.state.haltReason = undefined;
  }
}

/* ------------------------------------------------------------------ engine */

export interface ArbFill {
  opportunity: Opportunity;
  mode: 'PAPER' | 'LIVE';
  confirmedAmounts: bigint[];
  realizedProfit: bigint;
  realizedUsd: number;
  minOut: bigint;
  atMs: number;
}

export interface ArbDecision {
  opportunity: Opportunity;
  /** PAPER: filled | skipped. LIVE: ready (confirmed, passed every gate, caller executes) | skipped. */
  action: 'filled' | 'skipped' | 'ready';
  reason?: string;
  fill?: ArbFill;
}

/** Live re-quote of every leg at the exact running amount, through the venue adapters. */
export async function confirmCycle(o: Opportunity, adapters: ReadonlyMap<VenueId, VenueAdapter>): Promise<bigint[] | null> {
  const amounts = [o.amountIn];
  let a = o.amountIn;
  for (const e of o.cycle) {
    const ad = adapters.get(e.venue);
    if (!ad) return null;
    const q = await ad.quote(e.tokenIn, e.tokenOut, a).catch(() => null);
    if (!q || q.amountOut === 0n) return null;
    a = q.amountOut;
    amounts.push(a);
  }
  return amounts;
}

export class ArbEngine {
  private readonly graph: PriceGraph;
  private readonly pricer: Pricer;
  private readonly adapters: ReadonlyMap<VenueId, VenueAdapter>;
  readonly risk: RiskGate;
  readonly cfg: ArbConfig;
  private readonly mode: 'PAPER' | 'LIVE';
  /**
   * PAPER only: fingerprints (cycle + every leg's price curve) of opportunities already paper-filled. A real fill
   * consumes the liquidity it trades against; until a curve changes, the same opportunity is not there again.
   */
  consumed = new Map<string, number>();

  constructor(graph: PriceGraph, pricer: Pricer, adapters: ReadonlyMap<VenueId, VenueAdapter>, risk: RiskGate, cfg: ArbConfig, mode: 'PAPER' | 'LIVE' = 'PAPER') {
    this.graph = graph;
    this.pricer = pricer;
    this.adapters = adapters;
    this.risk = risk;
    this.cfg = cfg;
    this.mode = mode;
  }

  /** Detect: Bellman-Ford at each size, plus exact enumeration from each start token. Best size per cycle. */
  scan(nowMs: number): Opportunity[] {
    const cycles = new Map<string, Edge[]>();
    const add = (c: Edge[] | null) => {
      if (c && c.length <= this.cfg.maxLen) cycles.set(c.map(edgeKey).join('>'), c);
    };
    for (const size of this.cfg.sizesUsd) {
      for (const c of bellmanFordCycles(this.graph, this.pricer, size, nowMs, this.cfg.maxAgeMs)) add(rotateTo(c, this.cfg.startTokens));
    }
    for (const s of this.cfg.startTokens) for (const c of cyclesFrom(this.graph, s, this.cfg.maxLen, nowMs, this.cfg.maxAgeMs)) add(c);

    const best: Opportunity[] = [];
    for (const cycle of cycles.values()) {
      let top: Opportunity | null = null;
      for (const size of this.cfg.sizesUsd) {
        const amt = this.pricer.amountForUsd(cycle[0]!.tokenIn, size, nowMs);
        if (!amt) continue;
        const o = evaluateCycle(cycle, amt, this.pricer, this.cfg, nowMs, size);
        if (o && (!top || o.netUsd > top.netUsd)) top = o;
      }
      if (top && top.netProfit > 0n) best.push(top);
    }
    return best.sort((a, b) => b.netUsd - a.netUsd);
  }

  /** One engine tick: scan, confirm the best few with live quotes, gate, and fill (paper or live). */
  async tick(nowMs: number, maxConfirm = 3): Promise<ArbDecision[]> {
    const out: ArbDecision[] = [];
    for (const [k, t] of this.consumed) if (nowMs - t > 3_600_000) this.consumed.delete(k);
    for (const o of this.scan(nowMs).slice(0, maxConfirm)) {
      const fp = `${o.id}|${o.cycle.map((e) => e.points.map((p) => `${p.amountIn}:${p.amountOut}`).join(',')).join('|')}`;
      if (this.consumed.has(fp)) {
        out.push({ opportunity: o, action: 'skipped', reason: 'already_filled_prices_unchanged' });
        continue;
      }
      const pre = this.risk.check(o, nowMs);
      if (!pre.ok) {
        out.push({ opportunity: o, action: 'skipped', reason: pre.reason });
        continue;
      }
      const confirmed = await confirmCycle(o, this.adapters);
      if (!confirmed) {
        out.push({ opportunity: o, action: 'skipped', reason: 'requote_failed' });
        continue;
      }
      const realized = evaluateCycleAmounts(o, confirmed, this.pricer, nowMs);
      const post = this.risk.check(realized, nowMs);
      if (!post.ok) {
        out.push({ opportunity: realized, action: 'skipped', reason: `after_requote: ${post.reason}` });
        continue;
      }
      if (this.mode === 'LIVE') {
        // LIVE: hand the confirmed opportunity to the caller's executor; P&L is recorded from real balances.
        out.push({ opportunity: realized, action: 'ready' });
        this.consumed.set(fp, nowMs);
        continue;
      }
      const minOut = o.amountIn + o.gasInStart + (o.amountIn * BigInt(Math.ceil(this.cfg.minEdgeBps))) / 10_000n;
      const fill: ArbFill = {
        opportunity: realized,
        mode: 'PAPER',
        confirmedAmounts: confirmed,
        realizedProfit: realized.netProfit,
        realizedUsd: realized.netUsd,
        minOut,
        atMs: nowMs,
      };
      this.risk.record(fill.realizedUsd, nowMs);
      this.consumed.set(fp, nowMs);
      out.push({ opportunity: realized, action: 'filled', fill });
    }
    return out;
  }
}

/** Re-evaluate an opportunity with confirmed leg amounts. */
function evaluateCycleAmounts(o: Opportunity, amounts: bigint[], pricer: Pricer, nowMs: number): Opportunity {
  const final = amounts[amounts.length - 1]!;
  const grossProfit = final - o.amountIn;
  const netProfit = grossProfit - o.gasInStart;
  const abs = netProfit < 0n ? -netProfit : netProfit;
  return {
    ...o,
    amounts,
    grossProfit,
    netProfit,
    netBps: Number((netProfit * 1_000_000n) / o.amountIn) / 100,
    netUsd: (pricer.usdValue(o.start, abs, nowMs) ?? 0) * (netProfit < 0n ? -1 : 1),
  };
}
