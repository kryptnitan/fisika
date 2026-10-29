import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BSC, CELO, PriceGraph, Pricer, TokenRegistry, type Address, type Edge } from '@fisika/core';
import { fisikaExecutorAbi, routeIdFor, v3SwapRouterAbi } from '@fisika/core/build';
import type { GraphState } from '@fisika/core/setup';
import type { MiddlewareHandler } from 'hono';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex, type Log } from 'viem';
import { createApp, multiChainFetch } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const USDT = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e' as Address;
const USDC = '0xceba9300f2b948710d2653dd7b07f33a8b32118c' as Address;
const USDm = '0x765de816845861e75a25fca122bb6898b8b1282a' as Address;
const EXECUTOR = '0x00000000000000000000000000000000000e0e0e' as Address;
const TAKER = '0x000000000000000000000000000000000000beef' as Address;
const NOW = 1_800_000_000_000;

function edge(venue: Edge['venue'], poolId: string, tin: Address, tout: Address, dIn: number, dOut: number, rate: number, meta?: Edge['meta']): Edge {
  const sizes = [10, 100, 1_000, 10_000];
  return {
    venue, poolId, tokenIn: tin, tokenOut: tout, gasUnits: 120_000n, feeBps: 1, firm: true, asOfMs: NOW, meta,
    points: sizes.map((n) => ({ amountIn: BigInt(n) * 10n ** BigInt(dIn), amountOut: (BigInt(Math.round(n * rate * 1e6)) * 10n ** BigInt(dOut)) / 1_000_000n })),
  };
}

function state(): GraphState {
  const tokens = new TokenRegistry();
  const graph = new PriceGraph();
  graph.upsert(edge('uniswap-v3', '0x1a810e0b6c2dd5629afa2f0c898b9512c6f78846', USDT, USDC, 6, 6, 0.9989, { fee: 100 }));
  graph.upsert(edge('mento', '0x462fe04b4fd719cbd04c0310365d421d02aaa19e', USDC, USDm, 6, 18, 0.9996));
  graph.upsert(edge('uniswap-v3', '0x5dc631ad6c26bea1a59fbf2c2680cf3df43d249f', USDT, USDm, 6, 18, 0.9987, { fee: 100 }));
  return { graph, pricer: new Pricer(tokens, graph, 60_000), gasPriceWei: 25_000_000_000n, nativeUsd: 0.077, block: 1n, updatedMs: NOW, lastRefresh: [], rpc: { checkedMs: NOW, degraded: false, vetting: null } };
}

/** Stand-in for the x402 middleware: 402 without a payment header; with one, serve and attach a settlement header. */
function stubGate(calls: { n: number }): MiddlewareHandler {
  return async (c, next) => {
    calls.n += 1;
    if (!c.req.header('payment-signature')) return c.json({}, 402);
    await next();
    c.header('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true, transaction: '0xabc', payer: '0xPAYER' })).toString('base64'));
  };
}

function mk(env: Record<string, string> = {}, gateCalls = { n: 0 }, receipt?: (h: Hex) => any) {
  const cfg = loadConfig({ FREE_TIER_KEYS: 'test-key', FREE_TIER_DAILY_LIMIT: '2', PUBLIC_URL: 'https://api.fisika.test', AGENT_ID: '7', ...env });
  const st = state();
  return createApp({ cfg, tokens: new TokenRegistry(), state: () => st, paymentGate: stubGate(gateCalls), getTxReceipt: async (h) => receipt?.(h) ?? null, now: () => NOW });
}

const post = (app: { request: Function }, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }) as Promise<Response>;

