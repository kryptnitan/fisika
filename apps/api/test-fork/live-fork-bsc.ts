/**
 * BNB Chain end-to-end on an anvil fork (run by CI): real PancakeSwap v3 and Uniswap v3 contracts, real pool state.
 *
 *   A. Live trader, 2 legs: USDT → WBNB on PancakeSwap (v3 SwapRouter, deadline in the struct)
 *                           → USDT on Uniswap (SwapRouter02, no deadline)
 *   B. A minimum the market cannot meet reverts and moves no funds.
 *   C. A leg aimed at a venue that is not on BNB Chain (Mento) is refused before anything is sent.
 *   D. Dashboard swap path: /v1/build's direct builder (no executor on BNB Chain) produces approve + router swap;
 *      the test wallet signs both, and the receipt is verified from the Transfer logs.
 *
 *   anvil --fork-url https://bsc-rpc.publicnode.com &
 *   node test-fork/live-fork-bsc.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWalletClient, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BSC, bestRoute, PriceGraph, Pricer, refreshGraph, TokenRegistry, UniswapV3Adapter, type Edge, type Opportunity, type VenueAdapter, type VenueId } from '@fisika/core';
import type { GraphState } from '@fisika/core/setup';
import { BatchReader } from '@fisika/core/batch';
import { buildDirectTxs } from '@fisika/core/build';
import { erc20Abi, makeClient, viemUniV3Reader } from '@fisika/core/viem';
import { balanceOf, executeLeg, LegError, registerTokens } from '../src/live/legs.ts';
import { LiveTrader } from '../src/live/trader.ts';
import { makeReceipt } from '../src/receipts.ts';
import type { StoredQuote } from '../src/quotes.ts';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545';
const TEST_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil dev key #0
// PancakeSwap v3 USDT/WBNB 0.01% pool, listed by verify-onchain (CHAIN=bsc) with ~11M USDT: the USDT source.
const USDT_SOURCE = '0x172fcd41e0913e95784454622d1c3724f546f849';
const PANCAKE_POOL = USDT_SOURCE;
const UNI_POOL = '0x6fe9e9de56356f7edbfcbb29fab7cd69471a4869'; // Uniswap v3 USDT/WBNB 0.05% on BNB Chain

const pub = makeClient([RPC], BSC.viem);
const account = privateKeyToAccount(TEST_KEY);
const wallet = createWalletClient({ account, chain: BSC.viem, transport: http(RPC) });
const tokens = new TokenRegistry(BSC.tokens);
registerTokens(tokens.all().map((t) => t.address));
const USDT = tokens.bySymbol('USDT').address;
const WBNB = tokens.bySymbol('WBNB').address;
const E18 = 10n ** 18n;

const rpc = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
let passed = 0;
const ok = (m: string) => {
  passed += 1;
  console.log(`PASS ${m}`);
};

assert.equal(await pub.getChainId(), 56, 'fork is BNB Chain');

// Fund: BNB for gas, 300 USDT from the impersonated pool.
await rpc('anvil_setBalance', [account.address, `0x${parseEther('10').toString(16)}`]);
await rpc('anvil_setBalance', [USDT_SOURCE, `0x${parseEther('1').toString(16)}`]);
await rpc('anvil_impersonateAccount', [USDT_SOURCE]);
const whale = createWalletClient({ account: USDT_SOURCE as Hex, chain: BSC.viem, transport: http(RPC) });
await pub.waitForTransactionReceipt({
  hash: await whale.writeContract({ address: USDT, abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'transfer', args: [account.address, 300n * E18] }),
});
await rpc('anvil_stopImpersonatingAccount', [USDT_SOURCE]);
assert.equal(await pub.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }), 300n * E18);
ok('funded test wallet with 300 USDT on the BNB Chain fork');

const reader = new BatchReader(pub);
const dex = (id: 'uniswap-v3' | 'pancake-v3') => BSC.v3Dexes.find((d) => d.id === id)!;
const uni = new UniswapV3Adapter(viemUniV3Reader(pub, reader, dex('uniswap-v3')), [500], 'uniswap-v3');
const cake = new UniswapV3Adapter(viemUniV3Reader(pub, reader, dex('pancake-v3')), [100], 'pancake-v3');
await uni.discover([[USDT, WBNB]]);
await cake.discover([[USDT, WBNB]]);
const adapters = new Map<VenueId, VenueAdapter>([['uniswap-v3', uni], ['pancake-v3', cake]]);

const graph = new PriceGraph();
const pricer = new Pricer(tokens, graph, 600_000);
// Two passes: the first prices WBNB from USDT edges, the second samples WBNB → USDT at sensible sizes.
await refreshGraph(graph, pricer, [uni, cake]);
await refreshGraph(graph, pricer, [uni, cake]);
const nativeUsd = pricer.usdValue(WBNB, E18, Date.now());
assert.ok(nativeUsd && nativeUsd > 50 && nativeUsd < 10_000, `WBNB priced from the graph: $${nativeUsd}`);
const st: GraphState = { graph, pricer, gasPriceWei: 50_000_000n, nativeUsd, block: 0n, updatedMs: Date.now(), lastRefresh: [], rpc: { checkedMs: 0, degraded: false, vetting: null } };
ok(`graph built from PancakeSwap + Uniswap on the fork (BNB $${nativeUsd.toFixed(2)})`);

const chain = { pub, wallet, account: account.address.toLowerCase() as Hex, receiptTimeoutSec: 60, config: BSC };
const edge = (venue: Edge['venue'], a: string, b: string, poolId: string, fee: number): Edge => ({
  venue, poolId, tokenIn: a as Hex, tokenOut: b as Hex, points: [], gasUnits: 0n, feeBps: 0, firm: true, asOfMs: Date.now(), meta: { fee },
});

// A. Live trader, two legs across the two DEX router shapes.
const dir = await mkdtemp(join(tmpdir(), 'fisika-live-bsc-'));
const trader = new LiveTrader(chain, () => st, tokens, adapters, null, {
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
  minNativeForGas: parseEther('0.005'),
});
const amount = 20n * E18;
const force = (cycle: Edge[]): Opportunity => ({
  id: 'fork-test-bsc', cycle, start: USDT, amountIn: amount, amounts: [], grossProfit: 0n, gasUnits: 0n,
  gasInStart: -amount, // test-only: lets a (fee-losing) cycle past the final profitability guard
  netProfit: 0n, netBps: 0, netUsd: 0, txCount: cycle.length, venues: cycle.map((e) => e.venue), indicativeLegs: 0, sizeUsd: 20,
});
const before = await balanceOf(chain, USDT);
const a = await trader.run(force([edge('pancake-v3', USDT, WBNB, PANCAKE_POOL, 100), edge('uniswap-v3', WBNB, USDT, UNI_POOL, 500)]), st);
assert.equal(a.status, 'completed', a.note);
const lossA = Number(before - (await balanceOf(chain, USDT))) / 1e18;
assert.ok(lossA >= 0 && lossA < 0.5, `cycle A lost ${lossA} USDT`);
assert.equal(await balanceOf(chain, WBNB), 0n, 'no WBNB left behind');
ok(`2-leg cycle USDT→WBNB (PancakeSwap)→USDT (Uniswap) completed in ${a.txs.length} txs, cost ${lossA.toFixed(4)} USDT`);

// B. Impossible minimum reverts (before or on-chain) and moves nothing.
const bal = await balanceOf(chain, USDT);
await assert.rejects(executeLeg(chain, edge('pancake-v3', USDT, WBNB, PANCAKE_POOL, 100), 5n * E18, 10n ** 30n, null, Math.floor(Date.now() / 1000) + 60), LegError);
assert.equal(await balanceOf(chain, USDT), bal, 'reverted swap moved no USDT');
ok('impossible minimum output reverts and moves no funds');

// C. Mento is a Celo venue: refused on BNB Chain before anything is sent.
await assert.rejects(executeLeg(chain, edge('mento', USDT, WBNB, 'x', 0), 1n * E18, 1n, null, 0), /not on BNB Chain/);
ok('a Celo-only venue is refused on BNB Chain');

// D. The dashboard's swap: quote → direct build → the wallet signs both transactions → verified receipt.
const route = bestRoute(graph, pricer, { tokenIn: USDT, tokenOut: WBNB, amountIn: 25n * E18, nowMs: Date.now(), maxAgeMs: 600_000, gasPriceWei: st.gasPriceWei, nativeUsd, slippageBps: 50 });
assert.ok(route, 'route USDT→WBNB');
assert.equal(route.execution, 'atomic');
const built = buildDirectTxs(route, BSC.v3Dexes, { recipient: chain.account, slippageBps: 50, deadlineSec: Math.floor(Date.now() / 1000) + 600, chainId: 56 });
let last: Hex = '0x';
for (const tx of built.txs) {
  last = await wallet.sendTransaction({ account, chain: BSC.viem, to: tx.to, data: tx.data, value: 0n });
  const r = await pub.waitForTransactionReceipt({ hash: last });
  assert.equal(r.status, 'success', tx.description);
}
const mined = await pub.getTransactionReceipt({ hash: last });
const q: StoredQuote = { id: 'q_fork', route, createdMs: 0, expiresMs: 0, slippageBps: 50, feeBps: 0, direct: { target: built.txs[1]!.to, recipient: chain.account } };
const rec = makeReceipt(q, last, mined, { kind: 'direct', target: built.txs[1]!.to, recipient: chain.account, explorer: BSC.explorer }, tokens);
assert.equal(rec.status, 'filled');
assert.ok(BigInt(Math.round(Number(rec.realizedOut) * 1e18)) >= (built.minOut * 999n) / 1000n, 'received at least minOut');
ok(`dashboard swap 25 USDT → ${rec.realizedOut} WBNB via ${route.venues.join('+')} (direct router build, receipt verified)`);

console.log(`\n${passed} checks passed`);
process.exit(0);
