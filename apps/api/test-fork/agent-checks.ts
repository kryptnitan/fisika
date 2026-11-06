/**
 * Agent console acceptance checks on a real chain fork, shared by live-fork.ts (Celo) and live-fork-bsc.ts (BNB).
 *
 *   1. Pause → no new trades across 60 ticks (= 10 minutes at the 10 s refresh); resume → trading restarts.
 *   2. Pause mid-loop → the loop completes; nothing new starts.
 *   3. Restart while Paused → a fresh trader process comes back Paused.
 *   5. Deposit and withdraw $1 through the console API (owner signs in with SIWE) → balances and history update.
 *   6. Pause the other chain only → this chain keeps trading; pause this chain → it stops.
 * (4, non-owner access, is covered by test/agent.test.ts.)
 *
 * Time is compressed: ticks run back to back instead of 10 s apart. What is checked is that nothing is submitted,
 * by reading the bot wallet's nonce on the fork before and after.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWalletClient, erc20Abi, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { Address, ChainConfig, Edge, Opportunity, TokenRegistry, VenueAdapter, VenueId } from '@fisika/core';
import type { GraphState } from '@fisika/core/setup';
import { setControl, readEvents } from '../src/agent/control.ts';
import { createAgentApp, type AgentChainClient } from '../src/agent/routes.ts';
import { withdrawDir } from '../src/agent/withdrawals.ts';
import type { Chain } from '../src/live/legs.ts';
import { LiveTrader, type LiveConfig } from '../src/live/trader.ts';

// anvil dev key #1 plays the owner's personal wallet.
const OWNER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export interface AgentCheckInput {
  cfg: ChainConfig;
  rpc: string;
  chain: Chain;
  state: () => GraphState;
  tokens: TokenRegistry;
  adapters: ReadonlyMap<VenueId, VenueAdapter>;
  base: Omit<LiveConfig, 'ledgerPath' | 'statusPath' | 'killFile' | 'controlFile' | 'eventsFile' | 'withdrawDir' | 'withdrawTo' | 'afterLeg'>;
  cycle: () => Edge[];
  amountIn: bigint;
  stable: Address;
  stableDecimals: number;
  ok: (m: string) => void;
}

export async function runAgentChecks(x: AgentCheckInput): Promise<void> {
  const { cfg, chain, ok } = x;
  const key = cfg.key as 'celo' | 'bsc';
  const other = key === 'celo' ? 'bsc' : 'celo';
  const dir = await mkdtemp(join(tmpdir(), `fisika-agent-${key}-`));
  const dataDir = join(dir, key);
  const controlFile = join(dir, 'control.json');
  const eventsFile = join(dir, 'agent-events.jsonl');
  const owner = privateKeyToAccount(OWNER_KEY);
  const ownerAddr = owner.address.toLowerCase() as Address;
  const bot = chain.account;
  const unit = 10n ** BigInt(x.stableDecimals);

  let afterLeg: ((i: number) => void | Promise<void>) | undefined;
  const mkTrader = () =>
    new LiveTrader(chain, x.state, x.tokens, x.adapters, null, {
      ...x.base,
      ledgerPath: join(dataDir, 'live-ledger.jsonl'),
      statusPath: join(dataDir, 'live-status.json'),
      killFile: join(dataDir, 'KILL'),
      controlFile,
      eventsFile,
      withdrawDir: withdrawDir(dataDir),
      withdrawTo: ownerAddr,
      afterLeg: (i) => afterLeg?.(i),
    });
  await import('node:fs/promises').then((f) => f.mkdir(dataDir, { recursive: true }));
  let trader = mkTrader();
  const nonce = () => chain.pub.getTransactionCount({ address: bot });
  const force = (): Opportunity => ({
    id: `agent-${key}`, cycle: x.cycle(), start: x.stable, amountIn: x.amountIn, amounts: [], grossProfit: 0n, gasUnits: 0n,
    gasInStart: -x.amountIn, // test-only: lets a fee-losing cycle past the profitability guard; nothing else bypassed
    netProfit: 0n, netBps: 0, netUsd: 0, txCount: 2, venues: [], indicativeLegs: 0, sizeUsd: 10,
  });

  // ---- 1. Pause → nothing for 60 ticks; resume → trades again.
  await setControl(controlFile, 'all', false, 'test');
  const n0 = await nonce();
  for (let i = 0; i < 60; i++) {
    await trader.tick();
    const r = await trader.run(force(), x.state());
    assert.equal(r.note, 'paused', 'run() refuses while paused');
  }
  assert.equal(trader.lastSkip.paused, 1, 'tick() reports paused');
  assert.equal(await nonce(), n0, 'no transaction submitted while paused');
  await setControl(controlFile, 'all', true, 'test');
  const resumed = await trader.run(force(), x.state());
  assert.equal(resumed.status, 'completed', resumed.note);
  assert.ok((await nonce()) > n0, 'trading restarted');
  ok(`[${key}] 1. paused for 60 ticks (=10 min): 0 transactions; resumed: next loop ran (${resumed.txs.length} txs)`);

  // ---- 2. Pause after leg 1 of 2 → the loop still completes; nothing new starts.
  const legsSeen: number[] = [];
  const midToken = x.cycle()[0]!.tokenOut;
  const midBefore = (await chain.pub.readContract({ address: midToken, abi: erc20Abi, functionName: 'balanceOf', args: [bot] })) as bigint;
  afterLeg = async (i) => {
    legsSeen.push(i);
    if (i === 0) await setControl(controlFile, 'all', false, 'test mid-loop');
  };
  const mid = await trader.run(force(), x.state());
  afterLeg = undefined;
  assert.equal(mid.status, 'completed', `mid-loop pause must not abandon the loop: ${mid.note}`);
  assert.deepEqual(legsSeen, [0, 1], 'both legs ran');
  assert.equal(await chain.pub.readContract({ address: midToken, abi: erc20Abi, functionName: 'balanceOf', args: [bot] }), midBefore, 'no intermediate token left behind by the loop');
  const n2 = await nonce();
  assert.equal((await trader.run(force(), x.state())).note, 'paused');
  assert.equal(await nonce(), n2, 'nothing new after the mid-loop pause');
  ok(`[${key}] 2. paused during leg 1: loop completed back to ${x.tokens.get(x.stable)?.symbol}, no new loop started`);

  // ---- 3. "Restart" while paused: a new trader instance reads the same control file.
  trader = mkTrader();
  await trader.restore();
  assert.equal(trader.paused(), true, 'comes back paused');
  await trader.tick();
  assert.equal(trader.lastSkip.paused, 1);
  assert.equal(await nonce(), n2);
  ok(`[${key}] 3. restarted while paused: still paused, no transactions`);

  // ---- 6. Per-chain: other chain off, this on → trades; this off → stops.
  await setControl(controlFile, 'all', true, 'test');
  await setControl(controlFile, other, false, 'test');
  const p6 = await trader.run(force(), x.state());
  assert.equal(p6.status, 'completed', `${key} must keep trading when only ${other} is paused: ${p6.note}`);
  await setControl(controlFile, other, true, 'test');
  await setControl(controlFile, key, false, 'test');
  assert.equal((await trader.run(force(), x.state())).note, 'paused', `${key} switch off stops ${key}`);
  ok(`[${key}] 6. ${other} paused only: ${key} kept trading; ${key} paused: ${key} stopped`);

  // ---- 5. Deposit and withdraw $1 through the console API, signed in as the owner.
  await chain.pub.request({ method: 'anvil_setBalance' as never, params: [owner.address, `0x${parseEther('1').toString(16)}`] as never });
  const ownerWallet = createWalletClient({ account: owner, chain: cfg.viem, transport: http(x.rpc) });
  // Seed the owner's own wallet with $2 (test setup only, from the bot wallet).
  await chain.pub.waitForTransactionReceipt({ hash: await chain.wallet.writeContract({ account: chain.wallet.account!, chain: chain.wallet.chain, address: x.stable, abi: erc20Abi, functionName: 'transfer', args: [ownerAddr, 2n * unit] }) });

  const { app } = createAgentApp({
    owner: ownerAddr,
    withdrawTo: ownerAddr,
    domains: ['fisika.lol'],
    secureCookie: false,
    controlFile,
    eventsFile,
    chains: [{ chain: cfg, tokens: x.tokens, client: chain.pub as unknown as AgentChainClient, state: x.state, dataDir, wallet: bot, lowGas: parseEther('0.001') }],
  });
  const call = async (path: string, body?: unknown, cookie?: string) =>
    app.fetch(new Request(`http://x${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const { nonce: n } = await (await call('/v1/agent/nonce')).json();
  const message = createSiweMessage({ address: owner.address, chainId: cfg.id, domain: 'fisika.lol', nonce: n, uri: 'https://fisika.lol', version: '1', issuedAt: new Date() });
  const login = await call('/v1/agent/login', { message, signature: await owner.signMessage({ message }) });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const sym = x.tokens.get(x.stable)!.symbol;
  const botBal = async () => (await (await call('/v1/agent/balances', undefined, cookie)).json()).chains[0].tokens.find((t: any) => t.symbol === sym).balance as string;
  const before = Number(await botBal());

  // Deposit $1 from the owner's wallet (what the console's "Deposit from connected wallet" signs).
  const dep = await ownerWallet.writeContract({ address: x.stable, abi: erc20Abi, functionName: 'transfer', args: [bot, unit] });
  await chain.pub.waitForTransactionReceipt({ hash: dep });
  const rec = await (await call('/v1/agent/deposits', { chain: key, txHash: dep }, cookie)).json();
  assert.deepEqual(rec.recorded, [{ token: sym, amount: '1' }]);
  assert.equal(Number(await botBal()), before + 1, 'balance +1 after deposit');

  // Withdraw $1: queued by the API, sent by the trader (key holder) on its next tick, to the owner only.
  await setControl(controlFile, 'all', true, 'test');
  await setControl(controlFile, key, true, 'test');
  const ownerBefore = await chain.pub.readContract({ address: x.stable, abi: erc20Abi, functionName: 'balanceOf', args: [ownerAddr] });
  const w = await (await call('/v1/agent/withdraw', { chain: key, token: sym, amount: '1' }, cookie)).json();
  assert.match(w.id, /^w_/, JSON.stringify(w));
  const st = await (await call('/v1/agent/state', undefined, cookie)).json();
  assert.equal(st.chains[0].trading, false, 'withdraw paused the chain');
  await trader.tick();
  const done = await (await call(`/v1/agent/withdrawals/${key}/${w.id}`, undefined, cookie)).json();
  assert.equal(done.status, 'sent', JSON.stringify(done));
  assert.equal(done.to, ownerAddr);
  const ownerAfter = await chain.pub.readContract({ address: x.stable, abi: erc20Abi, functionName: 'balanceOf', args: [ownerAddr] });
  assert.equal(ownerAfter - ownerBefore, unit, 'owner received exactly $1');
  assert.equal(Number(await botBal()), before, 'bot balance back where it was');
  assert.equal((await (await call('/v1/agent/state', undefined, cookie)).json()).chains[0].trading, false, 'stays paused until the owner reactivates');

  // Max on the gas token keeps the reserve.
  const wMax = await (await call('/v1/agent/withdraw', { chain: key, token: 'native', amount: 'max' }, cookie)).json();
  await trader.tick();
  const maxDone = await (await call(`/v1/agent/withdrawals/${key}/${wMax.id}`, undefined, cookie)).json();
  assert.equal(maxDone.status, 'sent', JSON.stringify(maxDone));
  const leftNative = await chain.pub.getBalance({ address: bot });
  assert.ok(leftNative >= x.base.minNativeForGas, `Max kept the gas reserve (${leftNative})`);

  const act = await (await call(`/v1/agent/activity?kind=funding&chain=${key}`, undefined, cookie)).json();
  const types = act.rows.map((r: any) => r.type);
  for (const t of ['deposit', 'withdraw_requested', 'withdraw_sent']) assert.ok(types.includes(t), `${t} in funding history`);
  assert.ok((await readEvents(eventsFile)).length > 0);
  const trades = await (await call(`/v1/agent/trades?chain=${key}&status=completed`, undefined, cookie)).json();
  assert.ok(trades.total >= 3, 'the loops above are in the trade history');
  const csv = await (await call(`/v1/agent/trades?chain=${key}&format=csv`, undefined, cookie)).text();
  assert.ok(csv.split('\n').length > 3);
  ok(`[${key}] 5. deposit $1 (${dep.slice(0, 10)}…) and withdraw $1 (${String(done.txHash).slice(0, 10)}…) to the owner; balances, funding history and trade history updated; Max ${cfg.nativeSymbol} kept the gas reserve`);
  void readFile;
}
