import { curveOut } from './curve.ts';
import { edgeKey, type PriceGraph } from './graph.ts';
import type { Pricer } from './pricer.ts';
import type { Address, Edge, VenueId } from './types.ts';

/** Gas for the transaction envelope and executor bookkeeping, charged once per transaction. */
export const TX_BASE_GAS = 60_000n;

export interface RouteRequest {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  nowMs: number;
  maxAgeMs?: number;
  maxHops?: number;
  /** Cap on enumerated paths, bounding work on dense graphs. */
  maxPaths?: number;
  /** Max edge-disjoint paths an order may be split across. */
  splitCandidates?: number;
  /** Number of equal chunks used by the greedy splitter. */
  chunks?: number;
  slippageBps?: number;
  /** fisika service fee, taken from output. 0 for the arb engine. */
  feeBps?: number;
  gasPriceWei: bigint;
  /** USD per CELO, for converting gas into output-token units. */
  celoUsd: number;
  /** Whether Textile legs can settle inside the executor (requires the rfq:aggregator key). */
  textileAtomic?: boolean;
}

export interface PathFill {
  edges: Edge[];
  amountIn: bigint;
  amountOut: bigint;
  /** Amount entering each hop, then the final output: length = edges.length + 1. */
  hopAmounts: bigint[];
}

export interface Route {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  paths: PathFill[];
  grossOut: bigint;
  serviceFee: bigint;
  gasUnits: bigint;
  gasUsd: number;
  /** Gas expressed in tokenOut atomic units (0 when tokenOut is unpriced; see gasUnpriced). */
  gasInOut: bigint;
  gasUnpriced: boolean;
  /** What the taker receives, after service fee. Gas is paid separately by the sender, so it is NOT deducted here. */
  amountOut: bigint;
  /** amountOut minus gas-in-output: the figure routes are ranked by. */
  netValueOut: bigint;
  minOut: bigint;
  /**
   * atomic: one FisikaExecutor call. textile-direct: a single Textile settlement tx sent by the taker.
   * multi-tx: Textile legs need their own transactions, sequenced around executor calls.
   */
  execution: 'atomic' | 'textile-direct' | 'multi-tx';
  txCount: number;
  allFirm: boolean;
  venues: VenueId[];
  asOfMs: number;
}

/** Simulate a whole path. Null if any hop lacks depth. */
export function simulatePath(path: readonly Edge[], amountIn: bigint): bigint[] | null {
  const amounts = [amountIn];
  let a = amountIn;
  for (const e of path) {
    const out = curveOut(e.points, a);
    if (out === null || out === 0n) return null;
    a = out;
    amounts.push(a);
  }
  return amounts;
}

