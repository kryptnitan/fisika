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
 *   4. If a later leg still cannot fill, the engine halts and the status says which token it is holding.
 *   5. Profit or loss is measured from the wallet's real balance of the start token before and after, minus gas.
 *
 * Pause: the agent console's Active/Paused switch (control file, global + per chain) and the older KILL_FILE both
 * stop new cycles. The switch is read right before every cycle would spend anything; a cycle already under way is
 * finished, for the reason in step 3. A daily loss at or past the limit halts the engine until a person clears it.
 *
 * Withdrawals queued by the console are sent at the start of a tick, which is always between cycles.
 */
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatUnits, parseAbiItem } from 'viem';
import { ArbEngine, RiskGate, type Address, type ArbConfig, type Edge, type Opportunity, type TextileAdapter, type TokenRegistry, type VenueAdapter, type VenueId } from '@fisika/core';
import type { GraphState } from '@fisika/core/setup';
import { balanceOf, executeLeg, LegError, type Chain, type TxCost } from './legs.ts';
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
}

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
    try {
      const lines = (await readFile(this.cfg.ledgerPath, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerEntry);
      for (const l of lines) if (l.at.startsWith(day)) today += l.realizedUsd;
      this.recent = lines.slice(-50).reverse();
      const lastStuck = lines.reverse().find((l) => l.status === 'stuck');
      if (lastStuck && lastStuck.at.startsWith(day)) this.stuck = lastStuck.note ?? 'stuck';
    } catch {
      /* no ledger yet */
    }
    this.pendingRestore = { day, today };
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
   * A wallet holding anything but the start token is a loop that did not finish. Found at startup, after a crash,
   * or after the RPC lied about a fill: halt and say exactly what is held, so nothing new starts on top of it.
   * Checked once a minute; it is a read per token.
   */
  async checkStranded(nowMs = Date.now()): Promise<void> {
    if (nowMs - this.strandedCheckedMs < 60_000) return;
    this.strandedCheckedMs = nowMs;
    const start = this.cfg.startTokens[0]!;
    const held: typeof this.stranded = [];
    const now = new Map<string, bigint>();
    for (const t of this.tokens.all()) {
      const bal = await balanceOf(this.chain, t.address).catch(() => null);
      if (bal === null) continue;
      now.set(t.address.toLowerCase(), bal);
      if (t.address.toLowerCase() === start.toLowerCase()) continue;
      if (bal > this.dust(t.address)) held.push({ symbol: t.symbol, token: t.address, amount: bal });
    }
    this.stranded = held;
    await this.noteDeposits(now);
    if (held.length && !this.stuck) {
      const note = `holding ${held.map((h) => `${h.symbol} ${formatUnits(h.amount, this.tokens.get(h.token)?.decimals ?? 18)}`).join(', ')} from an unfinished loop; sell it back to ${this.sym(start)} (console: Sell back) then clear the halt`;
      this.stuck = note;
      if (this.risk) {
        this.risk.state.halted = true;
        this.risk.state.haltReason = note;
      }
      console.error(`[live] ${note}`);
    }
    if (!held.length && this.stuck?.startsWith('holding ')) this.stuck = null;
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
      if (!t || bal - before <= this.dust(addr as Address)) continue;
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

  /** Sell every held non-start token back to the start token at the best live quote. Owner-triggered. */
  async unwind(nowMs = Date.now()): Promise<void> {
    this.strandedCheckedMs = 0;
    await this.checkStranded(nowMs);
    const start = this.cfg.startTokens[0]!;
    const st = this.state();
    for (const h of this.stranded) {
      const edges = st.graph.between(h.token, start, nowMs, 10 * 60_000);
      let best: { e: Edge; out: bigint } | null = null;
      for (const e of edges) {
        const ad = this.adapters.get(e.venue);
        const q = ad && (await ad.quote(h.token, start, h.amount).catch(() => null));
        if (q && q.amountOut > 0n && (!best || q.amountOut > best.out)) best = { e, out: q.amountOut };
      }
      const txs: TxCost[] = [];
      const base = { at: new Date(nowMs).toISOString(), chain: this.chainKey, path: `${h.symbol}→${this.sym(start)}`, amountIn: h.amount.toString(), amountOut: null as string | null, startDecimals: this.tokens.get(start)?.decimals ?? undefined, startToken: this.sym(start), expectedNetBps: 0, realizedStart: null as string | null, gasUsd: 0, realizedUsd: 0 };
      if (!best) {
        await this.log({ ...base, status: 'stuck', venues: [], txs: [], note: `unwind: no venue quotes ${h.symbol}→${this.sym(start)} right now` });
        continue;
      }
      const minOut = (best.out * (10_000n - BigInt(this.cfg.slippageBps))) / 10_000n;
      try {
        this.inFlight = true;
        const r = await executeLeg(this.chain, best.e, h.amount, minOut, this.textile, Math.floor(nowMs / 1000) + 120);
        txs.push(...r.txs);
        const gasUsd = txs.reduce((a, t) => a + Number(t.gasUsed * t.effectiveGasPrice) / 1e18, 0) * st.nativeUsd;
        await this.log({ ...base, status: 'unwound', venues: [best.e.venue], amountOut: r.amountOut.toString(), txs: txs.map((t) => t.hash), gasUsd, realizedUsd: -gasUsd, note: `sold back ${h.symbol} on ${best.e.venue}` });
        await logEvent(this.eventsFile, { type: 'unwind', chain: this.chainKey, token: h.symbol, amount: h.amount.toString(), txHash: txs[txs.length - 1]?.hash });
      } catch (err) {
        const sent = err instanceof LegError ? err.sent : [];
        await this.log({ ...base, status: 'stuck', venues: [best.e.venue], txs: sent.map((t) => t.hash), note: `unwind failed: ${(err as Error).message}` });
      } finally {
        this.inFlight = false;
      }
    }
    this.strandedCheckedMs = 0;
    await this.checkStranded(nowMs);
    if (!this.stranded.length) {
      this.stuck = null;
      if (this.risk && this.risk.state.haltReason?.startsWith('holding ')) {
        this.risk.state.halted = false;
        this.risk.state.haltReason = undefined;
      }
    }
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
          this.risk.state = { dayKey: this.pendingRestore.day, realizedUsd: 0, halted: !!this.stuck, haltReason: this.stuck ?? undefined };
          this.risk.record(this.pendingRestore.today, nowMs);
        }
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
      const decisions = await this.engine.tick(nowMs);
      this.lastSkip = {};
      for (const d of decisions) if (d.action === 'skipped') this.lastSkip[d.reason ?? 'unknown'] = (this.lastSkip[d.reason ?? 'unknown'] ?? 0) + 1;
      const ready = decisions.find((d) => d.action === 'ready');
      if (ready) await this.run(ready.opportunity, st);
    } finally {
      this.busy = false;
      await this.writeStatus().catch(() => undefined);
    }
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
          amount = r.amountOut;
          done = true;
          await this.cfg.afterLeg?.(i);
        } catch (err) {
          const sent = err instanceof LegError ? err.sent : [];
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
        // 4. Stuck holding an intermediate token (or unsure): halt and say exactly what is held.
        const held = await balanceOf(this.chain, e.tokenIn);
        const note = `stuck after leg ${i}: holding ${held} (atomic) ${this.sym(e.tokenIn)}; sell it back to ${this.sym(start)} (console: Sell back), then clear the halt`;
        this.stuck = note;
        if (this.risk) {
          this.risk.state.halted = true;
          this.risk.state.haltReason = note;
        }
        return this.log(entry('stuck', null, note));
      }
    }

    // 5. Realized P&L from the wallet's real balance.
    const endBal = await balanceOf(this.chain, start);
    const e = entry('completed', endBal - startBal);
    this.risk?.record(e.realizedUsd, Date.now());
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
      limits: { maxTradeUsd: this.cfg.maxTradeUsd, minEdgeBps: this.cfg.minEdgeBps, minEdgeUsd: this.cfg.minEdgeUsd, dailyLossLimitUsd: this.cfg.dailyLossLimitUsd, maxTokenExposureUsd: this.cfg.maxTokenExposureUsd, slippageBps: this.cfg.slippageBps },
      recent: this.recent.slice(0, 30),
      graphAgeMs: st.updatedMs ? Date.now() - st.updatedMs : null,
    };
    await writeFile(this.cfg.statusPath, JSON.stringify(status, null, 2));
  }
}

export type { Address };
