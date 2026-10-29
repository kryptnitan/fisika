/**
 * fisika LIVE arbitrage process. Holds the only copy of the arb wallet key; the API never sees it.
 *
 *   MODE=LIVE LIVE_ACK=i-accept-risk ARB_PRIVATE_KEY=0x… TEXTILE_API_KEY=tx_live_… \
 *   MAX_TRADE_USD=100 DAILY_LOSS_LIMIT_USD=10 node src/live-trader.ts
 *
 * Refuses to start unless every limit is set explicitly. Stop new trades: `touch $KILL_FILE`
 * (or the dashboard's Stop button). `systemctl stop` lets a cycle in progress finish first.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { createWalletClient, http, parseEther, type Hex } from 'viem';
import { TokenRegistry } from '@fisika/core';
import { createVenues, LiveGraph } from '@fisika/core/setup';
import { FREE_CELO_RPCS, makeClient, redactRpc, vetRpcs } from '@fisika/core/viem';
import { registerTokens } from './live/legs.ts';
import { LiveTrader } from './live/trader.ts';

const env = process.env;
const die = (m: string): never => {
  console.error(`refusing to start: ${m}`);
  process.exit(1);
};
if (env.MODE !== 'LIVE' || env.LIVE_ACK !== 'i-accept-risk') die('set MODE=LIVE and LIVE_ACK=i-accept-risk');
const key = env.ARB_PRIVATE_KEY as Hex | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) die('ARB_PRIVATE_KEY missing or malformed');
const need = (k: string) => {
  const v = env[k];
  if (v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0) die(`${k} must be set explicitly in LIVE mode`);
  return Number(v);
};
const limits = {
  maxTradeUsd: need('MAX_TRADE_USD'),
  dailyLossLimitUsd: need('DAILY_LOSS_LIMIT_USD'),
  maxTokenExposureUsd: need('MAX_TOKEN_EXPOSURE_USD'),
  minEdgeBps: need('MIN_EDGE_BPS'),
  minEdgeUsd: need('MIN_EDGE_USD'),
  slippageBps: need('SLIPPAGE_BPS'),
};
if (limits.slippageBps > 100) die('SLIPPAGE_BPS above 100 (1%) is not allowed in LIVE');
if (limits.maxTokenExposureUsd < limits.maxTradeUsd && env.ALLOW_TEXTILE !== 'false') {
  console.warn('[live] MAX_TOKEN_EXPOSURE_USD < MAX_TRADE_USD: two-transaction (Textile) cycles larger than the exposure cap will be skipped');
}
const refreshMs = Number(env.GRAPH_REFRESH_MS ?? 10_000);
const dataDir = env.DATA_DIR ?? '/var/lib/fisika';

const urls = (env.CELO_RPC_URLS || FREE_CELO_RPCS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const vetting = await vetRpcs(urls);
if (!vetting.ok.length) die(`no usable Celo RPC: ${JSON.stringify(vetting.rejected)}`);
const pub = makeClient(vetting.ok);
const account = privateKeyToAccount(key!);
const wallet = createWalletClient({ account, chain: celo, transport: http(vetting.ok[0]) });

const tokens = new TokenRegistry();
registerTokens(tokens.all().map((t) => t.address));
const textileKey = env.ALLOW_TEXTILE === 'false' ? undefined : env.TEXTILE_API_KEY || undefined;
if (env.ALLOW_TEXTILE !== 'false' && !textileKey) die('TEXTILE_API_KEY is required (or set ALLOW_TEXTILE=false for Uniswap/Mento only)');
const venues = await createVenues(pub, tokens, { apiKey: textileKey });
const adapters = new Map(venues.byId);
if (env.ALLOW_TEXTILE === 'false') adapters.delete('textile');
const live = new LiveGraph(pub, tokens, venues, refreshMs * 2.5, vetting.ok);
await live.start(refreshMs);

const trader = new LiveTrader(
  { pub, wallet, account: account.address.toLowerCase() as Hex },
  () => live.state,
  tokens,
  adapters,
  textileKey ? venues.textile : null,
  {
    ...limits,
    startTokens: [tokens.bySymbol('USDT').address],
    sizesUsd: [10, 25, 50, 100, 250].filter((s) => s <= limits.maxTradeUsd),
    maxLen: 4,
    maxAgeMs: refreshMs * 2.5,
    textileAtomic: false,
    ledgerPath: `${dataDir}/live-ledger.jsonl`,
    statusPath: `${dataDir}/live-status.json`,
    killFile: env.KILL_FILE ?? `${dataDir}/KILL`,
    minCeloForGas: parseEther(env.MIN_CELO_FOR_GAS ?? '0.5'),
  },
);
await trader.restore();

console.log(
  `fisika LIVE · wallet ${account.address} · rpc ${vetting.ok.map(redactRpc).join(', ')} · max trade $${limits.maxTradeUsd} · daily loss limit $${limits.dailyLossLimitUsd} · textile ${textileKey ? 'on' : 'off'}`,
);

const timer = setInterval(() => void trader.tick().catch((e: Error) => console.error('[live] tick failed:', e.message)), refreshMs);
const shutdown = async () => {
  trader.stopping = true;
  clearInterval(timer);
  // Let a cycle in progress finish so the wallet is not left holding an intermediate token.
  for (let i = 0; i < 300 && trader.busy; i++) await new Promise((r) => setTimeout(r, 1_000));
  live.stop();
  await trader.writeStatus().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
