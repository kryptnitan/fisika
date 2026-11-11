/**
 * Solana meme desk service.
 *
 *   MEME_MODE=PAPER node src/meme-desk.ts          (the only mode today: live trading comes after the paper record)
 *
 * Env (all optional): MEME_DATA_DIR (/var/lib/fisika/meme), MEME_PAPER_EQUITY (100), SOLANA_RPC_URLS,
 * JUPITER_API_KEY, CONTROL_FILE, MEME_SESSION_MINUTES (stop after N minutes; CI), and rule overrides:
 * MEME_SIZE_PCT, MEME_MIN_TRADE_USD, MEME_MAX_TRADE_USD, MEME_DAILY_LOSS_PCT, MEME_STOP_LOSS_PCT, MEME_TRAIL_PCT,
 * MEME_MAX_HOLD_MIN, MEME_MAX_OPEN, MEME_SWAP_COST_USD.
 */
import { defaultControlFile } from './agent/control.ts';
import { MemeEngine } from './meme/engine.ts';
import { DexScreener, FREE_SOLANA_RPCS, GeckoTerminal, Jupiter, SOLANA_MAINNET_GENESIS, SolanaRpc } from './meme/sources.ts';
import { DEFAULT_RULES, type MemeRules } from './meme/strategy.ts';

const env = process.env;
const mode = (env.MEME_MODE ?? 'PAPER').toUpperCase();
if (mode !== 'PAPER') {
  console.error('fisika meme desk: only PAPER mode exists so far. Live trading is added after the paper record is reviewed.');
  process.exit(1);
}

const num = (k: string, d: number) => (env[k] !== undefined && env[k] !== '' && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
const rules: MemeRules = {
  ...DEFAULT_RULES,
  sizePct: num('MEME_SIZE_PCT', DEFAULT_RULES.sizePct),
  minTradeUsd: num('MEME_MIN_TRADE_USD', DEFAULT_RULES.minTradeUsd),
  maxTradeUsd: num('MEME_MAX_TRADE_USD', DEFAULT_RULES.maxTradeUsd),
  dailyLossPct: num('MEME_DAILY_LOSS_PCT', DEFAULT_RULES.dailyLossPct),
  stopLossPct: num('MEME_STOP_LOSS_PCT', DEFAULT_RULES.stopLossPct),
  trailPct: num('MEME_TRAIL_PCT', DEFAULT_RULES.trailPct),
  maxHoldMin: num('MEME_MAX_HOLD_MIN', DEFAULT_RULES.maxHoldMin),
  maxOpen: num('MEME_MAX_OPEN', DEFAULT_RULES.maxOpen),
};

// Only RPCs that answer as Solana mainnet are used.
const candidates = (env.SOLANA_RPC_URLS || FREE_SOLANA_RPCS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const ok: string[] = [];
for (const u of candidates) {
  const g = await new SolanaRpc([u]).genesisHash().catch(() => null);
  if (g === SOLANA_MAINNET_GENESIS) ok.push(u);
  else console.warn(`[meme] rpc rejected ${new URL(u).host}: ${g ?? 'unreachable'}`);
}
if (!ok.length) {
  console.error('[meme] no Solana mainnet RPC reachable');
  process.exit(1);
}

const engine = new MemeEngine({
  dex: new DexScreener(),
  gecko: new GeckoTerminal(),
  jup: new Jupiter(env.JUPITER_API_KEY),
  rpc: new SolanaRpc(ok),
  rules,
  dataDir: env.MEME_DATA_DIR ?? '/var/lib/fisika/meme',
  controlFile: env.MEME_IGNORE_SWITCH === 'true' ? undefined : defaultControlFile(),
  startEquityUsd: num('MEME_PAPER_EQUITY', 100),
  swapCostUsd: num('MEME_SWAP_COST_USD', 0.01),
});
await engine.restore();
await engine.writeStatus();
console.log(`fisika meme desk · PAPER · equity $${engine.equity().toFixed(2)} · size ${rules.sizePct}% ($${rules.minTradeUsd}–$${rules.maxTradeUsd}) · daily loss ${rules.dailyLossPct}% · stop ${rules.stopLossPct}% · trail ${rules.trailPct}% · ${engine.paused() ? 'PAUSED (switch on in My agent)' : 'active'} · rpc ${ok.map((u) => new URL(u).host).join(', ')}`);

const safe = (f: () => Promise<void>, what: string) => () => void f().catch((e: Error) => console.error(`[meme] ${what} failed: ${e.message}`));
const watch = safe(() => engine.watch(), 'watch');
const scan = safe(() => engine.scan(), 'scan');
scan();
const t1 = setInterval(watch, 15_000);
const t2 = setInterval(scan, 60_000);

const minutes = num('MEME_SESSION_MINUTES', 0);
const stop = async (why: string) => {
  clearInterval(t1);
  clearInterval(t2);
  await engine.writeStatus().catch(() => undefined);
  console.log(`[meme] stopped (${why}) · equity $${engine.equity().toFixed(2)} · trades ${engine.state.stats.trades} · open ${engine.state.positions.length}`);
  process.exit(0);
};
if (minutes > 0) setTimeout(() => void stop(`session of ${minutes} min`), minutes * 60_000);
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
