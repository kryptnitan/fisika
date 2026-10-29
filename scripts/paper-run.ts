/**
 * Live PAPER run for one chain: build the price graph from every venue the chain has, print the FX board for each
 * corridor at $10 / $100 / $1,000, and run one arbitrage engine tick (nothing is signed).
 * Run: CHAIN=celo|bsc [RPC_URLS=https://...] node scripts/paper-run.ts   → writes verification/paper-run[-bsc].md
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { formatUnits } from 'viem';
import { ArbEngine, RiskGate, type ArbConfig } from '../packages/core/src/arb.ts';
import { chainByKey } from '../packages/core/src/chains.ts';
import { makeClient, vetRpcs } from '../packages/core/src/chain/viem.ts';
import { createVenues, nativeUsdFromGraph } from '../packages/core/src/chain/setup.ts';
import { PriceGraph } from '../packages/core/src/graph.ts';
import { Pricer, SAMPLE_USD } from '../packages/core/src/pricer.ts';
import { refreshGraph } from '../packages/core/src/refresh.ts';
import { bestRoute } from '../packages/core/src/router.ts';
import { TokenRegistry } from '../packages/core/src/tokens.ts';
import type { VenueAdapter, VenueId } from '../packages/core/src/types.ts';

const chain = chainByKey(process.env.CHAIN);
const suffix = chain.key === 'celo' ? '' : `-${chain.key}`;
const rpcEnv = chain.key === 'celo' ? process.env.CELO_RPC_URLS || process.env.RPC_URLS : process.env.RPC_URLS;
const rpcs = (rpcEnv || chain.freeRpcs.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const vetting = await vetRpcs(rpcs, 20, fetch, chain.id);
if (!vetting.ok.length) throw new Error(`no usable ${chain.name} RPC: ${JSON.stringify(vetting.rejected)}`);
const client = makeClient(vetting.ok, chain.viem);
const tokens = new TokenRegistry(chain.tokens);
const T = (s: string) => tokens.bySymbol(s).address;
const CORRIDORS = chain.corridors;

async function main() {
  const lines: string[] = [];
  const log = (s = '') => {
    lines.push(s);
    console.log(s);
  };

  const graph = new PriceGraph();
  const pricer = new Pricer(tokens, graph, 120_000);
  const hubs = chain.startTokens.map(T);
  const venues = await createVenues(client, tokens, {}, undefined, chain);
  const adapters: VenueAdapter[] = venues.adapters;
  const v2ex = venues.mentoV2Pairs;

  // Pass 1 prices non-USD tokens off USD-side edges; pass 2 samples their reverse directions at correct sizes.
  const r1 = await refreshGraph(graph, pricer, adapters);
  const now = Date.now();
  const r2 = await refreshGraph(graph, pricer, adapters, now);

  const gasPrice = await client.getGasPrice();
  const nativeUsd = nativeUsdFromGraph(graph, tokens, chain.wrappedNative) ?? 0;

  log(`# fisika PAPER run — ${chain.name}`);
  log('');
  log(`${new Date(now).toISOString()} · block ${await client.getBlockNumber()} · gas ${formatUnits(gasPrice, 9)} gwei · ${chain.nativeSymbol} $${nativeUsd.toFixed(4)} · rpc ${vetting.ok.length}/${rpcs.length} vetted`);
  log('');
  const bs = (venues.reader as { stats?: object }).stats;
  log(`RPC requests (pool discovery + two full refreshes, batched): ${venues.reader.requests}. Batch stats: ${JSON.stringify(bs)}`);
  log('');
  log(`v3 pools discovered: ${Object.entries(venues.v3Pools).map(([k, n]) => `${k} ${n}`).join(', ')}.${chain.mento ? ` Mento v2 exchanges between tracked tokens: ${v2ex.join(', ') || 'none'}.` : ''} Textile: ${chain.textile ? 'yes' : 'no'}. Graph edges: ${graph.size()}.`);
  log('');
  log('| Venue | Pass 1 | Pass 2 |');
  log('|---|---|---|');
  for (let i = 0; i < r2.length; i++) log(`| ${r2[i]!.venue} | ${r1[i]!.ok ? `${r1[i]!.edges} edges` : `ERR ${r1[i]!.error}`} | ${r2[i]!.ok ? `${r2[i]!.edges} edges, ${r2[i]!.ms} ms` : `ERR ${r2[i]!.error}`} |`);
  log('');

  const details: string[] = [];
  log('## FX board');
  log('');
  log('Rate = output per 1 unit of input at that size, after venue fees, before the fisika service fee. "—" = no route has the depth.');
  log('');
  log(`| Corridor | ${SAMPLE_USD.slice(0, 3).map((u) => `$${u}`).join(' | ')} | Venues ($100) | Execution ($100) |`);
  log('|---|---|---|---|---|---|');
  for (const [a, b] of CORRIDORS) {
    const tin = T(a);
    const tout = T(b);
    const cells: string[] = [];
    let venues = '—';
    let exec = '—';
    for (const usd of SAMPLE_USD.slice(0, 3)) {
      const amountIn = pricer.amountForUsd(tin, usd, now);
      if (!amountIn) {
        cells.push('unpriced');
        continue;
      }
      const r = bestRoute(graph, pricer, { tokenIn: tin, tokenOut: tout, amountIn, nowMs: now, maxAgeMs: 120_000, gasPriceWei: gasPrice, nativeUsd });
      if (!r) {
        cells.push('—');
        continue;
      }
      const rate = Number(formatUnits(r.amountOut, tokens.decimals(tout))) / Number(formatUnits(amountIn, tokens.decimals(tin)));
      cells.push(rate >= 100 ? rate.toFixed(2) : rate.toFixed(6));
      details.push(
        `- ${a}→${b} $${usd}: ` +
          r.paths
            .map((p) => {
              const hops = p.edges.map((e, i) => `${e.venue}[${tokens.get(e.tokenIn)?.symbol}→${tokens.get(e.tokenOut)?.symbol} ${formatUnits(p.hopAmounts[i]!, tokens.decimals(e.tokenIn))}→${formatUnits(p.hopAmounts[i + 1]!, tokens.decimals(e.tokenOut))}]`);
              return hops.join(' ');
            })
            .join(' + '),
      );
      if (usd === 100) {
        venues = r.paths.map((p) => p.edges.map((e) => e.venue).join('→')).join(' + ');
        exec = `${r.execution}${r.txCount > 1 ? ` (${r.txCount} tx)` : ''}`;
      }
    }
    log(`| ${a}→${b} | ${cells.join(' | ')} | ${venues} | ${exec} |`);
  }
  log('');
  log('<details><summary>Route breakdown per corridor and size</summary>');
  log('');
  for (const d of details) log(d);
  log('');
  log('</details>');
  log('');

  const cfg: ArbConfig = {
    startTokens: hubs,
    sizesUsd: [10, 100, 1_000],
    maxLen: 4,
    maxAgeMs: 120_000,
    minEdgeBps: 5,
    minEdgeUsd: 0.05,
    maxTradeUsd: 1_000,
    slippageBps: 30,
    dailyLossLimitUsd: 25,
    maxTokenExposureUsd: 200,
    textileAtomic: false,
    gasPriceWei: gasPrice,
    nativeUsd,
  };
  const engine = new ArbEngine(graph, pricer, new Map<VenueId, VenueAdapter>(adapters.map((a) => [a.id, a])), new RiskGate(cfg, pricer, () => false), cfg);
  const opps = engine.scan(now);
  log('## Arbitrage scan (PAPER)');
  log('');
  log(`${opps.length} cycle(s) with positive net profit on graph prices.`);
  log('');
  if (opps.length) {
    log('| Cycle | Size | Net bps | Net $ | Txs | Indicative legs |');
    log('|---|---|---|---|---|---|');
    for (const o of opps.slice(0, 10)) {
      const path = [o.cycle[0]!.tokenIn, ...o.cycle.map((e) => e.tokenOut)].map((t) => tokens.get(t)?.symbol ?? t.slice(0, 8)).join('→');
      log(`| ${path} via ${o.cycle.map((e) => e.venue).join(',')} | $${o.sizeUsd} | ${o.netBps.toFixed(2)} | ${o.netUsd.toFixed(4)} | ${o.txCount} | ${o.indicativeLegs} |`);
    }
    log('');
    const decisions = await engine.tick(Date.now());
    log('Engine tick (live re-quote of each leg, then risk gate):');
    log('');
    for (const d of decisions) log(`- ${d.action}${d.reason ? ` (${d.reason})` : ''}: net ${d.opportunity.netBps.toFixed(2)} bps / $${d.opportunity.netUsd.toFixed(4)}`);
  }

  await mkdir('verification', { recursive: true });
  await writeFile(`verification/paper-run${suffix}.md`, lines.join('\n'));
  // Full graph at board time, so any routing decision can be replayed offline exactly.
  await writeFile(`verification/graph-snapshot${suffix}.json`, JSON.stringify({ now, gasPrice: gasPrice.toString(), nativeUsd, edges: graph.snapshot() }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
