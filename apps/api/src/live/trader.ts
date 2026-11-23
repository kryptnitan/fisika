/**
 * LIVE arbitrage with the arb wallet's own capital.
 *
 * Each tick: the engine (LIVE mode) scans, re-quotes every leg and applies every risk limit, then returns
 * "ready" opportunities. The trader takes the best one and runs it leg by leg:
 *
 *   1. Before spending anything, re-quote the whole cycle again at the exact size. If it no longer clears the
 *      minimum edge after gas, stop. Nothing has been spent.
 *   2. Run each leg with an on-chain minimum output. A leg that fails for a retryable reason (no RFQ quote,
 *      expired quote, slippage revert) is re-quoted and retried up to 3 times.
 *   3. Once the first leg has filled, the cycle is always completed back to the start token, accepting up to the
 *      slippage limit per leg. Finishing is how the bot gets out of the intermediate token; stopping halfway would
 *      leave it holding cNGN or wBRL.
 *   4. If a later leg still cannot fill, the held token is sold straight back to the start token at the best live
 *      quote. If even that fails, the trader keeps retrying on its own (with backoff) and opens nothing new meanwhile.
 *   5. Profit or loss is what the last swap's receipt paid back minus what the first leg spent, minus gas. Never a
 *      balance read after the fact: a lagging public node once answered with the balance from before the last leg,
 *      booking every ~$100 loop as a ~$100 loss.
 *
 * Learning: every path (tokens + venues) keeps a record of how its fills compared with its quotes. A path whose fills
 * fall short has that shortfall taken off its next quotes, and a path that loses is benched for 2h, doubling per
 * loss in a row up to 48h. Loops that look good on paper but lose in practice stop being traded.
 *
 * Pause: the agent console's Active/Paused switch (control file, global + per chain) and the older KILL_FILE both
 * stop new cycles. The switch is read right before every cycle would spend anything; a cycle already under way is
 * finished, for the reason in step 3. A daily loss at or past the limit stops trading for the rest of that UTC day;
 * the next day it resumes by itself.
 *
 * Withdrawals queued by the console are sent at the start of a tick, which is always between cycles.
 */
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { erc20Abi, formatUnits, parseAbiItem, type Hex } from 'viem';
import { ArbEngine, RiskGate, type Address, type ArbConfig, type Edge, type Opportunity, type TextileAdapter, type TokenRegistry, type VenueAdapter, type VenueId } from '@fisika/core';
import type { GraphState } from '@fisika/core/setup';
import { balanceOf, executeLeg, LegError, receivedFromLogs, type Chain, type TxCost } from './legs.ts';
import { chainTrades, logEvent, readControlSync } from '../agent/control.ts';
import { listRequests, processWithdrawals } from '../agent/withdrawals.ts';

export interface LiveConfig extends Omit<ArbConfig, 'gasPriceWei' | 'nativeUsd'> {
  ledgerPath: string;
  statusPath: string;
  killFile: string;
  /** Keep at least this much of the gas token (CELO, BNB) for gas; below it the engine pauses. */
  minNativeForGas: bigint;
  /** Console switch file (global + per chain). Unset: no switch, only KILL_FILE (tests). */
  controlFile?: string;
  /** Agent activity log (pauses, deposits, withdrawals). */
  eventsFile?: string;
  /** Where the console drops withdrawal requests for this chain. Unset: withdrawals off. */
  withdrawDir?: string;
  /** The only address withdrawals can go to, from this process's own environment. */
  withdrawTo?: Address | null;
  /** Largest loss (bps of fair value) accepted when selling held tokens back automatically. Default 300 (3%). */
  maxRecoverLossBps?: number;
  /** Test hook: called after each leg fills. */
  afterLeg?: (legIndex: number) => void | Promise<void>;
}

export interface LedgerEntry {
  at: string;
  /** Chain key (celo, bsc). Missing on entries written before the agent console existed. */
  chain?: string;
  status: 'completed' | 'aborted_before_spend' | 'stuck' | 'unwound';
  path: string;
  venues: VenueId[];
  amountIn: string;
  /** What came back in the start token (atomic), on completed cycles. */
  amountOut?: string | null;
  startDecimals?: number;
  startToken: string;
  expectedNetBps: number;
  realizedStart: string | null;
  gasUsd: number;
  realizedUsd: number;
  txs: string[];
  note?: string;
  /** 2: realized P&L from swap receipts. Missing: older entries, repaired from the chain at startup. */
  pnlv?: number;
}

/** How one path (tokens + venues) has really filled compared with its quotes. */
export interface PathStat {
  trades: number;
  wins: number;
  lossStreak: number;
  /** Moving average of quoted net bps minus realized bps; positive means fills come in worse than quotes. */
  shortfallBps: number;
  coolUntilMs: number;
  lastAt: string;
}

const HOUR = 3_600_000;
const pathKey = (path: string, venues: readonly string[]) => `${path}|${venues.join(',')}`;

