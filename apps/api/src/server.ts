import { serve } from '@hono/node-server';
import { chainByKey, TokenRegistry, type ChainConfig } from '@fisika/core';
import { createVenues, LiveGraph } from '@fisika/core/setup';
import { makeClient, redactRpc, vetRpcs } from '@fisika/core/viem';
import { PaperArbRunner } from './arb.ts';
import { createApp, multiChainFetch } from './app.ts';
import { Heatmap } from './heatmap.ts';
import { loadConfig } from './config.ts';
import { makePaymentGate } from './x402.ts';

const cfg = loadConfig();
const { gate, server } = makePaymentGate(cfg);
if (server) await server.initialize().catch((e: Error) => console.error('x402 facilitator /supported failed:', e.message));

/** One price graph, arb scanner and app per chain. A chain that fails to start is left out; Celo must start. */
async function startChain(chain: ChainConfig) {
  const pc = cfg.perChain[chain.key]!;
  const vetting = await vetRpcs(pc.rpcUrls, 20, fetch, chain.id);
  if (!vetting.ok.length) throw new Error(`no usable ${chain.name} RPC: ${JSON.stringify(vetting.rejected)}`);
  if (vetting.rejected.length) console.warn(`[rpc ${chain.key}] rejected:`, vetting.rejected);
  const client = makeClient(vetting.ok, chain.viem);
  const tokens = new TokenRegistry(chain.tokens);
  const venues = await createVenues(client, tokens, { apiKey: cfg.textileApiKey ?? undefined }, undefined, chain);
  const live = new LiveGraph(client, tokens, venues, cfg.edgeMaxAgeMs, vetting.ok);
  await live.start(cfg.graphRefreshMs);

  const startTokens = chain.startTokens.map((s) => tokens.bySymbol(s).address);
  const arb = cfg.arbPaper
    ? new PaperArbRunner(() => live.state, tokens, venues.byId, { startTokens, sizesUsd: [10, 100, 1_000], maxLen: 4, maxAgeMs: cfg.edgeMaxAgeMs, textileAtomic: false, ...cfg.arb })
    : undefined;
  const heatmap = new Heatmap();
  setInterval(() => {
    heatmap.record(live.state, tokens, chain.corridors);
    void arb?.tick().catch((e: Error) => console.error(`[${chain.key}] arb tick failed:`, e.message));
  }, Math.max(cfg.graphRefreshMs, 5_000));

  const { app } = createApp({
    cfg,
    chain,
    tokens,
    arb,
    heatmap,
    live: pc.live,
    textile: cfg.textileApiKey ? venues.textile : null,
    state: () => live.state,
    paymentGate: gate,
    getTxReceipt: async (hash) => client.getTransactionReceipt({ hash }).catch(() => null),
  });
  const pools = Object.entries(venues.v3Pools).map(([k, n]) => `${k} ${n}`).join(', ');
  console.log(`[${chain.key}] rpc ${vetting.ok.map(redactRpc).join(', ')} · pools: ${pools}${chain.mento ? ` · mento v2: ${venues.mentoV2Pairs.join(', ')}` : ''} · textile ${venues.textile ? 'on' : 'off'}`);
  return app;
}

const apps: Record<string, { fetch: (req: Request) => Response | Promise<Response> }> = {};
const served: ChainConfig[] = [];
for (const key of cfg.chains) {
  const chain = chainByKey(key);
  try {
    apps[key] = await startChain(chain);
    served.push(chain);
  } catch (e) {
    if (key === 'celo') throw e;
    console.error(`[${key}] not served: ${(e as Error).message}`);
  }
}

serve({ fetch: multiChainFetch(apps, served), port: cfg.port, hostname: cfg.host });
console.log(`fisika api on :${cfg.port} · chains ${served.map((c) => c.key).join(', ')} · x402 ${server ? 'on' : 'OFF'} · execution ${cfg.executionEnabled ? 'on' : 'off'}`);
