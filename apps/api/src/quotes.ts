import { bestRoute, type Address, type Route, type TokenRegistry } from '@fisika/core';
import type { GraphState } from '@fisika/core/setup';

export interface QuoteRequest {
  tokenIn: string;
  tokenOut: string;
  /** Human units ("50000") or atomic units with `atomic: true`. */
  amount: string;
  atomic?: boolean;
  slippageBps?: number;
}

export interface StoredQuote {
  id: string;
  route: Route;
  createdMs: number;
  expiresMs: number;
  slippageBps: number;
  feeBps: number;
}

export class QuoteError extends Error {
  readonly status: 400 | 404 | 422 | 503;
  constructor(status: 400 | 404 | 422 | 503, message: string) {
    super(message);
    this.status = status;
  }
}

/** Resolve a symbol or address against the registry. */
export function resolveToken(tokens: TokenRegistry, s: string): Address {
  const t = /^0x[0-9a-fA-F]{40}$/.test(s) ? tokens.get(s) : (() => {
    try {
      return tokens.bySymbol(s);
    } catch (e) {
      throw new QuoteError(400, (e as Error).message);
    }
  })();
  if (!t) throw new QuoteError(400, `unsupported token ${s}`);
  if (t.decimals === null) throw new QuoteError(400, `${t.symbol} decimals not verified`);
  return t.address;
}

export function parseAmount(amount: string, decimals: number, atomic = false): bigint {
  if (atomic) {
    if (!/^\d+$/.test(amount)) throw new QuoteError(400, 'atomic amount must be an integer string');
    return BigInt(amount);
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new QuoteError(400, 'amount must be a positive decimal string');
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

export function formatAtomic(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = a.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export class QuoteBook {
  private quotes = new Map<string, StoredQuote>();
  private readonly ttlMs: number;
  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  quote(state: GraphState, tokens: TokenRegistry, req: QuoteRequest, opts: { feeBps: number; defaultSlippageBps: number; maxAgeMs: number; nowMs?: number }): StoredQuote {
    const now = opts.nowMs ?? Date.now();
    if (!state.updatedMs || now - state.updatedMs > opts.maxAgeMs * 2) throw new QuoteError(503, 'price graph is not fresh yet; retry shortly');
    const tokenIn = resolveToken(tokens, req.tokenIn);
    const tokenOut = resolveToken(tokens, req.tokenOut);
    if (tokenIn === tokenOut) throw new QuoteError(400, 'tokenIn and tokenOut must differ');
    const amountIn = parseAmount(req.amount, tokens.decimals(tokenIn), req.atomic);
    if (amountIn <= 0n) throw new QuoteError(400, 'amount must be positive');
    const slippageBps = Math.min(Math.max(req.slippageBps ?? opts.defaultSlippageBps, 1), 500);
    const route = bestRoute(state.graph, state.pricer, {
      tokenIn,
      tokenOut,
      amountIn,
      nowMs: now,
      maxAgeMs: opts.maxAgeMs,
      gasPriceWei: state.gasPriceWei,
      celoUsd: state.celoUsd,
      feeBps: opts.feeBps,
      slippageBps,
    });
    if (!route) throw new QuoteError(422, 'no route has enough liquidity for this size right now');
    const q: StoredQuote = { id: `q_${crypto.randomUUID()}`, route, createdMs: now, expiresMs: now + this.ttlMs, slippageBps, feeBps: opts.feeBps };
    this.gc(now);
    this.quotes.set(q.id, q);
    return q;
  }

  get(id: string, nowMs = Date.now()): StoredQuote | undefined {
    const q = this.quotes.get(id);
    return q && q.expiresMs > nowMs ? q : undefined;
  }

  /** Receipts may arrive after a quote expires; keep a longer-lived lookup for reconciliation. */
  getAny(id: string): StoredQuote | undefined {
    return this.quotes.get(id);
  }

  private gc(now: number) {
    if (this.quotes.size < 5_000) return;
    for (const [k, q] of this.quotes) if (now - q.expiresMs > 3_600_000) this.quotes.delete(k);
  }
}

/** Public JSON shape of a quote. */
export function quoteView(q: StoredQuote, tokens: TokenRegistry) {
  const r = q.route;
  const dIn = tokens.decimals(r.tokenIn);
  const dOut = tokens.decimals(r.tokenOut);
  const sym = (a: string) => tokens.get(a)?.symbol ?? a;
  const amountIn = Number(formatAtomic(r.amountIn, dIn));
  const amountOut = Number(formatAtomic(r.amountOut, dOut));
  return {
    quoteId: q.id,
    tokenIn: { symbol: sym(r.tokenIn), address: r.tokenIn, decimals: dIn },
    tokenOut: { symbol: sym(r.tokenOut), address: r.tokenOut, decimals: dOut },
    amountIn: formatAtomic(r.amountIn, dIn),
    amountOut: formatAtomic(r.amountOut, dOut),
    minOut: formatAtomic(r.minOut, dOut),
    rate: amountIn > 0 ? amountOut / amountIn : 0,
    serviceFee: formatAtomic(r.serviceFee, dOut),
    serviceFeeBps: q.feeBps,
    slippageBps: q.slippageBps,
    gasUsd: Number(r.gasUsd.toFixed(6)),
    execution: r.execution,
    txCount: r.txCount,
    firm: r.allFirm,
    venues: r.venues,
    paths: r.paths.map((p) => ({
      amountIn: formatAtomic(p.amountIn, dIn),
      amountOut: formatAtomic(p.amountOut, dOut),
      hops: p.edges.map((e, i) => ({
        venue: e.venue,
        pool: e.poolId,
        from: sym(e.tokenIn),
        to: sym(e.tokenOut),
        amountIn: formatAtomic(p.hopAmounts[i]!, tokens.decimals(e.tokenIn)),
        amountOut: formatAtomic(p.hopAmounts[i + 1]!, tokens.decimals(e.tokenOut)),
        firm: e.firm,
      })),
    })),
    asOf: new Date(r.asOfMs).toISOString(),
    expiresAt: new Date(q.expiresMs).toISOString(),
  };
}
