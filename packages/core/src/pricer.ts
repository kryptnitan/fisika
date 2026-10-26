import { curveOut } from './curve.ts';
import type { PriceGraph } from './graph.ts';
import type { TokenRegistry } from './tokens.ts';
import type { Address } from './types.ts';

/** Standard sample notionals in USD: the "depth at $10 / $100 / $1,000" on the board, plus $10k. */
export const SAMPLE_USD = [10, 100, 1_000, 10_000] as const;

/**
 * USD reference prices, used ONLY for sizing samples, gas conversion and display. Never used inside the
 * profit check: arbitrage cycles start and end in the same token, so P&L needs no external price.
 *
 * USD-pegged tokens are 1.0. Every other token is priced from the best fresh edge out of a USD token at the
 * $100 sample, falling back to a hint (e.g. Textile /tickers) for bootstrapping.
 */
export class Pricer {
  private hints = new Map<string, number>();
  private readonly tokens: TokenRegistry;
  private readonly graph: PriceGraph;
  private readonly maxAgeMs: number;

  constructor(tokens: TokenRegistry, graph: PriceGraph, maxAgeMs = 15_000) {
    this.tokens = tokens;
    this.graph = graph;
    this.maxAgeMs = maxAgeMs;
  }

  setHint(token: Address, usdPerToken: number): void {
    if (usdPerToken > 0 && Number.isFinite(usdPerToken)) this.hints.set(token.toLowerCase(), usdPerToken);
  }

  usdPerToken(token: Address, nowMs: number): number | null {
    const info = this.tokens.get(token);
    if (!info || info.decimals === null) return null;
    if (info.usd) return 1;
    let best: number | null = null;
    for (const usdTok of this.tokens.all().filter((t) => t.usd && t.decimals !== null)) {
      for (const e of this.graph.between(usdTok.address, token, nowMs, this.maxAgeMs)) {
        const inAmt = 100n * 10n ** BigInt(usdTok.decimals!);
        const out = curveOut(e.points, inAmt);
        if (!out || out === 0n) continue;
        const tokensOut = Number(out) / 10 ** info.decimals;
        const px = 100 / tokensOut;
        if (best === null || px < best) best = px; // most tokens per dollar = best execution
      }
    }
    return best ?? this.hints.get(token.toLowerCase()) ?? null;
  }

  /** Atomic amount of `token` worth `usd`, or null when unpriced. */
  amountForUsd(token: Address, usd: number, nowMs: number): bigint | null {
    const px = this.usdPerToken(token, nowMs);
    const info = this.tokens.get(token);
    if (px === null || !info || info.decimals === null) return null;
    // Scale through 1e6 to keep sub-unit precision without floating overflow on 18-decimal tokens.
    const micro = BigInt(Math.round((usd / px) * 1e6));
    return (micro * 10n ** BigInt(info.decimals)) / 1_000_000n;
  }

  usdValue(token: Address, amount: bigint, nowMs: number): number | null {
    const px = this.usdPerToken(token, nowMs);
    const info = this.tokens.get(token);
    if (px === null || !info || info.decimals === null) return null;
    return (Number(amount) / 10 ** info.decimals) * px;
  }

  sampleAmounts(token: Address, nowMs: number): bigint[] | null {
    const res: bigint[] = [];
    for (const usd of SAMPLE_USD) {
      const a = this.amountForUsd(token, usd, nowMs);
      if (a === null) return null;
      if (a > 0n) res.push(a);
    }
    return res;
  }
}
