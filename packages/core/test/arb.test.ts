import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArbEngine, RiskGate, bellmanFordCycles, cyclesFrom, type ArbConfig } from '../src/arb.ts';
import { curveOut } from '../src/curve.ts';
import type { PriceGraph } from '../src/graph.ts';
import type { Address, Edge, VenueAdapter, VenueId } from '../src/types.ts';
import { A, GAS, NOW, U6, U18, cpEdge, setup } from './fixtures.ts';

const s6 = [U6(10), U6(100), U6(1_000), U6(10_000)];
const s18 = [U18(10), U18(100), U18(1_000), U18(10_000)];

/** USDT -> USDC (uni) -> USDm (mento, cheap) -> USDT (uni, rich): ~+0.6% before fees. */
function triangle(richness = 1.006): Edge[] {
  return [
    cpEdge('uniswap-v3', 'uniA', A.USDT, A.USDC, U6(5e5), U6(5e5), s6, 1),
    cpEdge('mento', 'fpmm', A.USDC, A.USDm, U6(5e5), U18(5e5), s6, 5),
    cpEdge('uniswap-v3', 'uniB', A.USDm, A.USDT, U18(5e5), U6(5e5 * richness), s18, 1),
  ];
}

const cfg = (over: Partial<ArbConfig> = {}): ArbConfig => ({
  startTokens: [A.USDT],
  sizesUsd: [10, 100, 1_000],
  maxLen: 4,
  maxAgeMs: 60_000,
  minEdgeBps: 5,
  minEdgeUsd: 0.01,
  maxTradeUsd: 1_000,
  slippageBps: 30,
  dailyLossLimitUsd: 5,
  maxTokenExposureUsd: 200,
  textileAtomic: false,
  ...GAS,
  ...over,
});

/** Adapter that quotes straight off the graph's curves, times a drift factor (simulates the market moving). */
function graphAdapters(graph: PriceGraph, drift = 1): Map<VenueId, VenueAdapter> {
  const m = new Map<VenueId, VenueAdapter>();
  for (const v of ['uniswap-v3', 'mento', 'textile'] as VenueId[]) {
    m.set(v, {
      id: v,
      fetchEdges: async () => [],
      async quote(i: Address, o: Address, amt: bigint) {
        const e = graph.all().find((x) => x.venue === v && x.tokenIn === i && x.tokenOut === o);
        const out = e && curveOut(e.points, amt);
        if (!out) return null;
        return { amountOut: (out * BigInt(Math.round(drift * 1e6))) / 1_000_000n, gasEstimate: 0n, expiry: 0, firm: true, feeBps: 0, source: 'test' };
      },
    });
  }
  return m;
}

describe('cycle detection', () => {
  it('Bellman-Ford finds the negative cycle and DFS finds the same triangle', () => {
    const { graph, pricer } = setup(triangle());
    const bf = bellmanFordCycles(graph, pricer, 100, NOW, 60_000);
    assert.equal(bf.length, 1);
    assert.equal(bf[0]!.length, 3);
    const dfs = cyclesFrom(graph, A.USDT, 4, NOW, 60_000);
    assert.equal(dfs.length, 1);
  });

  it('finds nothing in a fair market', () => {
    const { graph, pricer } = setup(triangle(1.0));
    assert.equal(bellmanFordCycles(graph, pricer, 100, NOW, 60_000).length, 0);
  });
});

describe('arb engine (PAPER)', () => {
  it('detects, confirms with live quotes and paper-fills a profitable triangle', async () => {
    const { graph, pricer } = setup(triangle());
    const risk = new RiskGate(cfg(), pricer, () => false);
    const eng = new ArbEngine(graph, pricer, graphAdapters(graph), risk, cfg());
    const decisions = await eng.tick(NOW);
    const filled = decisions.filter((d) => d.action === 'filled');
    assert.equal(filled.length, 1, JSON.stringify(decisions.map((d) => d.reason)));
    const f = filled[0]!.fill!;
    assert.equal(f.mode, 'PAPER');
    assert.ok(f.realizedProfit > 0n);
    assert.equal(f.opportunity.sizeUsd, 100, 'price impact makes $1k worse than $100 on these pools');
    assert.ok(f.minOut > f.opportunity.amountIn, 'minOut enforces profit on-chain');
    // Same prices on the next tick: the opportunity was consumed by the paper fill and must not count twice.
    const again = await eng.tick(NOW + 5_000);
    assert.equal(again.filter((d) => d.action === 'filled').length, 0);
    assert.equal(again[0]!.reason, 'already_filled_prices_unchanged');
  });

  it('skips when the edge vanishes on re-quote', async () => {
    const { graph, pricer } = setup(triangle());
    const eng = new ArbEngine(graph, pricer, graphAdapters(graph, 0.995), new RiskGate(cfg(), pricer, () => false), cfg());
    const d = await eng.tick(NOW);
    assert.ok(d.length > 0 && d.every((x) => x.action === 'skipped'));
    assert.match(d[0]!.reason!, /after_requote/);
  });

  it('respects the kill switch and the max trade size', async () => {
    const { graph, pricer } = setup(triangle());
    let kill = true;
    const eng = new ArbEngine(graph, pricer, graphAdapters(graph), new RiskGate(cfg(), pricer, () => kill), cfg());
    assert.equal((await eng.tick(NOW))[0]!.reason, 'kill_switch');
    kill = false;
    const small = new ArbEngine(graph, pricer, graphAdapters(graph), new RiskGate(cfg({ maxTradeUsd: 50 }), pricer, () => false), cfg({ maxTradeUsd: 50 }));
    assert.equal((await small.tick(NOW))[0]!.reason, 'size_above_max');
  });

  it('halts after the daily loss limit and stays halted until cleared', () => {
    const { pricer } = setup(triangle());
    const risk = new RiskGate(cfg(), pricer, () => false);
    risk.record(-3, NOW);
    assert.equal(risk.state.halted, false);
    risk.record(-2.5, NOW);
    assert.equal(risk.state.halted, true);
    risk.record(0, NOW + 86_400_000); // next day
    assert.equal(risk.state.halted, true, 'halt survives the day rollover');
    risk.clearHalt();
    assert.equal(risk.state.halted, false);
  });

  it('blocks multi-tx Textile cycles whose intermediate inventory exceeds the cap', async () => {
    const edges = [
      cpEdge('textile', 'textile-rfq', A.USDT, A.cNGN, U6(5e5), U6(7.5e8 * 1.01), s6, 1),
      cpEdge('uniswap-v3', 'uniN', A.cNGN, A.USDT, U6(7.5e8), U6(5e5), [U6(15_000), U6(150_000), U6(1_500_000), U6(15_000_000)], 5),
    ];
    const { graph, pricer } = setup(edges);
    const c = cfg({ maxTokenExposureUsd: 50 });
    const eng = new ArbEngine(graph, pricer, graphAdapters(graph), new RiskGate(c, pricer, () => false), c);
    const d = await eng.tick(NOW);
    assert.ok(d.length > 0);
    assert.equal(d[0]!.opportunity.txCount, 2);
    assert.equal(d[0]!.reason, 'inventory_exposure');
  });
});
