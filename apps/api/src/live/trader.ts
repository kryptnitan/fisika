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
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ArbEngine, RiskGate, type Address, type ArbConfig, type Edge, type Opportunity, type TextileAdapter, type TokenRegistry, type VenueAdapter, type VenueId } from '@fisika/core';
import type { GraphState } from '@fisika/core/setup';
import { balanceOf, executeLeg, LegError, type Chain, type TxCost } from './legs.ts';
import { chainTrades, readControlSync } from '../agent/control.ts';
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
  status: 'completed' | 'aborted_before_spend' | 'stuck';
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

  private async withdrawals(): Promise<void> {
    if (!this.cfg.withdrawDir || !this.cfg.controlFile) return;
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

  async tick(nowMs = Date.now()): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      // Between trades by construction (busy): safe point to send queued withdrawals.
      await this.withdrawals();
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
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        const ad = this.adapters.get(e.venue);
        const q = ad && (await ad.quote(e.tokenIn, e.tokenOut, amount).catch(() => null));
        if (!q) {
          if (i === 0) return this.log(entry('aborted_before_spend', null, `leg 1 (${e.venue}) could not be quoted`));
          await sleep(2_000);
          continue;
        }
        const minOut = (q.amountOut * (10_000n - slip)) / 10_000n;
        try {
          const r = await executeLeg(this.chain, e, amount, minOut, this.textile, Math.floor(Date.now() / 1000) + 120);
          txs.push(...r.txs);
          amount = r.amountOut;
          done = true;
          await this.cfg.afterLeg?.(i);
        } catch (err) {
          const cost = (err as { cost?: TxCost }).cost;
          if (cost) txs.push(cost);
          const retry = err instanceof LegError && err.retryable;
          if (i === 0 && (!retry || attempt === 3)) return this.log(entry('aborted_before_spend', null, `leg 1 failed: ${(err as Error).message}`));
          if (!retry) break;
          await sleep(2_000);
        }
      }
      if (!done) {
        // 4. Stuck holding an intermediate token: halt and say exactly what is held.
        const held = await balanceOf(this.chain, e.tokenIn);
        const note = `stuck after leg ${i}: holding ${held} (atomic) ${this.sym(e.tokenIn)}; sell it back to ${this.sym(start)} manually, then clear the halt`;
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

  private async log(e: LedgerEntry): Promise<LedgerEntry> {
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
