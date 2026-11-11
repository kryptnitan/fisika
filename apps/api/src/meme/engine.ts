/**
 * Solana meme desk engine. PAPER mode: real Solana market data and real Jupiter quotes, no wallet, nothing signed.
 * Every fill is the amount Jupiter says the swap would return at that moment, so slippage, price impact and sell taxes
 * are in the numbers, plus a per-swap network cost.
 *
 * Loops:
 * - scan (every 60 s): new Solana tokens from DexScreener → cheap screen → momentum signal → on-chain safety →
 *   all-time high → buy-then-sell quote check → open a position sized by the rules.
 * - watch (every 15 s): fresh pair data for open positions → exit rules → close at a Jupiter sell quote.
 *
 * The console switch (control file, key "solana") stops NEW entries. Open positions keep being managed and closed by
 * their exit rules, so pausing never leaves a position unattended.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chainTrades, readControlSync } from '../agent/control.ts';
import { bestPairs, type DexPair, type DexScreener, type GeckoTerminal, type Jupiter, type SolanaRpc, USDC_MINT } from './sources.ts';
import { dayLossPct, entrySignal, exitDecision, roundTrip, safety, screen, tradeSize, type ExitReason, type MemeRules, type Position } from './strategy.ts';

export interface MemeDeps {
  dex: Pick<DexScreener, 'latestSolanaTokens' | 'pairsFor'>;
  gecko: Pick<GeckoTerminal, 'allTimeHigh'>;
  jup: Pick<Jupiter, 'quote'>;
  rpc: Pick<SolanaRpc, 'mint' | 'largestAccounts'>;
  rules: MemeRules;
  dataDir: string;
  controlFile?: string;
  startEquityUsd: number;
  swapCostUsd: number;
  now?: () => number;
  log?: (m: string) => void;
}

export interface Decision {
  at: string;
  mint: string;
  symbol: string;
  action: 'skip' | 'open' | 'close' | 'halt';
  reason: string;
  usd?: number;
}

export interface ClosedTrade {
  at: string;
  mode: 'PAPER' | 'LIVE';
  id: string;
  mint: string;
  symbol: string;
  pair: string;
  openedAt: string;
  heldMin: number;
  costUsd: number;
  proceedsUsd: number;
  pnlUsd: number;
  pnlPct: number;
  reason: ExitReason;
  entryPrice: number;
  exitPrice: number;
  peakPrice: number;
  athAtEntry: number | null;
}

interface State {
  cashUsd: number;
  positions: Position[];
  day: string;
  dayStartEquity: number;
  halted: boolean;
  haltReason: string | null;
  cooldown: Record<string, number>;
  watch: Record<string, number>; // token -> last seen ms
  stats: { trades: number; wins: number; realizedUsd: number; scans: number; candidates: number };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class MemeEngine {
  private readonly d: MemeDeps;
  private s: State;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  recent: Decision[] = [];
  private safeCache = new Map<string, { atMs: number; verdict: string | null }>();
  private busy = false;

  constructor(d: MemeDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((m) => console.log(`[meme] ${m}`));
    this.s = this.fresh();
  }

  private fresh(): State {
    return { cashUsd: this.d.startEquityUsd, positions: [], day: day(this.now()), dayStartEquity: this.d.startEquityUsd, halted: false, haltReason: null, cooldown: {}, watch: {}, stats: { trades: 0, wins: 0, realizedUsd: 0, scans: 0, candidates: 0 } };
  }

  get state(): Readonly<State> {
    return this.s;
  }

  private file(name: string) {
    return `${this.d.dataDir}/${name}`;
  }

  async restore(): Promise<void> {
    await mkdir(this.d.dataDir, { recursive: true });
    try {
      this.s = { ...this.fresh(), ...(JSON.parse(await readFile(this.file('meme-state.json'), 'utf8')) as State) };
    } catch {
      /* first run */
    }
  }

  private async persist(): Promise<void> {
    const tmp = this.file(`meme-state.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(this.s, null, 2));
    await rename(tmp, this.file('meme-state.json'));
  }

  paused(): boolean {
    if (!this.d.controlFile) return false;
    return !chainTrades(readControlSync(this.d.controlFile), 'solana');
  }

  private note(dc: Omit<Decision, 'at'>) {
    // The same token skipped for the same reason scan after scan is one fact, not forty: keep the latest only.
    if (dc.action === 'skip') this.recent = this.recent.filter((x) => !(x.action === 'skip' && x.mint === dc.mint && x.reason === dc.reason));
    this.recent.unshift({ at: new Date(this.now()).toISOString(), ...dc });
    this.recent = this.recent.slice(0, 60);
    if (dc.action !== 'skip') this.log(`${dc.action} ${dc.symbol} ${dc.reason}${dc.usd !== undefined ? ` $${dc.usd.toFixed(2)}` : ''}`);
  }

  equity(): number {
    return this.s.cashUsd + this.s.positions.reduce((a, p) => a + p.lastValueUsd, 0);
  }

  /** New UTC day: new loss budget, halt lifted. */
  private rollDay() {
    const today = day(this.now());
    if (today !== this.s.day) {
      this.s.day = today;
      this.s.dayStartEquity = this.equity();
      if (this.s.halted && this.s.haltReason === 'daily_loss_limit') {
        this.s.halted = false;
        this.s.haltReason = null;
      }
    }
  }

  /* ------------------------------------------------------------------------------------------- watch */

  async watch(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.rollDay();
      if (this.s.positions.length) {
        const pairs = await this.d.dex.pairsFor(this.s.positions.map((p) => p.mint));
        const byPair = new Map(pairs.map((p) => [p.pairAddress, p]));
        for (const pos of [...this.s.positions]) {
          const p = byPair.get(pos.pair) ?? null;
          if (p && Number(p.priceUsd)) {
            pos.lastPrice = Number(p.priceUsd);
            pos.peakPrice = Math.max(pos.peakPrice, pos.lastPrice);
            pos.lastValueUsd = (Number(pos.tokensRaw) / 10 ** pos.decimals) * pos.lastPrice;
          }
          const why = exitDecision(pos, p, this.now(), this.d.rules);
          if (why) await this.close(pos, why);
        }
      }
      // Daily loss limit on realized + open: close everything, stop until tomorrow.
      if (!this.s.halted && dayLossPct(this.s.dayStartEquity, this.equity()) >= this.d.rules.dailyLossPct) {
        this.s.halted = true;
        this.s.haltReason = 'daily_loss_limit';
        this.note({ mint: '-', symbol: '-', action: 'halt', reason: `daily loss ${dayLossPct(this.s.dayStartEquity, this.equity()).toFixed(2)}% ≥ ${this.d.rules.dailyLossPct}%` });
        for (const pos of [...this.s.positions]) await this.close(pos, 'daily_loss_limit');
      }
      await this.persist();
      await this.writeStatus();
    } finally {
      this.busy = false;
    }
  }

  private async close(pos: Position, reason: ExitReason): Promise<void> {
    const q = await this.d.jup.quote(pos.mint, USDC_MINT, BigInt(pos.tokensRaw)).catch(() => null);
    const sellable = q !== null;
    const proceeds = sellable ? Number(q!.outAmount) / 1e6 - this.d.swapCostUsd : 0;
    const why: ExitReason = sellable ? reason : 'rug_cannot_sell';
    const tokens = Number(pos.tokensRaw) / 10 ** pos.decimals;
    const t: ClosedTrade = {
      at: new Date(this.now()).toISOString(),
      mode: 'PAPER',
      id: pos.id,
      mint: pos.mint,
      symbol: pos.symbol,
      pair: pos.pair,
      openedAt: new Date(pos.openedMs).toISOString(),
      heldMin: Math.round((this.now() - pos.openedMs) / 60_000),
      costUsd: pos.costUsd,
      proceedsUsd: Math.max(0, proceeds),
      pnlUsd: Math.max(0, proceeds) - pos.costUsd,
      pnlPct: ((Math.max(0, proceeds) - pos.costUsd) / pos.costUsd) * 100,
      reason: why,
      entryPrice: pos.entryPrice,
      exitPrice: tokens > 0 ? Math.max(0, proceeds) / tokens : 0,
      peakPrice: pos.peakPrice,
      athAtEntry: pos.athAtEntry,
    };
    this.s.cashUsd += t.proceedsUsd;
    this.s.positions = this.s.positions.filter((p) => p.id !== pos.id);
    this.s.cooldown[pos.mint] = this.now();
    this.s.stats.trades += 1;
    if (t.pnlUsd > 0) this.s.stats.wins += 1;
    this.s.stats.realizedUsd += t.pnlUsd;
    await appendFile(this.file('meme-ledger.jsonl'), `${JSON.stringify(t)}\n`);
    this.note({ mint: pos.mint, symbol: pos.symbol, action: 'close', reason: `${why} (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%)`, usd: t.pnlUsd });
  }

  /* -------------------------------------------------------------------------------------------- scan */

  async scan(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.rollDay();
      this.s.stats.scans += 1;
      const t = this.now();
      for (const m of await this.d.dex.latestSolanaTokens()) this.s.watch[m] ??= t;
      for (const [m, seen] of Object.entries(this.s.watch)) if (t - seen > 6 * 3_600_000) delete this.s.watch[m];
      if (this.paused() || this.s.halted || this.s.positions.length >= this.d.rules.maxOpen) {
        await this.writeStatus();
        return;
      }
      const tokens = Object.keys(this.s.watch).slice(-150);
      const pairs = bestPairs(await this.d.dex.pairsFor(tokens));
      const ranked: DexPair[] = [];
      for (const p of pairs.values()) {
        if (this.s.positions.some((x) => x.mint === p.baseToken.address)) continue;
        if (t - (this.s.cooldown[p.baseToken.address] ?? 0) < this.d.rules.cooldownMin * 60_000) continue;
        if (screen(p, this.d.rules, t) || entrySignal(p, this.d.rules)) continue;
        ranked.push(p);
      }
      this.s.stats.candidates += ranked.length;
      ranked.sort((a, b) => (b.volume?.m5 ?? 0) - (a.volume?.m5 ?? 0));
      for (const p of ranked.slice(0, 3)) {
        if (this.s.positions.length >= this.d.rules.maxOpen || this.paused()) break;
        await this.consider(p).catch((e: Error) => this.note({ mint: p.baseToken.address, symbol: p.baseToken.symbol, action: 'skip', reason: `error: ${e.message.slice(0, 80)}` }));
      }
      await this.persist();
      await this.writeStatus();
    } finally {
      this.busy = false;
    }
  }

  private async consider(p: DexPair): Promise<void> {
    const r = this.d.rules;
    const mint = p.baseToken.address;
    const sym = p.baseToken.symbol;
    const skip = (reason: string) => this.note({ mint, symbol: sym, action: 'skip', reason });

    // On-chain safety, cached 30 minutes per token.
    let verdict = this.safeCache.get(mint);
    if (!verdict || this.now() - verdict.atMs > 1_800_000) {
      const [m, largest] = await Promise.all([this.d.rpc.mint(mint), this.d.rpc.largestAccounts(mint).catch(() => [] as bigint[])]);
      verdict = { atMs: this.now(), verdict: safety(m, largest, p.liquidity?.base ?? 0, r) };
      this.safeCache.set(mint, verdict);
    }
    if (verdict.verdict) return skip(verdict.verdict);

    const size = tradeSize(this.equity(), this.s.cashUsd, p.liquidity?.usd ?? 0, r);
    if (!size) return skip('size_below_minimum');

    const buy = await this.d.jup.quote(USDC_MINT, mint, BigInt(Math.round(size * 1e6)));
    if (!buy) return skip('no_buy_route');
    const sell = await this.d.jup.quote(mint, USDC_MINT, BigInt(buy.outAmount));
    const why = roundTrip(size, sell ? Number(sell.outAmount) / 1e6 : null, Math.abs(Number(buy.priceImpactPct)) || 0, r); // Jupiter reports impact as a percentage string
    if (why) return skip(why);

    const ath = await this.d.gecko.allTimeHigh(p.pairAddress).catch(() => null);
    const m = await this.d.rpc.mint(mint);
    const decimals = m?.decimals ?? 6;
    const tokens = Number(buy.outAmount) / 10 ** decimals;
    const cost = size + this.d.swapCostUsd;
    const entry = size / tokens;
    const pos: Position = {
      id: `m_${randomUUID()}`,
      mint,
      symbol: sym,
      pair: p.pairAddress,
      openedMs: this.now(),
      costUsd: cost,
      tokensRaw: buy.outAmount,
      decimals,
      entryPrice: entry,
      peakPrice: entry,
      athAtEntry: ath,
      liquidityAtEntry: p.liquidity?.usd ?? 0,
      lastPrice: entry,
      lastValueUsd: size,
    };
    this.s.cashUsd -= cost;
    this.s.positions.push(pos);
    this.note({ mint, symbol: sym, action: 'open', reason: `momentum m5 +${(p.priceChange?.m5 ?? 0).toFixed(1)}%, ${p.txns?.m5?.buys ?? 0}/${p.txns?.m5?.sells ?? 0} buys/sells, ATH ${ath ? `$${ath.toPrecision(3)}` : 'n/a'}`, usd: cost });
  }

  /* ----------------------------------------------------------------------------------------- status */

  async writeStatus(): Promise<void> {
    const eq = this.equity();
    const status = {
      mode: 'PAPER',
      updatedAt: new Date(this.now()).toISOString(),
      paused: this.paused(),
      halted: this.s.halted,
      haltReason: this.s.haltReason,
      equityUsd: eq,
      startEquityUsd: this.d.startEquityUsd,
      cashUsd: this.s.cashUsd,
      day: this.s.day,
      dayStartEquityUsd: this.s.dayStartEquity,
      dayPnlUsd: eq - this.s.dayStartEquity,
      dayLossPct: dayLossPct(this.s.dayStartEquity, eq),
      stats: this.s.stats,
      watching: Object.keys(this.s.watch).length,
      positions: this.s.positions.map((p) => ({
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        pair: p.pair,
        openedAt: new Date(p.openedMs).toISOString(),
        costUsd: p.costUsd,
        valueUsd: p.lastValueUsd,
        pnlPct: ((p.lastValueUsd - p.costUsd) / p.costUsd) * 100,
        entryPrice: p.entryPrice,
        lastPrice: p.lastPrice,
        peakPrice: p.peakPrice,
        athAtEntry: p.athAtEntry,
      })),
      rules: this.d.rules,
      recent: this.recent.slice(0, 40),
    };
    const tmp = this.file(`meme-status.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(status, null, 2));
    await rename(tmp, this.file('meme-status.json'));
  }
}
