import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { BSC, CELO, PriceGraph, Pricer, TokenRegistry, type Address } from '@fisika/core';
import type { GraphState } from '@fisika/core/setup';
import { createAgentApp, type AgentChain } from '../src/agent/routes.ts';
import { readControl } from '../src/agent/control.ts';
import { listRequests } from '../src/agent/withdrawals.ts';
import { setControl } from '../src/agent/control.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const BOT = '0x00000000000000000000000000000000000b0700' as Address;
const CUSDT = CELO.tokens.find((t) => t.symbol === 'USDT')!.address;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'fisika-agent-'));
  const celoDir = join(dir, 'celo');
  const bscDir = join(dir, 'bsc');
  await mkdir(celoDir, { recursive: true });
  await mkdir(bscDir, { recursive: true });
  const st = (tokens: TokenRegistry): GraphState => {
    const graph = new PriceGraph();
    return { graph, pricer: new Pricer(tokens, graph, 60_000), gasPriceWei: 1n, nativeUsd: 0.3, block: 1n, updatedMs: NOW, lastRefresh: [], rpc: { checkedMs: NOW, degraded: false, vetting: null } };
  };
  let receipt: unknown = null;
  let txn: unknown = null;
  const client = {
    getBalance: async () => 10n ** 18n,
    readContract: async () => 5_000_000n,
    getTransactionReceipt: async () => receipt as never,
    getTransaction: async () => txn as never,
  };
  const mk = (cfg: typeof CELO, dataDir: string): AgentChain => {
    const tokens = new TokenRegistry(cfg.tokens);
    return { chain: cfg, tokens, client, state: () => st(tokens), dataDir, wallet: BOT, lowGas: 5n * 10n ** 17n };
  };
  const { app } = createAgentApp({
    owner: owner.address.toLowerCase() as Address,
    withdrawTo: owner.address.toLowerCase() as Address,
    domains: ['fisika.lol'],
    secureCookie: true,
    controlFile: join(dir, 'control.json'),
    eventsFile: join(dir, 'agent-events.jsonl'),
    chains: [mk(CELO, celoDir), mk(BSC, bscDir)],
    now: () => NOW,
  });
  const call = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const res = await app.fetch(
      new Request(`http://x${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: { 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
    return res;
  };
  const signIn = async (acct = owner, domain = 'fisika.lol') => {
    const { nonce } = await (await call('/v1/agent/nonce')).json();
    const message = createSiweMessage({ address: acct.address, chainId: 42220, domain, nonce, uri: `https://${domain}`, version: '1', issuedAt: new Date(NOW), statement: 'Sign in to the fisika agent console.' });
    const signature = await acct.signMessage({ message });
    const res = await call('/v1/agent/login', { body: { message, signature } });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    return { res, cookie, message, signature };
  };
  return { dir, celoDir, bscDir, call, signIn, setReceipt: (r: unknown, t: unknown) => ((receipt = r), (txn = t)) };
}

describe('agent console: owner-only access', () => {
  it('every console route needs a session; non-owner wallets and replays are refused', async () => {
    const t = await setup();
    for (const [path, body] of [
      ['/v1/agent/state', undefined],
      ['/v1/agent/balances', undefined],
      ['/v1/agent/trades', undefined],
      ['/v1/agent/activity', undefined],
      ['/v1/agent/config', undefined],
      ['/v1/agent/control', { target: 'all', active: true }],
      ['/v1/agent/withdraw', { chain: 'celo', token: 'USDT', amount: '1' }],
      ['/v1/agent/deposits', { chain: 'celo', txHash: `0x${'11'.repeat(32)}` }],
    ] as const) {
      assert.equal((await t.call(path, { body })).status, 401, `${path} without session`);
    }
    const bad = await t.signIn(stranger);
    assert.equal(bad.res.status, 403, 'a valid signature from another wallet is refused');
    assert.equal(bad.cookie, '', 'and gets no session');
    assert.equal((await t.call('/v1/agent/control', { body: { target: 'all', active: true }, cookie: 'fisika_agent=forged' })).status, 401, 'forged cookie');

    const wrongSite = await t.signIn(owner, 'evil.example');
    assert.equal(wrongSite.res.status, 401, 'message for another domain');

    const ok = await t.signIn();
    assert.equal(ok.res.status, 200);
    assert.match(ok.res.headers.get('set-cookie') ?? '', /HttpOnly/i);
    assert.match(ok.res.headers.get('set-cookie') ?? '', /SameSite=Strict/i);
    assert.match(ok.res.headers.get('set-cookie') ?? '', /Secure/i);
    const replay = await t.call('/v1/agent/login', { body: { message: ok.message, signature: ok.signature } });
    assert.equal(replay.status, 401, 'a nonce works once');
    assert.equal((await t.call('/v1/agent/state', { cookie: ok.cookie })).status, 200);
    // Logout kills the session server-side.
    await t.call('/v1/agent/logout', { method: 'POST', cookie: ok.cookie, body: {} });
    assert.equal((await t.call('/v1/agent/state', { cookie: ok.cookie })).status, 401);
  });
});

