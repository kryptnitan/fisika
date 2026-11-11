/**
 * Meme desk rules. Pure functions only (no network), so every rule is unit-tested.
 *
 * The owner's rules:
 * - Size each trade at 10% of the meme wallet, never under $1 or over $1,000.
 * - Lose at most 5% of the wallet in a day: then close everything and stop until the next UTC day.
 * - Take profit like a trader near the all-time high: while price keeps rising, hold; when the move turns down,
 *   sell at once. In the all-time-high zone, sell as soon as momentum weakens. If something looks like a rug
 *   (liquidity pulled, volume collapse, can't sell), get out immediately.
 * - Plus: a hard stop-loss, a trailing stop once in profit, and a maximum hold time.
 *
 * None of this guarantees a profit. It limits how much any one trade, and any one day, can lose.
 */
import type { DexPair, MintInfo } from './sources.ts';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './sources.ts';

export interface MemeRules {
  sizePct: number; // of equity
  minTradeUsd: number;
  maxTradeUsd: number;
  dailyLossPct: number; // of the day's starting equity, realized + open
  maxOpen: number;
  // filters
  minLiquidityUsd: number;
  maxLiquidityShare: number; // trade size as a share of pool liquidity
  minVolumeH1Usd: number;
  minAgeMin: number;
  maxAgeH: number;
  maxMarketCapUsd: number;
  maxTop10Pct: number; // of supply, excluding the pool
  maxRoundTripLossPct: number; // buy then sell quote: catches sell taxes and honeypots
  maxPriceImpactPct: number;
  maxPumpH1Pct: number; // already up this much in an hour: too late
  // exits
  stopLossPct: number;
  trailActivatePct: number;
  trailPct: number;
  athZonePct: number; // within this % of the all-time high counts as "at the high"
  maxHoldMin: number;
  stallMin: number; // flat this long: give the slot back
  stallPct: number;
  liquidityDropPct: number; // rug: liquidity down this much from entry
  cooldownMin: number; // don't re-enter a token this soon after exiting it
}

export const DEFAULT_RULES: MemeRules = {
  sizePct: 10,
  minTradeUsd: 1,
  maxTradeUsd: 1_000,
  dailyLossPct: 5,
  maxOpen: 3,
  minLiquidityUsd: 20_000,
  maxLiquidityShare: 0.02,
  minVolumeH1Usd: 25_000,
  minAgeMin: 30,
  maxAgeH: 24 * 7,
  maxMarketCapUsd: 50_000_000,
  maxTop10Pct: 35,
  maxRoundTripLossPct: 6,
  maxPriceImpactPct: 3,
  maxPumpH1Pct: 150,
  stopLossPct: 10,
  trailActivatePct: 5,
  trailPct: 8,
  athZonePct: 5,
  maxHoldMin: 240,
  stallMin: 45,
  stallPct: 2,
  liquidityDropPct: 30,
  cooldownMin: 120,
};

const n = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const vol = (p: DexPair, w: string) => n(p.volume?.[w]);
const chg = (p: DexPair, w: string) => n(p.priceChange?.[w]);
const tx = (p: DexPair, w: string) => p.txns?.[w] ?? { buys: 0, sells: 0 };

/* --------------------------------------------------------------------------------------------- screening */

/** Cheap checks on DexScreener data alone. Returns the first failed rule, or null. */
export function screen(p: DexPair, r: MemeRules, nowMs: number): string | null {
  const liq = n(p.liquidity?.usd);
  if (liq < r.minLiquidityUsd) return 'liquidity_low';
  if (!p.pairCreatedAt) return 'age_unknown';
  const ageMin = (nowMs - p.pairCreatedAt) / 60_000;
  if (ageMin < r.minAgeMin) return 'too_new';
  if (ageMin > r.maxAgeH * 60) return 'too_old';
  if (vol(p, 'h1') < r.minVolumeH1Usd) return 'volume_low';
  const mc = n(p.marketCap ?? p.fdv);
  if (mc > r.maxMarketCapUsd) return 'market_cap_high';
  if (!Number(p.priceUsd)) return 'no_price';
  return null;
}

/**
 * Momentum entry: buyers in control right now, and the move is accelerating, not already spent.
 * Returns a reason when it is not a buy.
 */
export function entrySignal(p: DexPair, r: MemeRules): string | null {
  const m5 = tx(p, 'm5');
  const h1 = tx(p, 'h1');
  if (chg(p, 'm5') <= 0) return 'not_rising_5m';
  if (chg(p, 'h1') <= 0) return 'not_rising_1h';
  if (chg(p, 'h1') > r.maxPumpH1Pct) return 'already_pumped';
  if (m5.buys < Math.max(10, m5.sells * 1.2)) return 'buyers_not_in_control';
  if (h1.buys < h1.sells) return 'more_sellers_this_hour';
  // Last 5 minutes trading faster than the hour's average pace.
  if (vol(p, 'm5') * 12 < vol(p, 'h1') * 1.2) return 'volume_not_accelerating';
  return null;
}

