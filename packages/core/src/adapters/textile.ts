import { TEXTILE } from '../addresses.ts';
import { curveOut } from '../curve.ts';
import type { Address, Edge, EdgeContext, Quote, VenueAdapter } from '../types.ts';

/**
 * Textile FX RFQ adapter (docs.textilecredit.com/api/v2).
 *
 * - The graph is fed ONLY from the public ladder GET /v2/rfq/levels (no key, ~2 s cache). Those edges are
 *   indicative (firm: false). A firm quote locks maker inventory, so it is requested only at execution time.
 * - firmQuote() calls POST /v2/rfq/request. Without an aggregator key the taker must be an EOA that already
 *   holds the sell token, and we may hold at most 4 live firm quotes (enforced by RfqSlots).
 */

export interface TextileLevelsPair {
  sellToken: string;
  buyToken: string;
  sellDecimals: number;
  buyDecimals: number;
  minSellAmount: string;
  maxSellAmount: string;
  levels: { sellAmount: string; buyAmount: string }[];
}

export interface TextileConfig {
  chainId?: number;
  baseUrl?: string;
  /** tx_live_… partner key. Required for firmQuote in this codebase (we never sign keyless TakerControl proofs server-side). */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Gas for executing the reactor's executeBatch; placeholder until measured on a fork. */
  gasEstimate?: bigint;
}

export type FirmQuoteResult =
  | {
      status: 'quoted';
      rfqId: string;
      claimToken: string;
      takerPays: bigint;
      buyAmount: bigint;
      feeAmount: bigint;
      expiresAt: number;
      orderDeadline: number;
      latestOrderDeadline: number;
      spender: Address;
      approval: { to: Address; data: `0x${string}`; value: bigint };
      swap: { to: Address; data: `0x${string}`; value: bigint };
    }
  | { status: 'no_quote'; reason: string; availableSellAmount?: bigint; retryAfterMs?: number };

/** Outstanding firm-RFQ accounting. In-memory here; the services use a Redis implementation with the same contract. */
export interface RfqSlots {
  tryAcquire(nowMs: number): boolean;
  /** Bind the acquired slot to a quote until its latest order deadline. */
  hold(untilMs: number): void;
  release(): void;
  inUse(nowMs: number): number;
}

export class MemoryRfqSlots implements RfqSlots {
  private held: number[] = [];
  private pending = 0;
  private readonly cap: number;
  constructor(cap = 4) {
    this.cap = cap;
  }
  inUse(nowMs: number): number {
    this.held = this.held.filter((t) => t > nowMs);
    return this.held.length + this.pending;
  }
  tryAcquire(nowMs: number): boolean {
    if (this.inUse(nowMs) >= this.cap) return false;
    this.pending += 1;
    return true;
  }
  hold(untilMs: number): void {
    this.pending = Math.max(0, this.pending - 1);
    this.held.push(untilMs);
  }
  release(): void {
    this.pending = Math.max(0, this.pending - 1);
  }
}

export class TextileAdapter implements VenueAdapter {
  readonly id = 'textile' as const;
  private readonly chainId: number;
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly gas: bigint;
  private lastEdges: Edge[] = [];
  private readonly cfg: TextileConfig;
  private readonly slots: RfqSlots;

  constructor(cfg: TextileConfig = {}, slots: RfqSlots = new MemoryRfqSlots(4)) {
    this.cfg = cfg;
    this.slots = slots;
    this.chainId = cfg.chainId ?? 42220;
    this.base = cfg.baseUrl ?? TEXTILE.apiBase;
    this.f = cfg.fetchImpl ?? fetch;
    this.gas = cfg.gasEstimate ?? 250_000n;
  }

  async levels(): Promise<TextileLevelsPair[]> {
    const res = await this.f(`${this.base}/v2/rfq/levels?chainId=${this.chainId}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`textile levels HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { chainId?: number; pairs?: TextileLevelsPair[] } };
    if (body.data?.chainId !== undefined && body.data.chainId !== this.chainId) throw new Error('textile levels: wrong chain');
    return body.data?.pairs ?? [];
  }

