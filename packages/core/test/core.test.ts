import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { curveOut, normalizeCurve } from '../src/curve.ts';
import { PriceGraph } from '../src/graph.ts';
import { TokenRegistry } from '../src/tokens.ts';
import { A, NOW, U6, U18, cpEdge, setup } from './fixtures.ts';

describe('curve', () => {
  const pts = [
    { amountIn: 100n, amountOut: 99n },
    { amountIn: 1_000n, amountOut: 980n },
  ];
  it('interpolates between samples and from the origin', () => {
    assert.equal(curveOut(pts, 50n), 49n); // 99 * 50/100, floored
    assert.equal(curveOut(pts, 100n), 99n);
    assert.equal(curveOut(pts, 550n), 99n + (881n * 450n) / 900n);
  });
  it('refuses to extrapolate past the deepest sample', () => {
    assert.equal(curveOut(pts, 1_001n), null);
  });
  it('drops non-monotonic and empty samples', () => {
    const n = normalizeCurve([
      { amountIn: 1_000n, amountOut: 900n },
      { amountIn: 100n, amountOut: 99n },
      { amountIn: 500n, amountOut: 50n }, // stale read: less out for more in
      { amountIn: 0n, amountOut: 0n },
    ]);
    assert.deepEqual(n.map((p) => p.amountIn), [100n, 1_000n]);
  });
});

describe('token registry', () => {
  it('resolves legacy symbols and keeps the two naira tokens apart', () => {
    const r = new TokenRegistry();
    assert.equal(r.bySymbol('cKES').symbol, 'KESm');
    assert.equal(r.bySymbol('cNGN').issuer, 'Africa Stablecoin Consortium');
    assert.equal(r.bySymbol('NGNm').issuer, 'Mento');
    assert.equal(r.bySymbol('COPM').issuer, 'Minteo');
    assert.equal(r.bySymbol('COPm').issuer, 'Mento');
    assert.throws(() => r.bySymbol('copm'), /ambiguous/);
  });
  it('refuses unverified decimals and rejects a mismatch', () => {
    const r = new TokenRegistry([{ symbol: 'NEW', address: '0x00000000000000000000000000000000000000aa', decimals: null, issuer: 'x', fiat: 'USD', usd: true, tier: 2 }]);
    assert.throws(() => r.decimals('0x00000000000000000000000000000000000000aa'), /not verified/);
    r.applyOnchainDecimals('0x00000000000000000000000000000000000000aa', 6);
    assert.equal(r.decimals('0x00000000000000000000000000000000000000aa'), 6);
    assert.throws(() => new TokenRegistry().applyOnchainDecimals(A.USDT, 18), /mismatch/);
  });
});

describe('graph', () => {
  it('drops stale edges and replaces a venue wholesale', () => {
    const g = new PriceGraph();
    g.upsert(cpEdge('uniswap-v3', 'p1', A.USDT, A.USDC, U6(1e5), U6(1e5), [U6(10)], 1, { asOfMs: 0 }));
    g.upsert(cpEdge('mento', 'm1', A.USDT, A.USDC, U6(1e5), U6(1e5), [U6(10)], 1, { asOfMs: 9_000 }));
    assert.equal(g.outgoing(A.USDT, 10_000, 5_000).length, 1);
    g.replaceVenue('mento', []);
    assert.equal(g.size(), 1);
  });
  it('round-trips through a snapshot', () => {
    const g = new PriceGraph();
    g.upsert(cpEdge('uniswap-v3', 'p1', A.USDT, A.wBRL, U6(1e5), U18(5.4e5), [U6(10), U6(100)], 5, { asOfBlock: 123n }));
    const g2 = PriceGraph.fromSnapshot(JSON.parse(JSON.stringify(g.snapshot())));
    assert.deepEqual(g2.all(), g.all());
  });
});

describe('pricer', () => {
  it('prices non-USD tokens from USD edges and sizes samples', () => {
    // 1 USDT ≈ 1500 cNGN (6 decimals both)
    const { pricer } = setup([cpEdge('textile', 'textile-rfq', A.USDT, A.cNGN, U6(1e6), U6(1.5e9), [U6(10), U6(100), U6(1000)], 1)]);
    const px = pricer.usdPerToken(A.cNGN, NOW)!;
    assert.ok(Math.abs(1 / px - 1500) < 2, `got ${1 / px}`);
    const samples = pricer.sampleAmounts(A.cNGN, NOW)!;
    assert.equal(samples.length, 4);
    assert.ok(samples[1]! > U6(149_000) && samples[1]! < U6(151_000));
  });
  it('returns null for tokens it cannot price', () => {
    const { pricer } = setup([]);
    assert.equal(pricer.usdPerToken('0x456a3d042c0dbd3db53d5489e98dfb038553b0d0', NOW), null, 'KESm with no edges');
    assert.equal(pricer.usdPerToken('0x00000000000000000000000000000000000000aa', NOW), null, 'unknown token');
  });
});