/** On-chain safety: the token cannot be minted, frozen, taxed, or controlled by a few wallets. */
export function safety(m: MintInfo | null, largest: bigint[], poolTokens: number, r: MemeRules): string | null {
  if (!m) return 'mint_unreadable';
  if (m.program !== TOKEN_PROGRAM && m.program !== TOKEN_2022_PROGRAM) return 'not_spl_token';
  if (m.mintAuthority) return 'mint_authority_live';
  if (m.freezeAuthority) return 'freeze_authority_live';
  const bad = m.extensions.filter((e) => ['transferFeeConfig', 'transferHook', 'permanentDelegate', 'nonTransferable', 'defaultAccountState', 'pausableConfig'].includes(e));
  if (bad.length) return `token2022_${bad[0]}`;
  if (m.supply <= 0n) return 'no_supply';
  // Drop the pool's own vault (the account holding about the pool's token amount) before measuring concentration.
  const pool = BigInt(Math.floor(poolTokens * 10 ** m.decimals));
  let skipped = false;
  const holders = largest.filter((a) => {
    if (!skipped && pool > 0n && a > (pool * 97n) / 100n && a < (pool * 103n) / 100n) {
      skipped = true;
      return false;
    }
    return true;
  });
  const top10 = holders.slice(0, 10).reduce((s, a) => s + a, 0n);
  const pct = Number((top10 * 10_000n) / m.supply) / 100;
  if (pct > r.maxTop10Pct) return `top10_hold_${pct.toFixed(0)}pct`;
  return null;
}

/** Buy-then-sell quotes at the trade size: a sell tax or a honeypot shows up as a big round-trip loss. */
export function roundTrip(spentUsd: number, backUsd: number | null, buyImpactPct: number, r: MemeRules): string | null {
  if (backUsd === null) return 'cannot_sell';
  const loss = ((spentUsd - backUsd) / spentUsd) * 100;
  if (loss > r.maxRoundTripLossPct) return `round_trip_loss_${loss.toFixed(1)}pct`;
  if (buyImpactPct > r.maxPriceImpactPct) return `price_impact_${buyImpactPct.toFixed(1)}pct`;
  return null;
}

/* ----------------------------------------------------------------------------------------------- sizing */

export function tradeSize(equityUsd: number, cashUsd: number, liquidityUsd: number, r: MemeRules): number {
  const raw = Math.min((equityUsd * r.sizePct) / 100, r.maxTradeUsd, cashUsd, liquidityUsd * r.maxLiquidityShare);
  return raw >= r.minTradeUsd ? Math.floor(raw * 100) / 100 : 0;
}

/** Day loss so far as % of the day's starting equity (realized + open). */
export function dayLossPct(dayStartEquity: number, equityNow: number): number {
  return dayStartEquity > 0 ? Math.max(0, ((dayStartEquity - equityNow) / dayStartEquity) * 100) : 0;
}

/* ------------------------------------------------------------------------------------------------ exits */

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  pair: string;
  openedMs: number;
  costUsd: number;
  tokensRaw: string;
  decimals: number;
  entryPrice: number;
  peakPrice: number;
  athAtEntry: number | null;
  liquidityAtEntry: number;
  lastPrice: number;
  lastValueUsd: number;
}

export type ExitReason = 'stop_loss' | 'rug_liquidity' | 'rug_cannot_sell' | 'volume_collapse' | 'trend_turned' | 'ath_take_profit' | 'trailing_stop' | 'max_hold' | 'stalled' | 'daily_loss_limit';

/**
 * What to do with an open position right now. `p` is the fresh pair data; price is the pair's USD price.
 * Order matters: rug signs first, then the hard stop, then profit-taking.
 */
export function exitDecision(pos: Position, p: DexPair | null, nowMs: number, r: MemeRules): ExitReason | null {
  if (!p) return 'rug_liquidity'; // pair vanished
  const price = Number(p.priceUsd) || 0;
  const liq = n(p.liquidity?.usd);
  if (liq < pos.liquidityAtEntry * (1 - r.liquidityDropPct / 100)) return 'rug_liquidity';
  const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  if (pnlPct <= -r.stopLossPct) return 'stop_loss';

  const m5 = tx(p, 'm5');
  const sellersInControl = m5.sells > Math.max(5, m5.buys * 1.5);
  const falling5m = chg(p, 'm5') < -3;
  // Volume collapse: the last 5 minutes trade at under a fifth of the hour's pace while price is falling.
  if (vol(p, 'm5') * 12 < vol(p, 'h1') * 0.2 && chg(p, 'm5') < 0) return 'volume_collapse';

  const peak = Math.max(pos.peakPrice, price);
  const upFromEntry = ((peak - pos.entryPrice) / pos.entryPrice) * 100;
  const offPeak = ((peak - price) / peak) * 100;

  if (pnlPct > 0) {
    // In profit and the downside is starting: sell immediately.
    if (sellersInControl && falling5m) return 'trend_turned';
    // At the all-time-high zone: take it as soon as momentum fades.
    const ath = Math.max(pos.athAtEntry ?? 0, peak);
    const nearAth = price >= ath * (1 - r.athZonePct / 100);
    const fading = chg(p, 'm5') <= 0 || m5.buys <= m5.sells;
    if (nearAth && fading && pos.athAtEntry !== null) return 'ath_take_profit';
  }
  if (upFromEntry >= r.trailActivatePct && offPeak >= r.trailPct) return 'trailing_stop';
  const heldMin = (nowMs - pos.openedMs) / 60_000;
  if (heldMin >= r.maxHoldMin) return 'max_hold';
  if (heldMin >= r.stallMin && Math.abs(pnlPct) < r.stallPct && upFromEntry < r.trailActivatePct) return 'stalled';
  return null;
}
