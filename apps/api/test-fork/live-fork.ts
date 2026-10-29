/**
 * End-to-end test of the LIVE trader against an anvil fork of Celo mainnet (run by CI).
 *
 * Real contracts, real pool state, real approvals and swaps: funds a throwaway anvil account with USDT taken from
 * a Uniswap pool (impersonated), then forces two cycles through LiveTrader.run():
 *   A. USDT → USDm (Uniswap) → USDT (Mento v3)                          2 legs
 *   B. USDT → USDm (Uniswap) → KESm (Mento v2) → USDm (Mento v2) → USDT (Mento v3)   4 legs
 * Both lose a little (fees), which is expected: the test checks the plumbing, not profit. To get past the
 * trader's "is it still profitable" guard, the test credits a fake gas allowance; nothing else is bypassed.
 *
 *   anvil --fork-url https://forno.celo.org &
 *   node test-fork/live-fork.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWalletClient, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { TokenRegistry, type Edge, type Opportunity } from '@fisika/core';
import { createVenues, LiveGraph } from '@fisika/core/setup';
import { erc20Abi, makeClient } from '@fisika/core/viem';
import { balanceOf, executeLeg, LegError, registerTokens } from '../src/live/legs.ts';
import { LiveTrader } from '../src/live/trader.ts';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
// anvil's well-known first dev key: a throwaway, holds nothing on mainnet.
const TEST_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const USDT_SOURCE = '0x5dc631ad6c26bea1a59fbf2c2680cf3df43d249f'; // Uniswap USDT/USDm 0.01% pool (verified on-chain)

const pub = makeClient([RPC]);
const account = privateKeyToAccount(TEST_KEY);
const wallet = createWalletClient({ account, chain: celo, transport: http(RPC) });
const tokens = new TokenRegistry();
registerTokens(tokens.all().map((t) => t.address));
const USDT = tokens.bySymbol('USDT').address;
const USDm = tokens.bySymbol('USDm').address;
const KESm = tokens.bySymbol('KESm').address;

const rpc = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
const results: string[] = [];
const ok = (m: string) => {
  results.push(`PASS ${m}`);
  console.log(`PASS ${m}`);
};

// Fund: CELO for gas, 300 USDT from the impersonated pool.
await rpc('anvil_setBalance', [account.address, `0x${parseEther('100').toString(16)}`]);
await rpc('anvil_setBalance', [USDT_SOURCE, `0x${parseEther('10').toString(16)}`]);
await rpc('anvil_impersonateAccount', [USDT_SOURCE]);
const whale = createWalletClient({ account: USDT_SOURCE as Hex, chain: celo, transport: http(RPC) });
await pub.waitForTransactionReceipt({
  hash: await whale.writeContract({ address: USDT, abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [] }], functionName: 'transfer', args: [account.address, 300_000_000n] }),
});
await rpc('anvil_stopImpersonatingAccount', [USDT_SOURCE]);
assert.equal(await pub.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }), 300_000_000n);
ok('funded test wallet with 300 USDT from the fork');

const venues = await createVenues(pub, tokens);
const live = new LiveGraph(pub, tokens, venues, 600_000);
await live.refresh();
await live.refresh();
const st = live.state;
const edge = (venue: Edge['venue'], a: string, b: string, pool?: string) => {
  const e = st.graph.all().find((x) => x.venue === venue && x.tokenIn === a && x.tokenOut === b && (!pool || x.poolId === pool));
  assert.ok(e, `no ${venue} edge ${tokens.get(a)?.symbol}->${tokens.get(b)?.symbol} in the fork graph`);
  return e!;
};
const uniPool = '0x5dc631ad6c26bea1a59fbf2c2680cf3df43d249f';

const dir = await mkdtemp(join(tmpdir(), 'fisika-live-'));
const chain = { pub, wallet, account: account.address.toLowerCase() as Hex, receiptTimeoutSec: 60 };
const trader = new LiveTrader(chain, () => live.state, tokens, venues.byId, null, {
  startTokens: [USDT],
  sizesUsd: [20],
  maxLen: 4,
  maxAgeMs: 600_000,
  maxTradeUsd: 50,
  minEdgeBps: 0,
  minEdgeUsd: 0,
  slippageBps: 50,
  dailyLossLimitUsd: 5,
  maxTokenExposureUsd: 50,
  textileAtomic: false,
  ledgerPath: join(dir, 'ledger.jsonl'),
  statusPath: join(dir, 'status.json'),
  killFile: join(dir, 'KILL'),
  minCeloForGas: parseEther('0.5'),
});

const force = (cycle: Edge[], amountIn: bigint): Opportunity => ({
  id: 'fork-test',
  cycle,
  start: USDT,
  amountIn,
  amounts: [],
  grossProfit: 0n,
  gasUnits: 0n,
  // Test-only: credit a fake gas allowance so the trader's final profitability check lets a losing cycle through.
  gasInStart: -amountIn,
  netProfit: 0n,
  netBps: 0,
  netUsd: 0,
  txCount: cycle.length,
  venues: cycle.map((e) => e.venue),
  indicativeLegs: 0,
  sizeUsd: 20,
});

// A. two legs
const before = await balanceOf(chain, USDT);
const a = await trader.run(force([edge('uniswap-v3', USDT, USDm, uniPool), edge('mento', USDm, USDT)], 20_000_000n), st);
assert.equal(a.status, 'completed', a.note);
const lossA = Number(before - (await balanceOf(chain, USDT))) / 1e6;
assert.ok(lossA >= 0 && lossA < 0.2, `cycle A lost ${lossA} USDT`);
assert.equal(await balanceOf(chain, USDm), 0n, 'no USDm left behind');
ok(`2-leg cycle USDT→USDm→USDT completed in ${a.txs.length} txs, cost ${lossA.toFixed(4)} USDT, ledger P&L $${a.realizedUsd.toFixed(4)}`);

// B. four legs through Mento v2
const b = await trader.run(force([edge('uniswap-v3', USDT, USDm, uniPool), edge('mento-v2', USDm, KESm), edge('mento-v2', KESm, USDm), edge('mento', USDm, USDT)], 20_000_000n), st);
assert.equal(b.status, 'completed', b.note);
assert.ok((await balanceOf(chain, KESm)) === 0n, 'no KESm left behind');
ok(`4-leg cycle via Mento v2 completed in ${b.txs.length} txs, ledger P&L $${b.realizedUsd.toFixed(4)}`);

// Ledger + status written.
const ledger = (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n');
assert.equal(ledger.length, 2);
await trader.writeStatus();
const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
assert.equal(status.mode, 'LIVE');
assert.equal(status.trades, 2);
ok('ledger and status file written');

// A minimum the market cannot meet reverts on-chain and spends nothing but gas.
const bal = await balanceOf(chain, USDT);
await assert.rejects(executeLeg(chain, edge('uniswap-v3', USDT, USDm, uniPool), 5_000_000n, 10n ** 30n, null, Math.floor(Date.now() / 1000) + 60), LegError);
assert.equal(await balanceOf(chain, USDT), bal, 'reverted swap moved no USDT');
ok('impossible minimum output reverts and moves no funds');

// Textile legs need the API key; without it the leg is refused before anything is sent.
await assert.rejects(executeLeg(chain, { ...edge('uniswap-v3', USDT, USDm, uniPool), venue: 'textile' }, 1_000_000n, 1n, null, 0), /TEXTILE_API_KEY/);
ok('Textile leg without a key is refused');

console.log(`\n${results.length} checks passed`);
process.exit(0);