/** The configured sizes that fit, plus the cap itself, so a wallet sized for one full trade can make it. */
export function sizesUpTo(sizes: readonly number[], maxTrade: number): number[] {
  const cap = Math.floor(maxTrade);
  return [...new Set([...sizes.filter((x) => x <= maxTrade), ...(cap >= Math.min(...sizes) ? [cap] : [])])].sort((a, b) => a - b);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LiveTrader {
  private readonly chain: Chain;
  private readonly state: () => GraphState;
  private readonly tokens: TokenRegistry;
  private readonly adapters: ReadonlyMap<VenueId, VenueAdapter>;
  private readonly textile: TextileAdapter | null;
  readonly cfg: LiveConfig;
  risk: RiskGate | null = null;
  private engine: ArbEngine | null = null;
  busy = false;
  stopping = false;
  recent: LedgerEntry[] = [];
  lastSkip: Record<string, number> = {};
  stuck: string | null = null;
  /** Tokens other than the start token the wallet holds (a half-finished loop): symbol → raw amount. */
  stranded: { symbol: string; token: Address; amount: bigint }[] = [];
  private strandedCheckedMs = 0;
  /** Last known balance per token, so a rise that no trade, unwind or withdrawal explains is recorded as a deposit. */
  private baseline = new Map<string, bigint>();
  private baselineReady = false;
  /** Highest block any of our transactions mined in. */
  private lastBlock = 0n;
  /** Consecutive checks that saw tokens held: act only on two, never on a single (possibly stale) reading. */
  private strandedSeen = 0;
  private recoverAfterMs = 0;
  private recoverAttempts = 0;
  private lossHaltDay: string | null = null;
  paths = new Map<string, PathStat>();
  /** What the start token paid for tokens still held from unfinished loops (token → start atomic). */
  private basis = new Map<string, bigint>();

  constructor(chain: Chain, state: () => GraphState, tokens: TokenRegistry, adapters: ReadonlyMap<VenueId, VenueAdapter>, textile: TextileAdapter | null, cfg: LiveConfig) {
    this.chain = chain;
    this.state = state;
    this.tokens = tokens;
    this.adapters = adapters;
    this.textile = textile;
    this.cfg = cfg;
  }

  /** Restore today's realized P&L from the ledger so a restart never resets the daily loss limit. */
  async restore(nowMs = Date.now()): Promise<void> {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    let today = 0;
    await this.repairLedger().catch((e: Error) => console.error('[live] ledger repair failed:', e.message));
    try {
      const lines = (await readFile(this.cfg.ledgerPath, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerEntry);
      for (const l of lines) if (l.at.startsWith(day)) today += l.realizedUsd;
      this.recent = lines.slice(-50).reverse();
    } catch {
      /* no ledger yet */
    }
    try {
      const raw = JSON.parse(await readFile(this.statsPath, 'utf8')) as { paths?: Record<string, PathStat>; basis?: Record<string, string> };
      this.paths = new Map(Object.entries(raw.paths ?? {}));
      this.basis = new Map(Object.entries(raw.basis ?? {}).map(([k, v]) => [k, BigInt(v)]));
    } catch {
      /* first run */
    }
    this.pendingRestore = { day, today };
  }

  private get statsPath(): string {
    return `${this.dataDir}/path-stats.json`;
  }
  private async saveStats(): Promise<void> {
    const out = { paths: Object.fromEntries(this.paths), basis: Object.fromEntries([...this.basis].map(([k, v]) => [k, v.toString()])) };
    await writeFile(this.statsPath, JSON.stringify(out, null, 2)).catch(() => undefined);
  }

  /**
   * Ledger entries written before P&L came from receipts may have booked a loop's whole size as a loss (a lagging
   * node returned the balance from before the last leg). Recompute each from the last swap's receipt: what came back
   * in the start token minus what went in, minus gas. The old file is kept as ledger.jsonl.bak-<time>.
   */
  async repairLedger(): Promise<number> {
    if (!existsSync(this.cfg.ledgerPath)) return 0;
    const text = await readFile(this.cfg.ledgerPath, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerEntry);
    const start = this.cfg.startTokens[0]!;
    let fixed = 0;
    for (const l of lines) {
      if (l.status !== 'completed' || l.pnlv || !l.txs.length) continue;
      const r = await this.chain.pub.getTransactionReceipt({ hash: l.txs[l.txs.length - 1] as Hex }).catch(() => null);
      const out = r ? receivedFromLogs(r.logs, start, this.chain.account) : null;
      if (out === null) continue;
      const dec = l.startDecimals ?? this.tokens.decimals(start);
      const realizedStart = out - BigInt(l.amountIn);
      // Start tokens are dollar stablecoins: one unit is one dollar.
      const realizedUsd = Number(realizedStart) / 10 ** dec - l.gasUsd;
      if (Math.abs(realizedUsd - l.realizedUsd) > 0.0001) fixed++;
      Object.assign(l, { amountOut: out.toString(), realizedStart: realizedStart.toString(), realizedUsd, pnlv: 2 });
    }
    if (fixed) {
      await writeFile(`${this.cfg.ledgerPath}.bak-${Date.now()}`, text);
      await writeFile(this.cfg.ledgerPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      console.log(`[live] repaired the P&L of ${fixed} ledger entries from their receipts`);
    }
    return fixed;
  }
  private pendingRestore: { day: string; today: number } | null = null;

  killed(): boolean {
    return existsSync(this.cfg.killFile);
  }

  get chainKey(): string {
    return this.chain.config?.key ?? 'celo';
  }

  /** True when no new cycle may start: KILL file, or the console switch (global or this chain) is off. */
  paused(): boolean {
    if (this.killed()) return true;
    if (!this.cfg.controlFile) return false;
    return !chainTrades(readControlSync(this.cfg.controlFile), this.chainKey);
  }

  /** A cycle is between its first spend and its last leg. */
  inFlight = false;
  pendingWithdrawals = 0;

  private async withdrawals(): Promise<boolean> {
    if (!this.cfg.withdrawDir || !this.cfg.controlFile) return false;
    const pending = (await listRequests(this.cfg.withdrawDir).catch(() => [])).length;
    await processWithdrawals({
      chainKey: this.chainKey,
      pub: this.chain.pub as never,
      wallet: this.chain.wallet as never,
      account: this.chain.account,
      tokens: this.tokens,
      nativeSymbol: this.chain.config?.nativeSymbol ?? 'CELO',
      withdrawTo: this.cfg.withdrawTo ?? null,
      nativeReserve: this.cfg.minNativeForGas,
      dir: this.cfg.withdrawDir,
      controlFile: this.cfg.controlFile,
      eventsFile: this.cfg.eventsFile ?? `${this.cfg.withdrawDir}/../agent-events.jsonl`,
    }).catch((e: Error) => console.error('[withdraw] failed:', e.message));
    this.pendingWithdrawals = (await listRequests(this.cfg.withdrawDir)).filter((r) => r.status === 'requested').length;
    return pending > 0;
  }

  private get dataDir(): string {
    return dirname(this.cfg.ledgerPath);
  }
  private get eventsFile(): string {
    return this.cfg.eventsFile ?? `${this.dataDir}/agent-events.jsonl`;
  }

  /** Dust: below 0.01 of a token is residue from rounding, not a position. */
  private dust(token: Address): bigint {
    const d = this.tokens.get(token)?.decimals ?? 18;
    return 10n ** BigInt(Math.max(0, d - 2));
  }

  /**
   * A wallet holding anything but the start token is a loop that did not finish (or a crash, or a deposit of another
   * token). Balances are read all at one block, from a node that has seen our latest transaction, so a lagging node
   * cannot make a finished loop look unfinished. Nothing new starts while tokens are held; tick() sells them back.
   * Checked once a minute; it is a read per token.
   */
  async checkStranded(nowMs = Date.now()): Promise<void> {
    if (nowMs - this.strandedCheckedMs < 60_000) return;
    this.strandedCheckedMs = nowMs;
    const start = this.cfg.startTokens[0]!;
    const all = this.tokens.all();
    const bals = await this.consistentBalances(all.map((t) => t.address));
    if (!bals) return; // no consistent reading this time: decide nothing
    const held: typeof this.stranded = [];
    for (const t of all) {
      const bal = bals.get(t.address.toLowerCase());
      if (bal === undefined || t.address.toLowerCase() === start.toLowerCase()) continue;
      if (bal > this.dust(t.address)) held.push({ symbol: t.symbol, token: t.address, amount: bal });
    }
    this.stranded = held;
    this.strandedSeen = held.length ? this.strandedSeen + 1 : 0;
    await this.noteDeposits(bals);
    // Halts from the old "sell it back by hand" rule are lifted: recovery is automatic now.
    if (this.risk?.state.haltReason?.startsWith('holding ') || this.risk?.state.haltReason?.startsWith('stuck after')) {
      this.risk.state.halted = false;
      this.risk.state.haltReason = undefined;
    }
    if (!held.length) {
      this.stuck = null;
      this.recoverAttempts = 0;
      if (this.basis.size) {
        this.basis.clear();
        await this.saveStats();
      }
    } else {
      this.stuck = `holding ${held.map((h) => `${h.symbol} ${formatUnits(h.amount, this.tokens.get(h.token)?.decimals ?? 18)}`).join(', ')}; selling it back to ${this.sym(start)} automatically`;
    }
  }

  /** Every token balance read at one block that is at or past our latest transaction; null if no node obliges. */
  private async consistentBalances(tokens: Address[]): Promise<Map<string, bigint> | null> {
    for (let i = 0; i < 8; i++) {
      try {
        const head = await this.chain.pub.getBlockNumber();
        if (head < this.lastBlock) throw new Error('node behind our last transaction');
        const out = new Map<string, bigint>();
        for (const t of tokens) {
          out.set(t.toLowerCase(), await this.chain.pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [this.chain.account], blockNumber: head }));
        }
        return out;
      } catch {
        await sleep(1_500);
      }
    }
    return null;
  }

  private seen(txs: readonly TxCost[]): void {
    for (const t of txs) if (t.blockNumber && t.blockNumber > this.lastBlock) this.lastBlock = t.blockNumber;
  }

  /**
   * Money sent straight to the bot wallet (not through the console) lands in the history too: any token balance that
   * rose since the last look, with no trade, unwind or withdrawal in between to explain it, is a deposit. The transfer
   * is looked up in the last few hundred blocks so the record carries the sender and the tx hash.
   */
  private async noteDeposits(now: Map<string, bigint>): Promise<void> {
    if (!this.baselineReady) {
      this.baseline = now;
      this.baselineReady = true;
      return;
    }
    for (const [addr, bal] of now) {
      const before = this.baseline.get(addr) ?? 0n;
      if (bal <= before) continue;
      const t = this.tokens.get(addr as Address);
      if (!t || t.decimals === null || bal - before <= this.dust(addr as Address)) continue;
      const amount = formatUnits(bal - before, t.decimals);
      let txHash: Hex | undefined;
      let from: string | undefined;
      try {
        const head = await this.chain.pub.getBlockNumber();
        const logs = await this.chain.pub.getLogs({
          address: addr as Address,
          event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
          args: { to: this.chain.account },
          fromBlock: head > 600n ? head - 600n : 0n,
          toBlock: head,
        });
        const hit = logs[logs.length - 1];
        if (hit) {
          txHash = hit.transactionHash ?? undefined;
          from = hit.args.from;
        }
      } catch {
        /* the record still gets the amount */
      }
      await logEvent(this.eventsFile, { type: 'deposit', chain: this.chainKey, token: t.symbol, amount, txHash, by: 'direct transfer', note: from ? `from ${from.toLowerCase()}` : 'sent straight to the bot wallet' });
      console.log(`[live] deposit noticed: ${amount} ${t.symbol}${txHash ? ` (${txHash})` : ''}`);
    }
    this.baseline = now;
  }

  /** After anything the trader itself did to the balances, the next look must not mistake it for a deposit. */
  private resetBaseline(): void {
    this.baselineReady = false;
    this.strandedCheckedMs = 0;
  }

  /** Console requests dropped as files by the API (which never holds the key): clear the halt, or sell back held tokens. */
  private async requests(nowMs = Date.now()): Promise<void> {
    const clear = `${this.dataDir}/clear-halt.request`;
    if (existsSync(clear)) {
      const by = await readFile(clear, 'utf8').catch(() => 'console');
      await unlink(clear).catch(() => undefined);
      this.stuck = null;
      if (this.risk) {
        this.risk.state.halted = false;
        this.risk.state.haltReason = undefined;
      }
      this.strandedCheckedMs = 0; // re-check at once: if tokens are still held, the halt comes straight back
      await logEvent(this.eventsFile, { type: 'halt_cleared', chain: this.chainKey, by: by.trim() || 'console' });
      console.log('[live] halt cleared from the console');
    }
    const unwind = `${this.dataDir}/unwind.request`;
    if (existsSync(unwind)) {
      await unlink(unwind).catch(() => undefined);
      await this.unwind(nowMs);
    }
  }

  /** Sell every held non-start token back to the start token at the best live quote. Owner-triggered: no loss guard. */
  async unwind(nowMs = Date.now()): Promise<void> {
    this.strandedCheckedMs = 0;
    await this.checkStranded(nowMs);
    for (const h of this.stranded) await this.sellBack(h.token, h.amount, nowMs, { guard: false, why: 'owner asked' });
    this.strandedCheckedMs = 0;
    await this.checkStranded(nowMs);
  }

  /** Automatic recovery: sell held tokens back, retrying with backoff (2, 4, 8 … up to 30 minutes) while it fails. */
  async recoverStranded(nowMs = Date.now()): Promise<void> {
    if (nowMs < this.recoverAfterMs || !this.stranded.length) return;
    let allSold = true;
    for (const h of this.stranded) {
      const r = await this.sellBack(h.token, h.amount, nowMs, { guard: true, why: 'automatic recovery' });
      if (!r || r.sold < h.amount - this.dust(h.token)) allSold = false;
    }
    if (allSold) {
      this.recoverAttempts = 0;
      this.recoverAfterMs = 0;
    } else {
      this.recoverAttempts++;
      this.recoverAfterMs = nowMs + Math.min(30, 2 ** this.recoverAttempts) * 60_000;
    }
    this.strandedCheckedMs = 0;
    await this.checkStranded(nowMs);
  }

  /**
   * Sell `amount` of `token` for the start token on the venue quoting the most. With the guard on, a sale that would
   * fetch less than fair value minus maxRecoverLossBps is tried at half size, then a quarter, so a thin pool is
   * worked off in pieces rather than dumped. Logs an 'unwound' entry whose P&L is set against what the loop paid
   * for these tokens, when that is known. Returns what was sold and received, or null if nothing traded.
   */
  async sellBack(token: Address, amount: bigint, nowMs: number, opts: { guard: boolean; why: string; basisStart?: bigint; txs?: TxCost[] }): Promise<{ sold: bigint; out: bigint; txs: TxCost[] } | null> {
    const start = this.cfg.startTokens[0]!;
    const st = this.state();
    const symIn = this.sym(token);
    const edges = st.graph.between(token, start, nowMs, 10 * 60_000);
    const maxLoss = this.cfg.maxRecoverLossBps ?? 300;
    const base = { at: new Date(nowMs).toISOString(), chain: this.chainKey, path: `${symIn}→${this.sym(start)}`, amountOut: null as string | null, startDecimals: this.tokens.get(start)?.decimals ?? undefined, startToken: this.sym(start), expectedNetBps: 0, realizedStart: null as string | null, gasUsd: 0, realizedUsd: 0, pnlv: 2 };
    for (const size of opts.guard ? [amount, amount / 2n, amount / 4n] : [amount]) {
      if (size <= this.dust(token)) break;
      let best: { e: Edge; out: bigint } | null = null;
      for (const e of edges) {
        const ad = this.adapters.get(e.venue);
        const q = ad && (await ad.quote(token, start, size).catch(() => null));
        if (q && q.amountOut > 0n && (!best || q.amountOut > best.out)) best = { e, out: q.amountOut };
      }
      if (!best) {
        console.warn(`[live] recovery: no venue quotes ${symIn}→${this.sym(start)} right now`);
        return null;
      }
      if (opts.guard) {
        const fair = st.pricer.usdValue(token, size, nowMs);
        const got = st.pricer.usdValue(start, best.out, nowMs);
        if (fair !== null && got !== null && got < fair * (1 - maxLoss / 10_000)) {
          console.warn(`[live] recovery: selling ${symIn} at this size fetches $${got.toFixed(2)} for $${fair.toFixed(2)} of value; trying smaller`);
          continue;
        }
      }
      const minOut = (best.out * (10_000n - BigInt(this.cfg.slippageBps))) / 10_000n;
      const txs: TxCost[] = [];
      try {
        this.inFlight = true;
        const r = await executeLeg(this.chain, best.e, size, minOut, this.textile, Math.floor(nowMs / 1000) + 120);
        txs.push(...r.txs);
        this.seen(r.txs);
        const all = [...(opts.txs ?? []), ...txs];
        const gasUsd = all.reduce((a, t) => a + Number(t.gasUsed * t.effectiveGasPrice) / 1e18, 0) * st.nativeUsd;
        const key = token.toLowerCase();
        const paid = opts.basisStart ?? (this.basis.has(key) ? (this.basis.get(key)! * size) / (amount > 0n ? amount : 1n) : null);
        const dec = this.tokens.get(start)?.decimals ?? 6;
        const realizedStart = paid === null ? null : r.amountOut - paid;
        const realizedUsd = (realizedStart === null ? 0 : Number(realizedStart) / 10 ** dec) - gasUsd;
        if (paid !== null && opts.basisStart === undefined && this.basis.has(key)) {
          const left = this.basis.get(key)! - paid;
          if (left > 0n) this.basis.set(key, left);
          else this.basis.delete(key);
          await this.saveStats();
        }
        const e = await this.log({ ...base, status: 'unwound', venues: [best.e.venue], amountIn: size.toString(), amountOut: r.amountOut.toString(), realizedStart: realizedStart === null ? null : realizedStart.toString(), txs: all.map((t) => t.hash), gasUsd, realizedUsd, note: `${opts.why}: sold ${symIn} on ${best.e.venue}${paid === null ? ' (cost unknown: P&L is gas only)' : ''}` });
        this.risk?.record(e.realizedUsd, Date.now());
        await logEvent(this.eventsFile, { type: 'unwind', chain: this.chainKey, token: symIn, amount: size.toString(), txHash: txs[txs.length - 1]?.hash, by: opts.why });
        return { sold: size, out: r.amountOut, txs };
      } catch (err) {
        const sent = err instanceof LegError ? err.sent : [];
        this.seen(sent);
        console.warn(`[live] recovery: selling ${symIn} failed: ${(err as Error).message}`);
        if (sent.length) this.resetBaseline();
        return null;
      } finally {
        this.inFlight = false;
      }
    }
    return null;
  }

  async tick(nowMs = Date.now()): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      // Between trades by construction (busy): safe point to send queued withdrawals and act on console requests.
      if (await this.withdrawals()) this.resetBaseline();
      await this.requests(nowMs);
      await this.checkStranded(nowMs);
      if (this.paused()) {
        this.lastSkip = { paused: 1 };
        return;
      }
      const st = this.state();
      if (!st.updatedMs || st.rpc?.degraded) return;
      if (!st.nativeUsd) {
        // Gas cannot be priced, so profit cannot be measured: do not trade.
        this.lastSkip = { no_gas_token_price: 1 };
        return;
      }
      const cfg: ArbConfig = { ...this.cfg, gasPriceWei: st.gasPriceWei, nativeUsd: st.nativeUsd };
      if (!this.risk) {
        this.risk = new RiskGate(cfg, st.pricer, () => this.killed());
        if (this.pendingRestore) {
          this.risk.state = { dayKey: this.pendingRestore.day, realizedUsd: 0, halted: false };
          this.risk.record(this.pendingRestore.today, nowMs);
        }
      }
      this.autoResume(nowMs);
      // Holding something from an unfinished loop: get back to the start token before anything new. Two sightings
      // a minute apart first, so one odd reading never triggers a sale.
      if (this.stranded.length) {
        this.lastSkip = { recovering_held_tokens: 1 };
        if (this.strandedSeen >= 2) await this.recoverStranded(nowMs);
        return;
      }
      if (this.killed() || this.risk.state.halted) return;

      const native = await this.chain.pub.getBalance({ address: this.chain.account });
      if (native < this.cfg.minNativeForGas) {
        this.lastSkip = { [`low_${(this.chain.config?.nativeSymbol ?? 'CELO').toLowerCase()}_for_gas`]: 1 };
        return;
      }
      // Never size a trade above what the wallet actually holds of the start token.
      const start = this.cfg.startTokens[0]!;
      const bal = await balanceOf(this.chain, start);
      const balUsd = st.pricer.usdValue(start, bal, nowMs) ?? 0;
      const maxTrade = Math.min(this.cfg.maxTradeUsd, balUsd * 0.98);
      if (maxTrade < Math.min(...this.cfg.sizesUsd)) {
        this.lastSkip = { balance_below_smallest_size: 1 };
        return;
      }

      this.engine = new ArbEngine(st.graph, st.pricer, this.adapters, this.risk, { ...cfg, maxTradeUsd: maxTrade, sizesUsd: sizesUpTo(this.cfg.sizesUsd, maxTrade) }, 'LIVE');
      const decisions = await this.engine.tick(nowMs, 8);
      this.lastSkip = {};
      const skip = (r: string) => (this.lastSkip[r] = (this.lastSkip[r] ?? 0) + 1);
      for (const d of decisions) if (d.action === 'skipped') skip(d.reason ?? 'unknown');
      // Rank what passed every gate by its edge after this path's record: benched paths sit out, and a path whose
      // fills have come in short of its quotes needs that much more edge.
      let pick: { o: Opportunity; bps: number } | null = null;
      for (const d of decisions) {
        if (d.action !== 'ready') continue;
        const bps = this.adjustedBps(d.opportunity, nowMs);
        if (bps === null) skip('path_benched_after_loss');
        else if (bps < this.cfg.minEdgeBps) skip('edge_below_min_after_fill_record');
        else if (!pick || bps * d.opportunity.sizeUsd > pick.bps * pick.o.sizeUsd) pick = { o: d.opportunity, bps };
      }
      if (pick) await this.run(pick.o, st);
    } finally {
      this.busy = false;
      await this.writeStatus().catch(() => undefined);
    }
  }

  /** A daily-loss stop lasts for the UTC day it tripped on; the next day trading resumes by itself. */
  private autoResume(nowMs: number): void {
    const r = this.risk;
    if (!r?.state.halted || !r.state.haltReason?.startsWith('daily loss')) {
      this.lossHaltDay = null;
      return;
    }
    const today = new Date(nowMs).toISOString().slice(0, 10);
    this.lossHaltDay ??= today;
    if (today !== this.lossHaltDay) {
      r.state.halted = false;
      r.state.haltReason = undefined;
      this.lossHaltDay = null;
      void logEvent(this.eventsFile, { type: 'halt_cleared', chain: this.chainKey, by: 'automatic: new UTC day' });
      console.log('[live] daily loss stop lifted: new UTC day');
    }
  }

  /** Quoted net bps less this path's fill shortfall; null while the path is benched. */
  adjustedBps(o: Opportunity, nowMs: number): number | null {
    const s = this.paths.get(this.keyOf(o));
    if (!s) return o.netBps;
    if (s.coolUntilMs > nowMs) return null;
    return o.netBps - Math.max(0, s.shortfallBps);
  }

  private keyOf(o: Opportunity): string {
    return pathKey([o.start, ...o.cycle.map((e) => e.tokenOut)].map((t) => this.sym(t)).join('→'), o.cycle.map((e) => e.venue));
  }

  /** Book a finished loop against its path's record. */
  private async learn(o: Opportunity, e: LedgerEntry, nowMs = Date.now()): Promise<void> {
    const k = this.keyOf(o);
    const s = this.paths.get(k) ?? { trades: 0, wins: 0, lossStreak: 0, shortfallBps: 0, coolUntilMs: 0, lastAt: '' };
    const realizedBps = o.sizeUsd > 0 ? (e.realizedUsd / o.sizeUsd) * 10_000 : 0;
    const short = o.netBps - realizedBps;
    s.shortfallBps = s.trades ? 0.5 * s.shortfallBps + 0.5 * short : short;
    s.trades++;
    s.lastAt = e.at;
    if (e.realizedUsd > 0) {
      s.wins++;
      s.lossStreak = 0;
    } else {
      s.lossStreak++;
      s.coolUntilMs = nowMs + Math.min(48, 2 * 2 ** (s.lossStreak - 1)) * HOUR;
    }
    this.paths.set(k, s);
    await this.saveStats();
  }

  private sym(t: string) {
    return this.tokens.get(t)?.symbol ?? t.slice(0, 8);
  }

  /** Quote the rest of the cycle from leg i with amount a, through the live adapters. */
  private async projectFrom(cycle: Edge[], i: number, a: bigint): Promise<bigint | null> {
    let x = a;
    for (let j = i; j < cycle.length; j++) {
      const ad = this.adapters.get(cycle[j]!.venue);
      const q = ad && (await ad.quote(cycle[j]!.tokenIn, cycle[j]!.tokenOut, x).catch(() => null));
      if (!q || q.amountOut === 0n) return null;
      x = q.amountOut;
    }
    return x;
  }

  async run(o: Opportunity, st: GraphState): Promise<LedgerEntry> {
    const cycle = o.cycle;
    const start = o.start;
    const path = [start, ...cycle.map((e) => e.tokenOut)].map((t) => this.sym(t)).join('→');
    const txs: TxCost[] = [];
    const slip = BigInt(this.cfg.slippageBps);
    const minEdge = (o.amountIn * BigInt(Math.ceil(this.cfg.minEdgeBps))) / 10_000n;
    const startBal = await balanceOf(this.chain, start);
    const entry = (status: LedgerEntry['status'], realizedStart: bigint | null, note?: string): LedgerEntry => {
      const gasNative = txs.reduce((s, t) => s + t.gasUsed * t.effectiveGasPrice, 0n);
      const gasUsd = (Number(gasNative) / 1e18) * st.nativeUsd;
      const startUsd = realizedStart === null ? 0 : (st.pricer.usdValue(start, realizedStart < 0n ? -realizedStart : realizedStart, Date.now()) ?? 0) * (realizedStart < 0n ? -1 : 1);
      return {
        at: new Date().toISOString(),
        chain: this.chainKey,
        status,
        path,
        venues: cycle.map((e) => e.venue),
        amountIn: o.amountIn.toString(),
        amountOut: status === 'completed' && realizedStart !== null ? (o.amountIn + realizedStart).toString() : null,
        startDecimals: this.tokens.get(start)?.decimals ?? undefined,
        startToken: this.sym(start),
        expectedNetBps: o.netBps,
        realizedStart: realizedStart === null ? null : realizedStart.toString(),
        gasUsd,
        realizedUsd: startUsd - gasUsd,
        txs: txs.map((t) => t.hash),
        note,
        pnlv: 2,
      };
    };

    // 0. The console switch, right before anything could be submitted. Not logged: nothing was attempted.
    if (this.paused()) return entry('aborted_before_spend', null, 'paused');

    // 1. Final check before spending anything.
    const projected = await this.projectFrom(cycle, 0, o.amountIn);
    if (projected === null || projected < o.amountIn + o.gasInStart + minEdge) {
      return this.log(entry('aborted_before_spend', null, projected === null ? 'a leg could not be quoted' : 'edge gone on final check'));
    }

    // 2–3. Run every leg; once the first one fills, finish the cycle (even if paused meanwhile).
    this.inFlight = true;
    void this.writeStatus().catch(() => undefined);
    try {
      return await this.legs(o, st, cycle, start, slip, txs, entry, startBal);
    } finally {
      this.inFlight = false;
    }
  }

  private async legs(
    o: Opportunity,
    st: GraphState,
    cycle: Edge[],
    start: Address,
    slip: bigint,
    txs: TxCost[],
    entry: (status: LedgerEntry['status'], realizedStart: bigint | null, note?: string) => LedgerEntry,
    startBal: bigint,
  ): Promise<LedgerEntry> {
    let amount = o.amountIn;
    for (let i = 0; i < cycle.length; i++) {
      const e = cycle[i]!;
      let done = false;
      let sentAny = false;
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        const ad = this.adapters.get(e.venue);
        const q = ad && (await ad.quote(e.tokenIn, e.tokenOut, amount).catch(() => null));
        if (!q) {
          if (i === 0 && !sentAny) return this.log(entry('aborted_before_spend', null, `leg 1 (${e.venue}) could not be quoted`));
          await sleep(2_000);
          continue;
        }
        const minOut = (q.amountOut * (10_000n - slip)) / 10_000n;
        const inBefore = await balanceOf(this.chain, e.tokenIn);
        const outBefore = await balanceOf(this.chain, e.tokenOut);
        try {
          const r = await executeLeg(this.chain, e, amount, minOut, this.textile, Math.floor(Date.now() / 1000) + 120);
          txs.push(...r.txs);
          this.seen(r.txs);
          amount = r.amountOut;
          done = true;
          await this.cfg.afterLeg?.(i);
        } catch (err) {
          const sent = err instanceof LegError ? err.sent : [];
          this.seen(sent);
          for (const t of sent) if (!txs.some((x) => x.hash === t.hash)) txs.push(t);
          const cost = (err as { cost?: TxCost }).cost;
          if (cost && !txs.some((x) => x.hash === cost.hash)) txs.push(cost);
          if (sent.length > 0) {
            sentAny = true;
            // Something was broadcast. The chain, not the error message, says whether the leg filled.
            const fill = await this.reconcile(e, amount, inBefore, outBefore);
            if (fill === 'filled') {
              const got = (await balanceOf(this.chain, e.tokenOut)) - outBefore;
              amount = got;
              done = true;
              console.warn(`[live] leg ${i + 1} reported "${(err as Error).message}" but the chain shows it filled (received ${got}); continuing`);
              await this.cfg.afterLeg?.(i);
              continue;
            }
            if (fill === 'unknown') break; // a transaction may still mine: never retry on top of it
            // 'not_filled': the transaction reverted or never mined; fall through to the retry rules
          }
          const retry = err instanceof LegError && err.retryable;
          if (i === 0 && !sentAny && (!retry || attempt === 3)) return this.log(entry('aborted_before_spend', null, `leg 1 failed: ${(err as Error).message}`));
          if (!retry) break;
          await sleep(2_000);
        }
      }
      if (!done) {
        // 4. Leg i+1 could not fill. From leg 2 on we hold `amount` of its input: sell it straight back.
        if (i > 0 && e.tokenIn.toLowerCase() !== start.toLowerCase()) {
          const back = await this.sellBack(e.tokenIn, amount, Date.now(), { guard: false, why: `loop could not finish leg ${i + 1}`, basisStart: o.amountIn, txs });
          if (back) {
            this.strandedCheckedMs = 0; // confirm nothing is left
            // sellBack logged the loop as 'unwound', its P&L set against what leg 1 spent and all the loop's gas.
            const logged = this.recent[0]!;
            await this.learn(o, logged);
            return logged;
          }
        }
        // Could not sell back right now (or unsure what leg 1 did): remember what it cost; tick() keeps retrying.
        const heldToken = i > 0 ? e.tokenIn : e.tokenOut;
        if (heldToken.toLowerCase() !== start.toLowerCase()) {
          this.basis.set(heldToken.toLowerCase(), (this.basis.get(heldToken.toLowerCase()) ?? 0n) + o.amountIn);
          await this.saveStats();
        }
        this.strandedCheckedMs = 0;
        const note = `stopped at leg ${i + 1}; whatever is held is sold back to ${this.sym(start)} automatically`;
        const s = await this.log(entry('stuck', null, note));
        this.risk?.record(s.realizedUsd, Date.now());
        return s;
      }
    }

    // 5. Realized P&L: what the last swap's receipt paid back in the start token minus what the first leg spent.
    void startBal;
    const e = entry('completed', amount - o.amountIn);
    this.risk?.record(e.realizedUsd, Date.now());
    await this.learn(o, e);
    return this.log(e);
  }

  /**
   * Did a leg whose transaction was broadcast actually fill? Read the wallet (retrying past lagging nodes):
   * input spent and output received → filled; input untouched after the wait → not filled; anything else → unknown.
   */
  private async reconcile(e: Edge, amountIn: bigint, inBefore: bigint, outBefore: bigint): Promise<'filled' | 'not_filled' | 'unknown'> {
    for (let i = 0; i < 12; i++) {
      const [inNow, outNow] = await Promise.all([balanceOf(this.chain, e.tokenIn).catch(() => null), balanceOf(this.chain, e.tokenOut).catch(() => null)]);
      if (inNow !== null && outNow !== null) {
        const spent = inBefore - inNow;
        if (spent >= (amountIn * 99n) / 100n && outNow > outBefore) return 'filled';
      }
      await sleep(2_500);
    }
    const inNow = await balanceOf(this.chain, e.tokenIn).catch(() => null);
    if (inNow !== null && inNow >= inBefore) return 'not_filled';
    return 'unknown';
  }

  private async log(e: LedgerEntry): Promise<LedgerEntry> {
    if (e.status !== 'aborted_before_spend') this.resetBaseline(); // balances moved by our own hand
    this.recent.unshift(e);
    if (this.recent.length > 50) this.recent.length = 50;
    await appendFile(this.cfg.ledgerPath, `${JSON.stringify(e)}\n`);
    console.log(`[live] ${e.status} ${e.path} ${e.venues.join(',')} realized $${e.realizedUsd.toFixed(4)}${e.note ? ` · ${e.note}` : ''}`);
    return e;
  }

  async writeStatus(): Promise<void> {
    const st = this.state();
    const start = this.cfg.startTokens[0]!;
    const [bal, native] = await Promise.all([balanceOf(this.chain, start).catch(() => null), this.chain.pub.getBalance({ address: this.chain.account }).catch(() => null)]);
    const completed = this.recent.filter((r) => r.status === 'completed');
    const status = {
      mode: 'LIVE',
      chain: this.chainKey,
      wallet: this.chain.account,
      paused: this.paused(),
      inFlight: this.inFlight,
      pendingWithdrawals: this.pendingWithdrawals,
      updatedAt: new Date().toISOString(),
      killed: this.killed(),
      stranded: this.stranded.map((h) => ({ symbol: h.symbol, amount: formatUnits(h.amount, this.tokens.get(h.token)?.decimals ?? 18) })),
      halted: this.risk?.state.halted ?? false,
      haltReason: this.risk?.state.haltReason ?? null,
      todayUsd: this.risk?.state.realizedUsd ?? 0,
      balances: { [this.sym(start)]: bal === null ? null : Number(bal) / 10 ** this.tokens.decimals(start), [this.chain.config?.nativeSymbol ?? 'CELO']: native === null ? null : Number(native) / 1e18 },
      trades: completed.length,
      wins: completed.filter((r) => r.realizedUsd > 0).length,
      realizedUsd: completed.reduce((s, r) => s + r.realizedUsd, 0),
      lastSkip: this.lastSkip,
      recovering: this.stranded.length > 0,
      benched: [...this.paths].filter(([, p]) => p.coolUntilMs > Date.now()).map(([k, p]) => ({ path: k, until: new Date(p.coolUntilMs).toISOString(), trades: p.trades, wins: p.wins })),
      limits: { maxTradeUsd: this.cfg.maxTradeUsd, minEdgeBps: this.cfg.minEdgeBps, minEdgeUsd: this.cfg.minEdgeUsd, dailyLossLimitUsd: this.cfg.dailyLossLimitUsd, maxTokenExposureUsd: this.cfg.maxTokenExposureUsd, slippageBps: this.cfg.slippageBps },
      recent: this.recent.slice(0, 30),
      graphAgeMs: st.updatedMs ? Date.now() - st.updatedMs : null,
    };
    await writeFile(this.cfg.statusPath, JSON.stringify(status, null, 2));
  }
}

export type { Address };
