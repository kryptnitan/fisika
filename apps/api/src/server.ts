import { serve } from '@hono/node-server';
import { TokenRegistry } from '@fisika/core';
import { createVenues, LiveGraph } from '@fisika/core/setup';
import { makeClient } from '@fisika/core/viem';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { makePaymentGate } from './x402.ts';

const cfg = loadConfig();
const client = makeClient(cfg.rpcUrls);
const tokens = new TokenRegistry();

const venues = await createVenues(client, tokens, { apiKey: cfg.textileApiKey ?? undefined });
const live = new LiveGraph(client, tokens, venues, cfg.edgeMaxAgeMs);
await live.start(cfg.graphRefreshMs);

const { gate, server } = makePaymentGate(cfg);
if (server) await server.initialize().catch((e: Error) => console.error('x402 facilitator /supported failed:', e.message));

const { app } = createApp({
  cfg,
  tokens,
  state: () => live.state,
  paymentGate: gate,
  getTxReceipt: async (hash) => client.getTransactionReceipt({ hash }).catch(() => null),
});

serve({ fetch: app.fetch, port: cfg.port });
console.log(
  `fisika api on :${cfg.port} · ${venues.uniswapPools} uniswap pools · mento v2: ${venues.mentoV2Pairs.join(', ')} · x402 ${server ? 'on' : 'OFF'} · execution ${cfg.executionEnabled ? 'on' : 'off'}`,
);