describe('api', () => {
  it('serves health, pairs, board and a compliant ERC-8004 registration file', async () => {
    const { app } = mk();
    assert.equal((await (await app.request('/health')).json()).ok, true);
    const reg = await (await app.request('/.well-known/agent-registration.json')).json();
    assert.equal(reg.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
    assert.equal(reg.x402Support, true);
    assert.deepEqual(reg.supportedTrust, ['reputation']);
    assert.equal(reg.registrations[0].agentRegistry, 'eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    assert.ok(reg.services.some((s: any) => s.endpoint === 'https://api.fisika.test/v1'));
    const board = await (await app.request('/v1/board')).json();
    const row = board.rows.find((r: any) => r.corridor === 'USDT-USDC');
    assert.ok(row.sizes[1].rate > 0.998 && row.sizes[1].rate < 1);
  });

  it('charges for quotes via x402, lets free-tier keys through up to the daily limit', async () => {
    const gate = { n: 0 };
    const { app, stats } = mk({}, gate);
    const body = { tokenIn: 'USDT', tokenOut: 'USDm', amount: '250' };
    assert.equal((await post(app, '/v1/quote', body)).status, 402);
    const paid = await post(app, '/v1/quote', body, { 'payment-signature': 'x' });
    assert.equal(paid.status, 200);
    const q = await paid.json();
    assert.equal(q.tokenIn.symbol, 'USDT');
    assert.ok(Number(q.amountOut) > 249 && Number(q.amountOut) < 250);
    assert.equal(stats.paidCalls, 1);
    assert.equal(stats.payers.get('0xpayer'), 1);
    assert.equal((await post(app, '/v1/quote', body, { 'x-api-key': 'test-key' })).status, 200);
    assert.equal((await post(app, '/v1/quote', body, { 'x-api-key': 'test-key' })).status, 200);
    assert.equal((await post(app, '/v1/quote', body, { 'x-api-key': 'test-key' })).status, 429);
    assert.equal(gate.n, 2, 'free-tier calls never hit the payment gate');
  });

  it('rejects bad input with 400 and unknown tokens clearly', async () => {
    const { app } = mk();
    const h = { 'payment-signature': 'x' };
    assert.equal((await post(app, '/v1/quote', { tokenIn: 'USDT' }, h)).status, 400);
    assert.equal((await post(app, '/v1/quote', { tokenIn: 'DOGE', tokenOut: 'USDT', amount: '1' }, h)).status, 400);
    assert.equal((await post(app, '/v1/quote', { tokenIn: 'USDT', tokenOut: 'USDC', amount: '1e9' }, h)).status, 400);
  });

  it('refuses to build (and never charges) while execution is disabled', async () => {
    const gate = { n: 0 };
    const { app } = mk({}, gate);
    const res = await post(app, '/v1/build', { quoteId: 'q_x', taker: TAKER }, { 'payment-signature': 'x' });
    assert.equal(res.status, 503);
    assert.equal(gate.n, 0);
  });

  it('builds approve + execute with the fee, minOut and route id, then verifies the receipt on-chain', async () => {
    const env = { EXECUTION_ENABLED: 'true', EXECUTOR_ADDRESS: EXECUTOR, FEE_TO: '0x0000000000000000000000000000000000000fee', SERVICE_FEE_BPS: '10' };
    let mined: any = null;
    const { app } = mk(env, { n: 0 }, () => mined);
    const h = { 'payment-signature': 'x' };
    const q = await (await post(app, '/v1/quote', { tokenIn: 'USDT', tokenOut: 'USDm', amount: '100' }, h)).json();
    const built = await (await post(app, '/v1/build', { quoteId: q.quoteId, taker: TAKER }, h)).json();
    assert.equal(built.txs.length, 2);
    assert.equal(built.txs[0].to, USDT);
    assert.equal(built.txs[1].to, EXECUTOR);
    const dec = decodeFunctionData({ abi: fisikaExecutorAbi, data: built.txs[1].data });
    assert.equal(dec.functionName, 'execute');
    const [routeId, steps, tin, amountIn, tout, minOut, recipient, , feeBps] = dec.args as unknown as any[];
    assert.equal(routeId, routeIdFor(q.quoteId));
    assert.ok(steps.length >= 1);
    assert.equal(tin.toLowerCase(), USDT);
    assert.equal(amountIn, 100_000_000n);
    assert.equal(tout.toLowerCase(), USDm);
    assert.equal(recipient.toLowerCase(), TAKER);
    assert.equal(feeBps, 10);
    assert.equal(BigInt(built.minOut), minOut);

    // Simulate the mined tx: an Executed event from our executor with this quote's routeId.
    const realized = 99_800_000_000_000_000_000n;
    const log = {
      address: EXECUTOR,
      topics: encodeEventTopics({ abi: fisikaExecutorAbi, eventName: 'Executed', args: { routeId: routeIdFor(q.quoteId), sender: TAKER } }),
      data: encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
        [USDT, 100_000_000n, USDm, realized, 99_000_000_000_000_000n, TAKER],
      ),
      blockNumber: 5n, transactionHash: `0x${'11'.repeat(32)}`, logIndex: 0, blockHash: `0x${'22'.repeat(32)}`, transactionIndex: 0, removed: false,
    } as unknown as Log;
    mined = { status: 'success', blockNumber: 5n, logs: [log], to: EXECUTOR };
    const rec = await (await post(app, '/v1/receipts', { quoteId: q.quoteId, txHash: `0x${'11'.repeat(32)}` })).json();
    assert.equal(rec.status, 'filled');
    assert.equal(rec.realizedOut, '99.8');
    assert.match(rec.hash, /^0x[0-9a-f]{64}$/);
    assert.equal((await (await app.request(`/v1/receipts/${rec.id}`)).json()).hash, rec.hash);

    // A transaction that carries a different route id cannot be claimed for this quote.
    const other = await (await post(app, '/v1/quote', { tokenIn: 'USDT', tokenOut: 'USDm', amount: '100' }, h)).json();
    assert.equal((await post(app, '/v1/receipts', { quoteId: other.quoteId, txHash: `0x${'11'.repeat(32)}` })).status, 422);
  });

  it('internal web keys skip payment; admin kill switch needs the bearer token', async () => {
    const internal = 'internal-key-0123456789abcdef';
    const admin = 'admin-token-0123456789abcdef';
    const gate = { n: 0 };
    const { app } = mk({ INTERNAL_API_KEYS: internal, ADMIN_TOKEN: admin }, gate);
    assert.equal((await post(app, '/v1/quote', { tokenIn: 'USDT', tokenOut: 'USDC', amount: '5' }, { 'x-api-key': internal })).status, 200);
    assert.equal(gate.n, 0);
    assert.equal((await post(app, '/v1/admin/kill', { on: true })).status, 401);
    assert.equal((await post(app, '/v1/admin/kill', { on: true }, { authorization: 'Bearer wrong-token-0123456789abcd' })).status, 401);
    // No arb runner in this test app: authorized but 404.
    assert.equal((await post(app, '/v1/admin/kill', { on: true }, { authorization: `Bearer ${admin}` })).status, 404);
  });

  it('charges no swap fee by default', async () => {
    const env = { EXECUTION_ENABLED: 'true', EXECUTOR_ADDRESS: EXECUTOR };
    const { app } = mk(env);
    const h = { 'payment-signature': 'x' };
    const q = await (await post(app, '/v1/quote', { tokenIn: 'USDT', tokenOut: 'USDm', amount: '100' }, h)).json();
    assert.equal(q.serviceFeeBps, 0);
    assert.equal(q.serviceFee, '0');
    const built = await (await post(app, '/v1/build', { quoteId: q.quoteId, taker: TAKER }, h)).json();
    const [, , , , , , , , feeBps] = decodeFunctionData({ abi: fisikaExecutorAbi, data: built.txs[1].data }).args as unknown as any[];
    assert.equal(feeBps, 0);
  });

  it('BNB Chain: builds a direct PancakeSwap swap (no executor), verifies the receipt from Transfer logs', async () => {
    const B_USDT = BSC.tokens.find((t) => t.symbol === 'USDT')!.address;
    const B_CNGN = BSC.tokens.find((t) => t.symbol === 'cNGN')!.address;
    const tokens = new TokenRegistry(BSC.tokens);
    const graph = new PriceGraph();
    graph.upsert(edge('pancake-v3', '0x7f049051cc191db9837503f74715d7ef96ba7626', B_USDT, B_CNGN, 18, 6, 1380, { fee: 500 }));
    const st: GraphState = { graph, pricer: new Pricer(tokens, graph, 60_000), gasPriceWei: 50_000_000n, nativeUsd: 750, block: 1n, updatedMs: NOW, lastRefresh: [], rpc: { checkedMs: NOW, degraded: false, vetting: null } };
    // A fee configured for Celo must not leak into a chain without an executor.
    const cfg = loadConfig({ EXECUTION_ENABLED: 'true', SERVICE_FEE_BPS: '10', FEE_TO: '0x0000000000000000000000000000000000000fee', CHAINS: 'celo,bsc' });
    let mined: any = null;
    const bsc = createApp({ cfg, chain: BSC, tokens, state: () => st, paymentGate: stubGate({ n: 0 }), getTxReceipt: async () => mined, now: () => NOW });
    const celo = mk();
    const fetch = multiChainFetch({ celo: celo.app, bsc: bsc.app }, [CELO, BSC]);
    const call = (path: string, body?: unknown) =>
      fetch(new Request(`http://x${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': 'x' }, body: JSON.stringify(body) }));

    const chains = await (await call('/v1/chains')).json();
    assert.deepEqual(chains.chains.map((c: any) => [c.key, c.chainId, c.prefix]), [['celo', 42220, ''], ['bsc', 56, '/bsc']]);
    const board = await (await call('/bsc/v1/board')).json();
    assert.equal(board.chainId, 56);
    assert.ok(board.rows.find((r: any) => r.corridor === 'USDT-cNGN').sizes[1].rate > 1300);
    assert.equal((await (await call('/v1/board')).json()).chainId, 42220, 'plain /v1 stays Celo');

    const q = await (await call('/bsc/v1/quote', { tokenIn: 'USDT', tokenOut: 'cNGN', amount: '100' })).json();
    assert.equal(q.chainId, 56);
    assert.equal(q.serviceFeeBps, 0);
    const built = await (await call('/bsc/v1/build', { quoteId: q.quoteId, taker: TAKER })).json();
    assert.equal(built.mode, 'direct');
    assert.equal(built.txs.length, 2);
    assert.equal(built.txs[0].to, B_USDT);
    assert.equal(built.txs[0].chainId, 56);
    const router = BSC.v3Dexes.find((d) => d.id === 'pancake-v3')!.router;
    assert.equal(built.txs[1].to, router);
    const approve = decodeFunctionData({ abi: erc20Abi, data: built.txs[0].data });
    assert.deepEqual(approve.args, [router, 100n * 10n ** 18n], 'exact approval to the router');
    const swap = decodeFunctionData({ abi: v3SwapRouterAbi, data: built.txs[1].data });
    const p = (swap.args as any)[0];
    assert.equal(p.recipient.toLowerCase(), TAKER);
    assert.equal(p.fee, 500);
    assert.equal(p.amountOutMinimum, BigInt(built.minOut));
    assert.ok(p.amountOutMinimum > 0n && p.deadline > 0n);

    const transfer = (to: Address, value: bigint): Log =>
      ({
        address: B_CNGN,
        topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: router, to } }),
        data: encodeAbiParameters([{ type: 'uint256' }], [value]),
        blockNumber: 9n, transactionHash: `0x${'33'.repeat(32)}`, logIndex: 0, blockHash: `0x${'44'.repeat(32)}`, transactionIndex: 0, removed: false,
      }) as unknown as Log;
    // Wrong target: refused.
    mined = { status: 'success', blockNumber: 9n, logs: [transfer(TAKER, 137_000_000_000n)], to: B_USDT };
    assert.equal((await call('/bsc/v1/receipts', { quoteId: q.quoteId, txHash: `0x${'33'.repeat(32)}` })).status, 422);
    mined = { ...mined, to: router };
    const rec = await (await call('/bsc/v1/receipts', { quoteId: q.quoteId, txHash: `0x${'33'.repeat(32)}` })).json();
    assert.equal(rec.status, 'filled');
    assert.equal(rec.realizedOut, '137000');
    assert.match(rec.explorer, /^https:\/\/bscscan\.com\/tx\//);
  });
});

