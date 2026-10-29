import { ArbEngine, RiskGate, type ArbConfig, type ArbDecision, type TokenRegistry, type VenueAdapter, type VenueId } from '@fisika/core';
import type { GraphState } from '@fisika/core/setup';

/**
 * PAPER-mode arbitrage loop for the dashboard: scan the shared graph, confirm with live re-quotes, risk-gate and
 * paper-fill. Nothing is signed here. LIVE execution belongs in its own process holding only the arb wallet key,
 * so the API process never holds trading keys.
 */
export interface ArbEvent {
  atMs: number;
  action: ArbDecision['action'];
  reason?: string;
  path: string;
  venues: string[];
  sizeUsd: number;
  netBps: number;
  netUsd: number;
  txCount: number;
  indicativeLegs: number;
}

export class PaperArbRunner {
  readonly events: ArbEvent[] = [];
  readonly equity: { atMs: number; equityUsd: number; baselineUsd: number }[] = [];
  detected = 0;
  filled = 0;
  wins = 0;
  realizedUsd = 0;
  killed = false;
  private engine: ArbEngine | null = null;
  /** Opportunities already paper-filled at their current prices; shared across ticks and (via export/import) sessions. */
  consumed = new Map<string, number>();
  private readonly startCapitalUsd: number;
  private readonly state: () => GraphState;
  private readonly tokens: TokenRegistry;
  private readonly adapters: ReadonlyMap<VenueId, VenueAdapter>;
  private readonly baseCfg: Omit<ArbConfig, 'gasPriceWei' | 'celoUsd'>;
  private busy = false;

  constructor(state: () => GraphState, tokens: TokenRegistry, adapters: ReadonlyMap<VenueId, VenueAdapter>, baseCfg: Omit<ArbConfig, 'gasPriceWei' | 'celoUsd'>, startCapitalUsd = 1_000) {
    this.state = state;
    this.tokens = tokens;
    this.adapters = adapters;
    this.baseCfg = baseCfg;
    this.startCapitalUsd = startCapitalUsd;
  }

  async tick(nowMs = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const st = this.state();
      if (!st.updatedMs) return;
      const cfg: ArbConfig = { ...this.baseCfg, gasPriceWei: st.gasPriceWei, celoUsd: st.celoUsd || 0.08 };
      const risk = this.engine?.risk ?? new RiskGate(cfg, st.pricer, () => this.killed);
      this.engine = new ArbEngine(st.graph, st.pricer, this.adapters, risk, cfg, 'PAPER');
      this.engine.consumed = this.consumed;
      const decisions = await this.engine.tick(nowMs);
      for (const d of decisions) {
        const o = d.opportunity;
        if (d.reason === 'already_filled_prices_unchanged') continue; // not a new opportunity; keep the log readable
        this.detected += 1;

        const path = [o.cycle[0]!.tokenIn, ...o.cycle.map((e) => e.tokenOut)].map((t) => this.tokens.get(t)?.symbol ?? t.slice(0, 8)).join('→');
        this.events.unshift({ atMs: nowMs, action: d.action, reason: d.reason, path, venues: o.cycle.map((e) => e.venue), sizeUsd: o.sizeUsd, netBps: o.netBps, netUsd: o.netUsd, txCount: o.txCount, indicativeLegs: o.indicativeLegs });
        if (d.action === 'filled' && d.fill) {
          this.filled += 1;
          if (d.fill.realizedUsd > 0) this.wins += 1;
          this.realizedUsd += d.fill.realizedUsd;
        }
      }
      if (this.events.length > 500) this.events.length = 500;

      const last = this.equity.at(-1);
      if (!last || nowMs - last.atMs >= 60_000 || decisions.some((d) => d.action === 'filled')) {
        this.equity.push({ atMs: nowMs, equityUsd: this.startCapitalUsd + this.realizedUsd, baselineUsd: this.startCapitalUsd });
        if (this.equity.length > 2_000) this.equity.shift();
      }
    } finally {
      this.busy = false;
    }
  }

  status() {
    return {
      mode: 'PAPER',
      killed: this.killed,
      halted: this.engine?.risk.state.halted ?? false,
      haltReason: this.engine?.risk.state.haltReason ?? null,
      detected: this.detected,
      filled: this.filled,
      winRate: this.filled ? this.wins / this.filled : null,
      realizedUsd: this.realizedUsd,
      todayUsd: this.engine?.risk.state.realizedUsd ?? 0,
      limits: {
        maxTradeUsd: this.baseCfg.maxTradeUsd,
        minEdgeBps: this.baseCfg.minEdgeBps,
        minEdgeUsd: this.baseCfg.minEdgeUsd,
        dailyLossLimitUsd: this.baseCfg.dailyLossLimitUsd,
        maxTokenExposureUsd: this.baseCfg.maxTokenExposureUsd,
      },
      events: this.events.slice(0, 100),
      equity: this.equity,
    };
  }

  clearHalt(): void {
    this.engine?.risk.clearHalt();
  }
}
