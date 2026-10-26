import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bestRoute, enumeratePaths, simulatePath, type RouteRequest } from '../src/router.ts';
import { A, GAS, NOW, U6, U18, cpEdge, setup } from './fixtures.ts';

const sizes6 = [U6(10), U6(100), U6(1_000), U6(10_000), U6(50_000)];
const req = (over: Partial<RouteRequest>): RouteRequest => ({
  tokenIn: A.USDT,
  tokenOut: A.USDC,
  amountIn: U6(1_000),
  nowMs: NOW,
  maxAgeMs: 60_000,
  ...GAS,
  ...over,
});

describe('router', () => {
  it('picks the better of two venues for a small order', () => {
    const { graph, pricer } = setup([
      cpEdge('uniswap-v3', 'uni', A.USDT, A.USDC, U6(200_000), U6(200_000), sizes6, 1),
      cpEdge('mento', 'fpmm', A.USDT, A.USDC, U6(200_000), U6(200_000), sizes6, 20),
    ]);
    const r = bestRoute(graph, pricer, req({ amountIn: U6(100) }))!;
    assert.equal(r.paths.length, 1);
    assert.equal(r.paths[0]!.edges[0]!.venue, 'uniswap-v3');
    assert.equal(r.execution, 'atomic');
  });

  it('splits a large order across two shallow venues and beats either alone', () => {
    const uni = cpEdge('uniswap-v3', 'uni', A.USDT, A.USDC, U6(60_000), U6(60_000), sizes6, 1);
    const men = cpEdge('mento', 'fpmm', A.USDT, A.USDC, U6(60_000), U6(60_000), sizes6, 1);
    const { graph, pricer } = setup([uni, men]);
    const amount = U6(20_000);
    const r = bestRoute(graph, pricer, req({ amountIn: amount }))!;
    assert.equal(r.paths.length, 2);
    const single = simulatePath([uni], amount)!.at(-1)!;
    assert.ok(r.grossOut > single, `split ${r.grossOut} vs single ${single}`);
    assert.equal(r.paths.reduce((s, p) => s + p.amountIn, 0n), amount, 'all input allocated');
    assert.equal(r.txCount, 1, 'both atomic paths share one executor tx');
  });

  it('does not split a tiny order when the second path costs more gas than it adds', () => {
    const { graph, pricer } = setup([
      cpEdge('uniswap-v3', 'uni', A.USDT, A.USDC, U6(1e6), U6(1e6), sizes6, 1),
      cpEdge('mento', 'fpmm', A.USDT, A.USDC, U6(1e6), U6(1e6), sizes6, 1),
    ]);
    // Absurd gas price makes opening a second path clearly unprofitable.
    const r = bestRoute(graph, pricer, req({ amountIn: U6(50), gasPriceWei: 10n ** 15n }))!;
    assert.equal(r.paths.length, 1);
  });

  it('routes multi-hop through USDT across 6- and 18-decimal tokens (BRL -> ARS)', () => {
    // 1 USDT ≈ 5.4 wBRL, 1 USDT ≈ 1400 wARS; both 18 decimals; USDT 6 decimals.
    const brlSizes = [U18(54), U18(540), U18(5_400)];
    const usdtSizes = [U6(10), U6(100), U6(1_000)];
    const { graph, pricer } = setup([
      cpEdge('textile', 'textile-rfq', A.USDT, A.wBRL, U6(1e6), U18(5.4e6), usdtSizes, 1),
      cpEdge('textile', 'textile-rfq', A.wBRL, A.USDT, U18(5.4e6), U6(1e6), brlSizes, 1),
      cpEdge('textile', 'textile-rfq', A.USDT, A.wARS, U6(1e6), U18(1.4e9), usdtSizes, 1),
    ]);
    const r = bestRoute(graph, pricer, req({ tokenIn: A.wBRL, tokenOut: A.wARS, amountIn: U18(540) }))!;
    assert.ok(r, 'route found');
    assert.equal(r.paths[0]!.edges.length, 2);
    const ars = Number(r.grossOut) / 1e18;
    assert.ok(ars > 139_000 && ars < 140_000, `got ${ars} wARS for 540 wBRL`);
    assert.equal(r.execution, 'multi-tx');
    assert.equal(r.txCount, 2);
    assert.equal(r.allFirm, false);
  });

  it('labels a single Textile hop as textile-direct, and atomic once the aggregator key is live', () => {
    const e = cpEdge('textile', 'textile-rfq', A.USDT, A.cNGN, U6(1e6), U6(1.5e9), [U6(10), U6(1_000)], 1);
    const { graph, pricer } = setup([e]);
    assert.equal(bestRoute(graph, pricer, req({ tokenOut: A.cNGN, amountIn: U6(100) }))!.execution, 'textile-direct');
    assert.equal(bestRoute(graph, pricer, req({ tokenOut: A.cNGN, amountIn: U6(100), textileAtomic: true }))!.execution, 'atomic');
  });

  it('returns null when no combination of paths has enough depth', () => {
    const { graph, pricer } = setup([cpEdge('uniswap-v3', 'uni', A.USDT, A.USDC, U6(1e5), U6(1e5), [U6(10), U6(100)], 1)]);
    assert.equal(bestRoute(graph, pricer, req({ amountIn: U6(500) })), null);
  });

  it('applies service fee and slippage to the output, never to the input', () => {
    const { graph, pricer } = setup([cpEdge('uniswap-v3', 'uni', A.USDT, A.USDC, U6(1e7), U6(1e7), sizes6, 1)]);
    const r = bestRoute(graph, pricer, req({ amountIn: U6(1_000), feeBps: 10, slippageBps: 30 }))!;
    assert.equal(r.serviceFee, (r.grossOut * 10n) / 10_000n);
    assert.equal(r.amountOut, r.grossOut - r.serviceFee);
    assert.equal(r.minOut, (r.amountOut * 9_970n) / 10_000n);
    assert.ok(r.gasUsd > 0 && r.gasUsd < 0.01, `gas $${r.gasUsd}`);
  });

  it('never revisits a token and respects the hop limit', () => {
    const s = [U6(10), U6(100)];
    const { graph } = setup([
      cpEdge('uniswap-v3', 'a', A.USDT, A.USDC, U6(1e6), U6(1e6), s),
      cpEdge('uniswap-v3', 'b', A.USDC, A.USDT, U6(1e6), U6(1e6), s),
      cpEdge('mento', 'c', A.USDC, A.USDm, U6(1e6), U18(1e6), s),
      cpEdge('mento', 'd', A.USDm, A.cNGN, U18(1e6), U6(1.5e9), [U18(10), U18(100)]),
    ]);
    const paths = enumeratePaths(graph, req({ tokenOut: A.cNGN, maxHops: 3 }));
    assert.equal(paths.length, 1);
    assert.deepEqual(paths[0]!.map((e) => e.poolId), ['a', 'c', 'd']);
    assert.equal(enumeratePaths(graph, req({ tokenOut: A.cNGN, maxHops: 2 })).length, 0);
  });
});