  async fetchEdges(ctx: EdgeContext): Promise<Edge[]> {
    const pairs = await this.levels();
    const edges: Edge[] = [];
    for (const p of pairs) {
      if (BigInt(p.maxSellAmount) === 0n || !p.levels.length) continue;
      edges.push({
        venue: this.id,
        poolId: 'textile-rfq',
        tokenIn: p.sellToken.toLowerCase() as Address,
        tokenOut: p.buyToken.toLowerCase() as Address,
        // Levels are exact-input points with Textile's fee already in them.
        points: p.levels.map((l) => ({ amountIn: BigInt(l.sellAmount), amountOut: BigInt(l.buyAmount) })),
        gasUnits: this.gas,
        feeBps: TEXTILE.takerFeeBps,
        firm: false,
        asOfMs: ctx.nowMs,
        meta: { minSellAmount: p.minSellAmount, maxSellAmount: p.maxSellAmount },
      });
    }
    this.lastEdges = edges;
    return edges;
  }

  /** Indicative quote from the most recent ladder. Never firm. */
  async quote(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote | null> {
    const i = tokenIn.toLowerCase();
    const o = tokenOut.toLowerCase();
    const e = this.lastEdges.find((x) => x.tokenIn === i && x.tokenOut === o);
    if (!e) return null;
    const min = BigInt(String(e.meta?.minSellAmount ?? '0'));
    if (amountIn < min) return null;
    const out = curveOut(e.points, amountIn);
    if (out === null) return null;
    return { amountOut: out, gasEstimate: this.gas, expiry: e.asOfMs + 2_000, firm: false, feeBps: e.feeBps, source: 'textile-levels' };
  }

  /**
   * Firm, taker-bound quote. Blocks up to ~750 ms typically; the server may hold up to ~70 s on a cold
   * corridor, so the timeout is 75 s per Textile's docs.
   */
  async firmQuote(req: { sellToken: Address; buyToken: Address; sellAmount: bigint; taker: Address }, nowMs = Date.now()): Promise<FirmQuoteResult> {
    if (!this.cfg.apiKey) throw new Error('textile firm quotes require TEXTILE_API_KEY');
    if (!this.slots.tryAcquire(nowMs)) {
      return { status: 'no_quote', reason: 'local_rfq_cap_reached' };
    }
    let held = false;
    try {
      const res = await this.f(`${this.base}/v2/rfq/request`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chainId: this.chainId,
          sellToken: req.sellToken,
          buyToken: req.buyToken,
          sellAmount: req.sellAmount.toString(),
          taker: req.taker,
        }),
        signal: AbortSignal.timeout(75_000),
      });
      const body = (await res.json()) as any;
      if (!res.ok) throw new Error(`textile rfq ${res.status}: ${body?.error?.code ?? 'unknown'} ${body?.error?.message ?? ''}`);
      const d = body.data;
      if (d.status === 'no_quote') {
        return {
          status: 'no_quote',
          reason: d.reason,
          availableSellAmount: d.availableSellAmount ? BigInt(d.availableSellAmount) : undefined,
          retryAfterMs: d.retryAfterMs,
        };
      }
      const q = d.quote;
      const latest = Date.parse(q.latestOrderDeadline ?? q.orderDeadline);
      this.slots.hold(latest);
      held = true;
      return {
        status: 'quoted',
        rfqId: d.rfqId,
        claimToken: d.claimToken,
        takerPays: BigInt(q.takerPays),
        buyAmount: BigInt(q.buyAmount),
        feeAmount: BigInt(q.feeAmount),
        expiresAt: Date.parse(q.expiresAt),
        orderDeadline: Date.parse(q.orderDeadline),
        latestOrderDeadline: latest,
        // Aggregator docs name `spender`; the standard response names `reactor`. Prefer spender when present.
        spender: (q.spender ?? q.reactor).toLowerCase(),
        approval: { to: d.transactions.approval.to, data: d.transactions.approval.data, value: BigInt(d.transactions.approval.value) },
        swap: { to: d.transactions.swap.to, data: d.transactions.swap.data, value: BigInt(d.transactions.swap.value) },
      };
    } finally {
      if (!held) this.slots.release();
    }
  }

  /** Report a broadcast fill (optional per Textile docs; fills are indexed on-chain either way). */
  async submit(rfqId: string, txHash: string): Promise<void> {
    if (!this.cfg.apiKey) return;
    await this.f(`${this.base}/v2/rfq/${rfqId}/submit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
}
