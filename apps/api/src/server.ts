import { serve } from '@hono/node-server';
import { TokenRegistry } from '@fisika/core';
import { createVenues, LiveGraph } from '@fisika/core/setup';
import { makeClient, redactRpc, vetRpcs } from '@fisika/core/viem';
import { PaperArbRunner } from './arb.ts';
import { CORRIDORS, createApp } from './app.ts';
import { Heatmap } from './heatmap.ts';
import { loadConfig } from './config.ts';
import { makePaymentGate } from './x402.ts';

const cfg = loadConfig();
const vetting = await vetRpcs(cfg.rpcUrls);
if (!vetting.ok.length) throw new Error(`no usable Celo RPC: ${JSON.stringify(vetting.rejected)}`);
if (vetting.rejected.length) console.warn('[rpc] rejected:', vetting.rejected);
const client = makeClient(vetting.ok);
const tokens = new TokenRegistry();

const venues = await createVenues(client, tokens, { apiKey: cfg.textileApiKey ?? undefined });
const live = new LiveGraph(client, tokens, venues, cfg.edgeMaxAgeMs, vetting.ok);
await live.start(cfg.graphRefreshMs);

const { gate, server } = makePaymentGate(cfg);
if (server) await server.initialize().catch((e: Error) => console.error('x402 facilitator /supported failed:', e.message));

const tokensUsd = ['USDT', 'USDC', 'USDm'].map((s) => tokens.bySymbol(s).address);
const arb = cfg.arbPaper
  ? new PaperArbRunner(() => live.state, tokens, venues.byId, { startTokens: tokensUsd, sizesUsd: [10, 100, 1_000], maxLen: 4, maxAgeMs: cfg.edgeMaxAgeMs, textileAtomic: false, ...cfg.arb })
  : undefined;
const heatmap = new Heatmap();
setInterval(() => {
  heatmap.record(live.state, tokens, CORRIDORS);
  void arb?.tick().catch((e: Error) => console.error('arb tick failed:', e.message));
}, Math.max(cfg.graphRefreshMs, 5_000));

const { app } = createApp({
  cfg,
  tokens,
  arb,
  heatmap,
  state: () => live.state,
  paymentGate: gate,
  getTxReceipt: async (hash) => client.getTransactionReceipt({ hash }).catch(() => null),
});

serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host });
console.log(
  `fisika api on :${cfg.port} · rpc ${vetting.ok.map(redactRpc).join(', ')} · ${venues.uniswapPools} uniswap pools · mento v2: ${venues.mentoV2Pairs.join(', ')} · x402 ${server ? 'on' : 'OFF'} · execution ${cfg.executionEnabled ? 'on' : 'off'}`,
);