/** Bounded DFS over fresh edges. No token is visited twice, so paths are simple. */
export function enumeratePaths(graph: PriceGraph, req: RouteRequest): Edge[][] {
  const maxHops = req.maxHops ?? 3;
  const maxPaths = req.maxPaths ?? 128;
  const maxAge = req.maxAgeMs ?? 10_000;
  const target = req.tokenOut.toLowerCase();
  const res: Edge[][] = [];
  const visited = new Set<string>([req.tokenIn.toLowerCase()]);
  const stack: Edge[] = [];

  const dfs = (token: string) => {
    if (res.length >= maxPaths || stack.length >= maxHops) return;
    for (const e of graph.outgoing(token, req.nowMs, maxAge)) {
      if (res.length >= maxPaths) return;
      if (e.tokenOut === target) {
        res.push([...stack, e]);
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
  dfs(req.tokenIn.toLowerCase());
  return res;
}

/** Transactions needed to execute a path: Textile hops break atomicity unless the aggregator key is live. */
function pathTxCount(path: readonly Edge[], textileAtomic: boolean): number {
  if (textileAtomic) return 1;
  let txs = 0;
  let inAtomicSegment = false;
  for (const e of path) {
    if (e.venue === 'textile') {
      txs += 1;
      inAtomicSegment = false;
    } else if (!inAtomicSegment) {
      txs += 1;
      inAtomicSegment = true;
    }
  }
  return txs;
}

function pathGas(path: readonly Edge[], textileAtomic: boolean): bigint {
  const hops = path.reduce((s, e) => s + e.gasUnits, 0n);
  return hops + TX_BASE_GAS * BigInt(pathTxCount(path, textileAtomic));
}

function sharesEdge(a: readonly Edge[], b: readonly Edge[]): boolean {
  const keys = new Set(a.map(edgeKey));
  return b.some((e) => keys.has(edgeKey(e)));
}

/**
 * Best route for an exact input. Splits across up to `splitCandidates` edge-disjoint paths using greedy
 * marginal allocation: each chunk goes where it adds the most output, and opening a new path is charged its
 * gas. Edge-disjointness keeps each path's curve independent, so the marginal maths is exact per path.
 */
export function bestRoute(graph: PriceGraph, pricer: Pricer, req: RouteRequest): Route | null {
  if (req.amountIn <= 0n) return null;
  const textileAtomic = req.textileAtomic ?? false;
  const chunks = BigInt(Math.max(1, req.chunks ?? 20));
  const K = Math.max(1, req.splitCandidates ?? 4);
  const feeBps = BigInt(req.feeBps ?? 0);
  const slippageBps = BigInt(req.slippageBps ?? 30);

  const gasToOut = (gas: bigint): { out: bigint; usd: number; unpriced: boolean } => {
    const usd = (Number(gas * req.gasPriceWei) / 1e18) * req.celoUsd;
    const out = pricer.amountForUsd(req.tokenOut, usd, req.nowMs);
    return { out: out ?? 0n, usd, unpriced: out === null };
  };

  const paths = enumeratePaths(graph, req);
  if (!paths.length) return null;

  // Rank paths by value at one chunk (the size they will first be tested at), then keep edge-disjoint top K.
  const chunk = req.amountIn / chunks || req.amountIn;
  const ranked = paths
    .map((p) => {
      const sim = simulatePath(p, chunk);
      const out = sim ? sim[sim.length - 1]! : null;
      return { p, score: out === null ? null : out - gasToOut(pathGas(p, textileAtomic)).out };
    })
    .filter((r): r is { p: Edge[]; score: bigint } => r.score !== null)
    .sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : 0));

  const candidates: Edge[][] = [];
  for (const r of ranked) {
    if (candidates.length >= K) break;
    if (candidates.some((c) => sharesEdge(c, r.p))) continue;
    candidates.push(r.p);
  }
  if (!candidates.length) return null;

  const alloc = candidates.map(() => 0n);
  const outs = candidates.map(() => 0n);
  const gasOut = candidates.map((p) => gasToOut(pathGas(p, textileAtomic)).out);

  let remaining = req.amountIn;
  while (remaining > 0n) {
    const step = remaining < chunk * 2n ? remaining : chunk; // last chunk absorbs rounding
    let bestIdx = -1;
    let bestMarg: bigint | null = null;
    let bestNewOut = 0n;
    for (let i = 0; i < candidates.length; i++) {
      const sim = simulatePath(candidates[i]!, alloc[i]! + step);
      if (!sim) continue;
      const newOut = sim[sim.length - 1]!;
      const marg = newOut - outs[i]! - (alloc[i] === 0n ? gasOut[i]! : 0n);
      if (bestMarg === null || marg > bestMarg) {
        bestMarg = marg;
        bestIdx = i;
        bestNewOut = newOut;
      }
    }
    if (bestIdx < 0) return null; // not enough depth across all candidate paths for this size
    alloc[bestIdx] = alloc[bestIdx]! + step;
    outs[bestIdx] = bestNewOut;
    remaining -= step;
  }

  const fills: PathFill[] = [];
  let gasUnits = 0n;
  let txCount = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (alloc[i] === 0n) continue;
    const hopAmounts = simulatePath(candidates[i]!, alloc[i]!)!;
    fills.push({ edges: candidates[i]!, amountIn: alloc[i]!, amountOut: hopAmounts[hopAmounts.length - 1]!, hopAmounts });
    gasUnits += pathGas(candidates[i]!, textileAtomic);
    txCount += pathTxCount(candidates[i]!, textileAtomic);
  }
  // Without Textile legs, every path's hops fit in one executor call, so only one tx base cost applies.
  const hasNonAtomicTextile = !textileAtomic && fills.some((f) => f.edges.some((e) => e.venue === 'textile'));
  if (!hasNonAtomicTextile) {
    gasUnits -= TX_BASE_GAS * BigInt(txCount - 1);
    txCount = 1;
  }
  const execution: Route['execution'] = txCount > 1 ? 'multi-tx' : hasNonAtomicTextile ? 'textile-direct' : 'atomic';

  const grossOut = fills.reduce((s, f) => s + f.amountOut, 0n);
  const serviceFee = (grossOut * feeBps) / 10_000n;
  const amountOut = grossOut - serviceFee;
  const gas = gasToOut(gasUnits);
  const edges = fills.flatMap((f) => f.edges);

  return {
    tokenIn: req.tokenIn,
    tokenOut: req.tokenOut,
    amountIn: req.amountIn,
    paths: fills,
    grossOut,
    serviceFee,
    gasUnits,
    gasUsd: gas.usd,
    gasInOut: gas.out,
    gasUnpriced: gas.unpriced,
    amountOut,
    netValueOut: amountOut - gas.out,
    minOut: (amountOut * (10_000n - slippageBps)) / 10_000n,
    execution,
    txCount,
    allFirm: edges.every((e) => e.firm),
    venues: [...new Set(edges.map((e) => e.venue))],
    asOfMs: Math.min(...edges.map((e) => e.asOfMs)),
  };
}
