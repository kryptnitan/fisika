/**
 * Wires every venue adapter against a live Celo client and keeps the price graph fresh.
 * Shared by the API, the arb service and scripts/paper-run.ts.
 */
import type { PublicClient } from 'viem';
import { MENTO } from '../addresses.ts';
import { MentoAdapter } from '../adapters/mento.ts';
import { TextileAdapter, type RfqSlots, type TextileConfig } from '../adapters/textile.ts';
import { UniswapV3Adapter } from '../adapters/uniswapV3.ts';
import { PriceGraph } from '../graph.ts';
import { Pricer } from '../pricer.ts';
import { refreshGraph, type RefreshResult } from '../refresh.ts';
import type { TokenRegistry } from '../tokens.ts';
import type { Address, VenueAdapter, VenueId } from '../types.ts';
import { BatchReader, type Reader } from './batch.ts';
import { discoverMentoV2Exchanges, redactRpc, vetRpcs, viemMentoReader, viemMentoV2Reader, viemUniV3Reader, type RpcVetting } from './viem.ts';

export const CELO_TOKEN: Address = '0x471ece3750da237f93b8e339c536989b8978a438';

export interface Venues {
  adapters: VenueAdapter[];
  byId: Map<VenueId, VenueAdapter>;
  textile: TextileAdapter;
  uniswapPools: number;
  mentoV2Pairs: string[];
  /** Batched reader shared by every venue; `requests` counts eth_calls sent. */
  reader: Reader;
}

export async function createVenues(client: PublicClient, tokens: TokenRegistry, textile: TextileConfig = {}, slots?: RfqSlots): Promise<Venues> {
  const T = (s: string) => tokens.bySymbol(s).address;
  const hubs = ['USDT', 'USDC', 'USDm'].map(T);
  const pairs: [Address, Address][] = [];
  for (const h of hubs) for (const t of tokens.all()) if (t.address !== h) pairs.push([h, t.address]);

  const reader = new BatchReader(client);
  const uni = new UniswapV3Adapter(viemUniV3Reader(client, reader));
  const pools = await uni.discover(pairs);

  const mento = new MentoAdapter(viemMentoReader(client, reader), [
    { tokenA: T('USDT'), tokenB: T('USDm'), poolId: MENTO.fpmmPools['USDT/USDm'] },
    { tokenA: T('USDC'), tokenB: T('USDm'), poolId: MENTO.fpmmPools['USDC/USDm'] },
    { tokenA: T('USDm'), tokenB: T('EURm'), poolId: 'mento-default-USDm/EURm' },
  ]);

  const known = new Set(tokens.all().map((t) => t.address));
  const v2 = (await discoverMentoV2Exchanges(client).catch(() => [])).filter((e) => e.assets.length === 2 && e.assets.every((a) => known.has(a)));
  const mentoV2 = new MentoAdapter(
    viemMentoV2Reader(client, v2, undefined, reader),
    v2.map((e) => ({ tokenA: e.assets[0]!, tokenB: e.assets[1]!, poolId: e.exchangeId })),
    'mento-v2',
  );

  const tex = new TextileAdapter(textile, slots);
  const adapters: VenueAdapter[] = [uni, mento, mentoV2, tex];
  return {
    adapters,
    byId: new Map(adapters.map((a) => [a.id, a])),
    textile: tex,
    uniswapPools: pools.length,
    mentoV2Pairs: v2.map((e) => e.assets.map((a) => tokens.get(a)?.symbol ?? a).join('/')),
    reader,
  };
}

export interface GraphState {
  graph: PriceGraph;
  pricer: Pricer;
  gasPriceWei: bigint;
  celoUsd: number;
  block: bigint;
  updatedMs: number;
  lastRefresh: RefreshResult[];
  /** Latest RPC vetting. When the primary endpoint lags or reports the wrong chain, prices stop updating
   *  (and age out to "not fresh") rather than being served from a source that disagrees with the others. */
  rpc: { checkedMs: number; degraded: boolean; vetting: RpcVetting | null };
}

/** Keeps one graph fresh on an interval. Readers always get the latest completed refresh. */
export class LiveGraph {
  readonly state: GraphState;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly client: PublicClient;
  private readonly venues: Venues;
  private readonly rpcUrls: readonly string[];

  constructor(client: PublicClient, tokens: TokenRegistry, venues: Venues, maxAgeMs = 15_000, rpcUrls: readonly string[] = []) {
    this.client = client;
    this.venues = venues;
    this.rpcUrls = rpcUrls;
    const graph = new PriceGraph();
    this.state = { graph, pricer: new Pricer(tokens, graph, maxAgeMs), gasPriceWei: 25_000_000_000n, celoUsd: 0, block: 0n, updatedMs: 0, lastRefresh: [], rpc: { checkedMs: 0, degraded: false, vetting: null } };
  }

  async refresh(): Promise<void> {
    if (this.running) return; // never overlap refreshes
    this.running = true;
    try {
      const now = Date.now();
      if (this.rpcUrls.length > 1 && now - this.state.rpc.checkedMs > 600_000) {
        const vetting = await vetRpcs(this.rpcUrls).catch(() => null);
        const primaryOk = !!vetting && vetting.ok.includes(this.rpcUrls[0]!);
        this.state.rpc = { checkedMs: now, degraded: !primaryOk, vetting };
        if (!primaryOk) console.warn(`[rpc] primary ${redactRpc(this.rpcUrls[0]!)} failed vetting; pausing price updates`, vetting?.rejected);
      }
      if (this.state.rpc.degraded) return;
      const [gas, block] = await Promise.all([this.client.getGasPrice().catch(() => this.state.gasPriceWei), this.client.getBlockNumber().catch(() => this.state.block)]);
      this.state.lastRefresh = await refreshGraph(this.state.graph, this.state.pricer, this.venues.adapters, now);
      this.state.gasPriceWei = gas;
      this.state.block = block;
      this.state.celoUsd = celoUsdFromGraph(this.state.graph) ?? this.state.celoUsd;
      this.state.updatedMs = now;
    } finally {
      this.running = false;
    }
  }

  /** Two passes: the first prices non-USD tokens from USD-side edges, the second samples their reverse side. */
  async start(intervalMs: number): Promise<void> {
    await this.refresh();
    await this.refresh();
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** CELO/USD from the smallest CELO→USDT sample in the graph (Textile and Uniswap both quote it). */
export function celoUsdFromGraph(graph: PriceGraph): number | null {
  const USDT = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e';
  const e = graph.all().find((x) => x.tokenIn === CELO_TOKEN && x.tokenOut === USDT && x.points.length);
  if (!e) return null;
  const p = e.points[0]!;
  return Number(p.amountOut) / 1e6 / (Number(p.amountIn) / 1e18);
}