describe('agent console: switch, withdraw, history', () => {
  it('starts Paused; global + per-chain switches persist and are logged', async () => {
    const t = await setup();
    const { cookie } = await t.signIn();
    let s = await (await t.call('/v1/agent/state', { cookie })).json();
    assert.equal(s.status, 'paused', 'no control file yet: paused');
    await t.call('/v1/agent/control', { cookie, body: { target: 'all', active: true } });
    await t.call('/v1/agent/control', { cookie, body: { target: 'bsc', active: false } });
    s = await (await t.call('/v1/agent/state', { cookie })).json();
    assert.equal(s.status, 'active');
    assert.deepEqual(s.chains.map((c: any) => [c.key, c.trading]), [['celo', true], ['bsc', false]]);
    const file = await readControl(join(t.dir, 'control.json'));
    assert.equal(file.active, true);
    assert.equal(file.chains.bsc, false);
    const act = await (await t.call('/v1/agent/activity?kind=control', { cookie })).json();
    assert.deepEqual(act.rows.map((r: any) => [r.type, r.chain]), [['pause', 'bsc'], ['resume', 'all']]);
    assert.equal((await t.call('/v1/agent/control', { cookie, body: { target: 'eth', active: true } })).status, 400);
  });

  it('withdraw pauses the chain and queues a request with no destination field', async () => {
    const t = await setup();
    const { cookie } = await t.signIn();
    await t.call('/v1/agent/control', { cookie, body: { target: 'all', active: true } });
    const r = await (await t.call('/v1/agent/withdraw', { cookie, body: { chain: 'celo', token: 'USDT', amount: '1', to: stranger.address } })).json();
    assert.match(r.id, /^w_/);
    assert.equal(r.to, owner.address.toLowerCase(), 'destination is the configured owner, not anything in the request');
    const ctl = await readControl(join(t.dir, 'control.json'));
    assert.equal(ctl.chains.celo, false, 'celo paused for the withdrawal');
    assert.equal(ctl.chains.bsc, true, 'bsc untouched');
    const q = await listRequests(join(t.celoDir, 'withdrawals'));
    assert.equal(q.length, 1);
    assert.equal(q[0]!.status, 'requested');
    assert.equal((q[0] as any).to, undefined, 'request file carries no destination');
    assert.equal((await t.call('/v1/agent/withdraw', { cookie, body: { chain: 'celo', token: 'USDT', amount: '-1' } })).status, 400);
    assert.equal((await t.call('/v1/agent/withdraw', { cookie, body: { chain: 'celo', token: 'NOPE', amount: '1' } })).status, 400);
    assert.equal((await t.call('/v1/agent/withdraw', { cookie, body: { chain: 'bsc', token: 'native', amount: 'max' } })).status, 200);
  });

  it('records a deposit only when the transaction pays the bot wallet', async () => {
    const t = await setup();
    const { cookie } = await t.signIn();
    const log = (to: Address, value: bigint) => ({
      address: CUSDT,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: owner.address, to } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [value]),
      blockNumber: 1n, transactionHash: `0x${'22'.repeat(32)}`, logIndex: 0, blockHash: `0x${'33'.repeat(32)}`, transactionIndex: 0, removed: false,
    });
    t.setReceipt({ status: 'success', to: CUSDT, from: owner.address, logs: [log(stranger.address.toLowerCase() as Address, 1_000_000n)] }, { to: CUSDT, from: owner.address, value: 0n });
    assert.equal((await t.call('/v1/agent/deposits', { cookie, body: { chain: 'celo', txHash: `0x${'22'.repeat(32)}` } })).status, 422, 'paid someone else');
    t.setReceipt({ status: 'success', to: CUSDT, from: owner.address, logs: [log(BOT, 1_000_000n)] }, { to: CUSDT, from: owner.address, value: 0n });
    const ok = await (await t.call('/v1/agent/deposits', { cookie, body: { chain: 'celo', txHash: `0x${'22'.repeat(32)}` } })).json();
    assert.deepEqual(ok.recorded, [{ token: 'USDT', amount: '1' }]);
    const again = await (await t.call('/v1/agent/deposits', { cookie, body: { chain: 'celo', txHash: `0x${'22'.repeat(32)}` } })).json();
    assert.deepEqual(again.recorded, [], 'recorded once');
    const f = await (await t.call('/v1/agent/activity?kind=funding', { cookie })).json();
    assert.equal(f.rows[0].type, 'deposit');
    assert.match(f.rows[0].explorer, /^https:\/\/celoscan\.io\/tx\//);
  });

  it('trade history reads the trader ledger, filters, paginates and exports CSV', async () => {
    const t = await setup();
    const { cookie } = await t.signIn();
    const e = (at: string, status: string, pnl: number, chain?: string) =>
      JSON.stringify({ at, chain, status, path: 'USDT→wARS→USDT', venues: ['textile', 'uniswap-v3'], amountIn: '10000000', amountOut: status === 'completed' ? '10006000' : null, startDecimals: 6, startToken: 'USDT', expectedNetBps: 6, realizedStart: status === 'completed' ? '6000' : null, gasUsd: 0.001, realizedUsd: pnl, txs: status === 'completed' ? [`0x${'aa'.repeat(32)}`] : [] });
    await writeFile(join(t.celoDir, 'live-ledger.jsonl'), [e('2026-11-04T10:00:00Z', 'completed', 0.005), e('2026-11-05T10:00:00Z', 'aborted_before_spend', 0), e('2026-11-06T10:00:00Z', 'completed', 0.004, 'celo')].join('\n') + '\n');
    await writeFile(join(t.bscDir, 'live-ledger.jsonl'), e('2026-11-06T11:00:00Z', 'completed', -0.01, 'bsc') + '\n');
    const all = await (await t.call('/v1/agent/trades', { cookie })).json();
    assert.equal(all.total, 4);
    assert.equal(all.rows[0].chain, 'bsc', 'newest first');
    assert.equal(all.rows[1].amountIn, '10');
    assert.equal(all.rows[1].amountOut, '10.006');
    assert.match(all.rows[1].explorer[0], /^https:\/\/celoscan\.io\/tx\/0xaa/);
    assert.equal((await (await t.call('/v1/agent/trades?chain=celo&status=completed', { cookie })).json()).total, 2);
    assert.equal((await (await t.call('/v1/agent/trades?from=2026-11-05&to=2026-11-05', { cookie })).json()).total, 1);
    const p2 = await (await t.call('/v1/agent/trades?page=2&pageSize=3', { cookie })).json();
    assert.equal(p2.rows.length, 1);
    const csv = await (await t.call('/v1/agent/trades?format=csv', { cookie })).text();
    assert.match(csv.split('\n')[0]!, /^at,chain,route,venues,side,token,amountIn,amountOut,pnlUsd,feesUsd,status,txs,note$/);
    assert.equal(csv.trim().split('\n').length, 5);
  });
});

