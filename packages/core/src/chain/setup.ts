/**
 * Wires every venue adapter for one chain and keeps that chain's price graph fresh.
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
import { CELO, type ChainConfig } from '../chains.ts';
import { BatchReader, type Reader } from './batch.ts';
import { discoverMentoV2Exchanges, erc20Abi, redactRpc, vetRpcs, viemMentoReader, viemMentoV2Reader, viemUniV3Reader, type RpcVetting } from './viem.ts';

export const CELO_TOKEN: Address = '0x471ece3750da237f93b8e339c536989b8978a438';

export interface Venues {
  chain: ChainConfig;
  adapters: VenueAdapter[];
  byId: Map<VenueId, VenueAdapter>;
  /** Textile adapter when the chain has Textile, else null. */
  textile: TextileAdapter | null;
  /** Pools found per v3 DEX, e.g. { 'uniswap-v3': 39 }. */
  v3Pools: Record<string, number>;
  /** Back-compat: Uniswap pool count. */
  uniswapPools: number;
  mentoV2Pairs: string[];
  /** Batched reader shared by every venue; `requests` counts eth_calls sent. */
  reader: Reader;
}

/** Build every venue the chain has: each v3 DEX in its config, Mento (Celo only), Textile where deployed. */
export async function createVenues(client: PublicClient, tokens: TokenRegistry, textile: TextileConfig = {}, slots?: RfqSlots, chain: ChainConfig = CELO): Promise<Venues> {
  // Tokens configured without decimals get them from the token contract itself, never a guess.
  for (const t of tokens.all()) {
    if (t.decimals !== null) continue;
    const d = await client.readContract({ address: t.address, abi: erc20Abi, functionName: 'decimals' });
    tokens.applyOnchainDecimals(t.address, Number(d));
  }
  const T = (s: string) => tokens.bySymbol(s).address;
  const hubs = chain.hubs.map(T);
  const pairs: [Address, Address][] = [];
  for (const h of hubs) for (const t of tokens.all()) if (t.address !== h && !pairs.some(([x, y]) => (x === t.address && y === h))) pairs.push([h, t.address]);

  const reader = new BatchReader(client);
  const adapters: VenueAdapter[] = [];
  const v3Pools: Record<string, number> = {};
  for (const dex of chain.v3Dexes) {
    const ad = new UniswapV3Adapter(viemUniV3Reader(client, reader, dex), dex.feeTiers, dex.id);
    v3Pools[dex.id] = (await ad.discover(pairs)).length;
    adapters.push(ad);
  }

  let mentoV2Pairs: string[] = [];
  if (chain.mento) {
    adapters.push(
      new MentoAdapter(viemMentoReader(client, reader), [
        { tokenA: T('USDT'), tokenB: T('USDm'), poolId: MENTO.fpmmPools['USDT/USDm'] },
        { tokenA: T('USDC'), tokenB: T('USDm'), poolId: MENTO.fpmmPools['USDC/USDm'] },
        { tokenA: T('USDm'), tokenB: T('EURm'), poolId: 'mento-default-USDm/EURm' },
      ]),
    );
    const known = new Set(tokens.all().map((t) => t.address));
    const v2 = (await discoverMentoV2Exchanges(client).catch(() => [])).filter((e) => e.assets.length === 2 && e.assets.every((a) => known.has(a)));
    adapters.push(new MentoAdapter(viemMentoV2Reader(client, v2, undefined, reader), v2.map((e) => ({ tokenA: e.assets[0]!, tokenB: e.assets[1]!, poolId: e.exchangeId })), 'mento-v2'));
    mentoV2Pairs = v2.map((e) => e.assets.map((a) => tokens.get(a)?.symbol ?? a).join('/'));
  }

  let tex: TextileAdapter | null = null;
  if (chain.textile) {
    tex = new TextileAdapter({ ...textile, chainId: chain.textile.chainId }, slots);
    adapters.push(tex);
  }

  return {
    chain,
    adapters,
    byId: new Map(adapters.map((a) => [a.id, a])),
    textile: tex,
    v3Pools,
    uniswapPools: v3Pools['uniswap-v3'] ?? 0,
    mentoV2Pairs,
    reader,
  };
}

export interface GraphState {
  graph: PriceGraph;
  pricer: Pricer;
  gasPriceWei: bigint;
  nativeUsd: number;
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

  private readonly tokens: TokenRegistry;

  constructor(client: PublicClient, tokens: TokenRegistry, venues: Venues, maxAgeMs = 15_000, rpcUrls: readonly string[] = []) {
    this.client = client;
    this.venues = venues;
    this.rpcUrls = rpcUrls;
    this.tokens = tokens;
    const graph = new PriceGraph();
    this.state = { graph, pricer: new Pricer(tokens, graph, maxAgeMs), gasPriceWei: 25_000_000_000n, nativeUsd: 0, block: 0n, updatedMs: 0, lastRefresh: [], rpc: { checkedMs: 0, degraded: false, vetting: null } };
  }

  async refresh(): Promise<void> {
    if (this.running) return; // never overlap refreshes
    this.running = true;
    try {
      const now = Date.now();
      if (this.rpcUrls.length > 1 && now - this.state.rpc.checkedMs > 600_000) {
        const vetting = await vetRpcs(this.rpcUrls, 20, fetch, this.venues.chain.id).catch(() => null);
        const primaryOk = !!vetting && vetting.ok.includes(this.rpcUrls[0]!);
        this.state.rpc = { checkedMs: now, degraded: !primaryOk, vetting };
        if (!primaryOk) console.warn(`[rpc] primary ${redactRpc(this.rpcUrls[0]!)} failed vetting; pausing price updates`, vetting?.rejected);
      }
      if (this.state.rpc.degraded) return;
      const [gas, block] = await Promise.all([this.client.getGasPrice().catch(() => this.state.gasPriceWei), this.client.getBlockNumber().catch(() => this.state.block)]);
      this.state.lastRefresh = await refreshGraph(this.state.graph, this.state.pricer, this.venues.adapters, now);
      this.state.gasPriceWei = gas;
      this.state.block = block;
      this.state.nativeUsd = nativeUsdFromGraph(this.state.graph, this.tokens, this.venues.chain.wrappedNative) ?? this.state.nativeUsd;
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

/**
 * Gas-token price in USD from the smallest sample of any edge selling the wrapped native token for a USD token
 * (Celo: Textile and Uniswap quote CELO→USDT; BNB Chain: Uniswap/PancakeSwap WBNB→USDT). Used for gas only.
 */
export function nativeUsdFromGraph(graph: PriceGraph, tokens: TokenRegistry, wrappedNative: Address = CELO_TOKEN): number | null {
  const w = wrappedNative.toLowerCase();
  let best: number | null = null;
  for (const e of graph.all()) {
    if (e.tokenIn !== w || !e.points.length) continue;
    const out = tokens.get(e.tokenOut);
    if (!out?.usd || out.decimals === null) continue;
    const p = e.points[0]!;
    const px = Number(p.amountOut) / 10 ** out.decimals / (Number(p.amountIn) / 1e18);
    if (best === null || px > best) best = px;
  }
  return best;
}
