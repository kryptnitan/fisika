import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MentoAdapter, type MentoReader } from '../src/adapters/mento.ts';
import { MemoryRfqSlots, TextileAdapter } from '../src/adapters/textile.ts';
import { UniswapV3Adapter, type UniV3Reader } from '../src/adapters/uniswapV3.ts';
import { A, U6 } from './fixtures.ts';

const ctx = (sizes: bigint[]) => ({ nowMs: 5_000, sampleAmounts: () => sizes });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('uniswap v3 adapter', () => {
  const reader: UniV3Reader = {
    async getPool(_a, _b, fee) {
      return fee === 100 ? '0x00000000000000000000000000000000000000aa' : null;
    },
    async quoteExactInputSingle({ amountIn }) {
      if (amountIn > U6(1_000)) return null; // depth runs out
      return { amountOut: (amountIn * 9_999n) / 10_000n, gasEstimate: 90_000n };
    },
    async blockNumber() {
      return 42n;
    },
  };

  it('discovers pools per fee tier and builds both directions, stopping at depth', async () => {
    const ad = new UniswapV3Adapter(reader);
    const pools = await ad.discover([[A.USDT, A.USDC]]);
    assert.equal(pools.length, 1);
    const edges = await ad.fetchEdges(ctx([U6(10), U6(100), U6(1_000), U6(10_000)]));
    assert.equal(edges.length, 2);
    assert.equal(edges[0]!.points.length, 3);
    assert.equal(edges[0]!.feeBps, 1);
    assert.equal(edges[0]!.asOfBlock, 42n);
  });
});

describe('mento adapter', () => {
  it('omits pairs that are not tradable', async () => {
    const reader: MentoReader = {
      async getAmountOut(_i, _o, a) {
        return a;
      },
      async isTradable(i) {
        return i === A.USDT;
      },
      async blockNumber() {
        return 1n;
      },
    };
    const ad = new MentoAdapter(reader, [{ tokenA: A.USDT, tokenB: A.USDm, poolId: '0xpool' }]);
    const edges = await ad.fetchEdges(ctx([U6(10)]));
    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.tokenIn, A.USDT);
  });
});

describe('textile adapter', () => {
  const levels = {
    data: {
      chainId: 42220,
      asOf: '2026-10-26T00:00:00Z',
      pairs: [
        {
          sellToken: A.USDT,
          buyToken: A.cNGN,
          sellDecimals: 6,
          buyDecimals: 6,
          minSellAmount: '1000000',
          maxSellAmount: '5000000000',
          levels: [
            { sellAmount: '1000000', buyAmount: '1500000000' },
            { sellAmount: '1000000000', buyAmount: '1490000000000' },
          ],
        },
        { sellToken: A.cNGN, buyToken: A.USDT, sellDecimals: 6, buyDecimals: 6, minSellAmount: '0', maxSellAmount: '0', levels: [] },
      ],
    },
  };

  it('turns the public ladder into indicative edges and skips empty sides', async () => {
    const ad = new TextileAdapter({ fetchImpl: async () => jsonResponse(levels) });
    const edges = await ad.fetchEdges(ctx([]));
    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.firm, false);
    const q = await ad.quote(A.USDT, A.cNGN, U6(100));
    assert.ok(q && !q.firm && q.amountOut > U6(140_000));
    assert.equal(await ad.quote(A.USDT, A.cNGN, 10n), null, 'below minSellAmount');
  });

  it('rejects a ladder for the wrong chain', async () => {
    const ad = new TextileAdapter({ fetchImpl: async () => jsonResponse({ data: { ...levels.data, chainId: 56 } }) });
    await assert.rejects(ad.fetchEdges(ctx([])), /wrong chain/);
  });

  it('enforces the 4-quote cap locally and frees slots on no_quote', async () => {
    let calls = 0;
    const quoted = (deadline: string) => ({
      data: {
        rfqId: `rfq_${calls}`,
        claimToken: 'rfqc_x',
        status: 'quoted',
        quote: {
          takerPays: '1000000', buyAmount: '1500000000', feeAmount: '100', expiresAt: deadline, orderDeadline: deadline,
          latestOrderDeadline: deadline, reactor: '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3',
        },
        transactions: { approval: { to: A.USDT, data: '0x095ea7b3', value: '0' }, swap: { to: '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3', data: '0x01', value: '0' } },
      },
    });
    const future = new Date(Date.now() + 60_000).toISOString();
    const ad = new TextileAdapter(
      {
        apiKey: 'tx_live_test.secret',
        fetchImpl: async () => {
          calls += 1;
          return calls === 1 ? jsonResponse({ data: { rfqId: 'r', claimToken: 'c', status: 'no_quote', reason: 'no_valid_quote' } }) : jsonResponse(quoted(future));
        },
      },
      new MemoryRfqSlots(4),
    );
    const req = { sellToken: A.USDT, buyToken: A.cNGN, sellAmount: U6(1), taker: A.USDT };
    const first = await ad.firmQuote(req);
    assert.equal(first.status, 'no_quote');
    for (let i = 0; i < 4; i++) assert.equal((await ad.firmQuote(req)).status, 'quoted');
    const fifth = await ad.firmQuote(req);
    assert.deepEqual(fifth, { status: 'no_quote', reason: 'local_rfq_cap_reached' });
    assert.equal(calls, 5, 'the capped request never reached Textile');
  });

  it('refuses firm quotes without an API key', async () => {
    const ad = new TextileAdapter({ fetchImpl: async () => jsonResponse({}) });
    await assert.rejects(ad.firmQuote({ sellToken: A.USDT, buyToken: A.cNGN, sellAmount: 1n, taker: A.USDT }), /TEXTILE_API_KEY/);
  });
});