describe('control file', () => {
  it('a missing or broken file reads as Paused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fisika-ctl-'));
    assert.equal((await readControl(join(dir, 'none.json'))).active, false);
    await writeFile(join(dir, 'bad.json'), '{not json');
    assert.equal((await readControl(join(dir, 'bad.json'))).active, false);
    void readFile;
  });
});

describe('public arbitrage page follows the console switch', () => {
  it('shows Paused / Running / Pausing from the control file, not just the process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fisika-arbview-'));
    const statusFile = join(dir, 'live-status.json');
    const controlFile = join(dir, 'control.json');
    const status = (inFlight: boolean) => writeFile(statusFile, JSON.stringify({ mode: 'LIVE', wallet: BOT, updatedAt: new Date(NOW - 5_000).toISOString(), killed: false, halted: false, inFlight, trades: 0, wins: 0, realizedUsd: 0, recent: [] }));
    const cfg = loadConfig({ LIVE_STATUS_FILE: statusFile, KILL_FILE: join(dir, 'KILL'), CONTROL_FILE: controlFile });
    const tokens = new TokenRegistry();
    const graph = new PriceGraph();
    const st: GraphState = { graph, pricer: new Pricer(tokens, graph, 60_000), gasPriceWei: 1n, nativeUsd: 0.3, block: 1n, updatedMs: NOW, lastRefresh: [], rpc: { checkedMs: NOW, degraded: false, vetting: null } };
    const { app } = createApp({ cfg, tokens, state: () => st, paymentGate: async (_c: any, next: any) => next(), getTxReceipt: async () => null, now: () => NOW } as any);
    const view = async () => (await (await app.request('/v1/arb')).json()).state;
    await status(false);
    assert.equal(await view(), 'paused', 'no switch file: paused');
    await setControl(controlFile, 'all', true, 'test');
    assert.equal(await view(), 'running');
    await setControl(controlFile, 'celo', false, 'test');
    await status(true);
    assert.equal(await view(), 'pausing', 'switched off with a trade in flight');
    await status(false);
    assert.equal(await view(), 'paused');
  });
});

