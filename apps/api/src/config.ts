import type { Address } from '@fisika/core';

export interface ApiConfig {
  port: number;
  publicUrl: string;
  webUrl: string;
  rpcUrls: string[];
  graphRefreshMs: number;
  edgeMaxAgeMs: number;
  /** x402: when facilitator key or payTo is missing, paid routes answer 503 instead of serving for free. */
  x402: { facilitatorUrl: string; apiKey: string | null; payTo: Address | null; quotePriceAtomic: string; buildPriceAtomic: string };
  freeTierKeys: Set<string>;
  /** Keys for fisika's own web app (server-side proxy only): no payment, no daily cap. Never ship to browsers. */
  internalKeys: Set<string>;
  /** Bearer token for /v1/admin/* (kill switch). */
  adminToken: string | null;
  arbPaper: boolean;
  arb: { maxTradeUsd: number; minEdgeBps: number; minEdgeUsd: number; slippageBps: number; dailyLossLimitUsd: number; maxTokenExposureUsd: number };
  freeTierDailyLimit: number;
  /** Building client transactions is off until legal scope is settled and an executor is deployed. */
  executionEnabled: boolean;
  executor: Address | null;
  serviceFeeBps: number;
  feeTo: Address | null;
  defaultSlippageBps: number;
  textileApiKey: string | null;
  agent: { id: string | null; wallet: Address | null; name: string; image: string };
}

const isAddr = (v: string | undefined): v is Address => !!v && /^0x[0-9a-fA-F]{40}$/.test(v);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const num = (k: string, d: number) => {
    const v = env[k];
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
    return n;
  };
  const addr = (k: string): Address | null => {
    const v = env[k];
    if (!v) return null;
    if (!isAddr(v)) throw new Error(`${k} is not an address`);
    return v.toLowerCase() as Address;
  };
  const feeBps = num('SERVICE_FEE_BPS', 0); // no cut of swaps until the legal review clears it
  if (feeBps < 0 || feeBps > 100) throw new Error('SERVICE_FEE_BPS must be 0..100 (the executor caps it at 100)');
  const executionEnabled = env.EXECUTION_ENABLED === 'true';
  const executor = addr('EXECUTOR_ADDRESS');
  const feeTo = addr('FEE_TO');
  if (executionEnabled && (!executor || (feeBps > 0 && !feeTo))) throw new Error('EXECUTION_ENABLED needs EXECUTOR_ADDRESS and FEE_TO');
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${num('PORT', 8787)}`).replace(/\/$/, '');
  return {
    port: num('PORT', 8787),
    publicUrl,
    webUrl: (env.WEB_URL ?? publicUrl).replace(/\/$/, ''),
    rpcUrls: (env.CELO_RPC_URLS || 'https://forno.celo.org,https://celo-rpc.publicnode.com').split(',').map((s) => s.trim()).filter(Boolean),
    graphRefreshMs: num('GRAPH_REFRESH_MS', 10_000),
    edgeMaxAgeMs: num('EDGE_MAX_AGE_MS', Math.max(15_000, num('GRAPH_REFRESH_MS', 10_000) * 2.5)),
    x402: {
      facilitatorUrl: env.X402_FACILITATOR_URL ?? 'https://api.x402.celo.org',
      apiKey: env.X402_API_KEY || null,
      payTo: addr('X402_PAY_TO'),
      quotePriceAtomic: env.X402_QUOTE_PRICE ?? '1000', // $0.001 in 6-decimal USDC
      buildPriceAtomic: env.X402_BUILD_PRICE ?? '1000',
    },
    freeTierKeys: new Set((env.FREE_TIER_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    freeTierDailyLimit: num('FREE_TIER_DAILY_LIMIT', 100),
    internalKeys: new Set((env.INTERNAL_API_KEYS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length >= 24)),
    adminToken: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 24 ? env.ADMIN_TOKEN : null,
    arbPaper: env.ARB_PAPER !== 'false',
    arb: {
      maxTradeUsd: num('MAX_TRADE_USD', 1_000),
      minEdgeBps: num('MIN_EDGE_BPS', 5),
      minEdgeUsd: num('MIN_EDGE_USD', 0.05),
      slippageBps: num('SLIPPAGE_BPS', 30),
      dailyLossLimitUsd: num('DAILY_LOSS_LIMIT_USD', 25),
      maxTokenExposureUsd: num('MAX_TOKEN_EXPOSURE_USD', 200),
    },
    executionEnabled,
    executor,
    serviceFeeBps: feeBps,
    feeTo,
    defaultSlippageBps: num('SLIPPAGE_BPS', 30),
    textileApiKey: env.TEXTILE_API_KEY || null,
    agent: { id: env.AGENT_ID || null, wallet: addr('AGENT_WALLET'), name: env.AGENT_NAME ?? 'fisika', image: env.AGENT_IMAGE ?? '' },
  };
}
