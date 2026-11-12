import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setControl } from '../src/agent/control.ts';
import { MemeEngine } from '../src/meme/engine.ts';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, type DexPair, type MintInfo } from '../src/meme/sources.ts';
import { DEFAULT_RULES, entrySignal, exitDecision, roundTrip, safety, screen, tradeSize, type Position } from '../src/meme/strategy.ts';

const R = DEFAULT_RULES;
const NOW = Date.parse('2026-11-11T12:00:00Z');
const MINT = 'Meme111111111111111111111111111111111111111';
const PAIR = 'Pair111111111111111111111111111111111111111';

function pair(o: Partial<DexPair> & { price?: number; liq?: number; m5?: number; h1?: number; v5?: number; vh1?: number; b5?: number; s5?: number } = {}): DexPair {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress: PAIR,
    baseToken: { address: MINT, name: 'Meme', symbol: 'MEME' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' },
    priceUsd: String(o.price ?? 0.001),
    liquidity: { usd: o.liq ?? 100_000, base: 50_000_000, quote: 250 },
    volume: { m5: o.v5 ?? 20_000, h1: o.vh1 ?? 120_000, h6: 400_000, h24: 900_000 },
    txns: { m5: { buys: o.b5 ?? 60, sells: o.s5 ?? 30 }, h1: { buys: 600, sells: 400 }, h6: { buys: 2000, sells: 1800 }, h24: { buys: 5000, sells: 4800 } },
    priceChange: { m5: o.m5 ?? 4, h1: o.h1 ?? 25, h6: 40, h24: 60 },
    marketCap: 2_000_000,
    fdv: 2_000_000,
    pairCreatedAt: NOW - 6 * 3_600_000,
    ...o,
  };
}

const goodMint: MintInfo = { program: TOKEN_PROGRAM, decimals: 6, supply: 1_000_000_000_000_000n, mintAuthority: null, freezeAuthority: null, extensions: [] };

describe('meme desk rules', () => {
  it('pins the token program ids (verified against the spl-token-2022-interface crate source)', () => {
    assert.equal(TOKEN_PROGRAM, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    assert.equal(TOKEN_2022_PROGRAM, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    assert.equal(safety({ ...goodMint, program: TOKEN_2022_PROGRAM, extensions: [] }, [], 1, R), null, 'a clean Token-2022 mint passes');
  });

  it('sizes at 10% of the wallet, between $1 and $1,000, and never over 2% of the pool', () => {
    assert.equal(tradeSize(100, 100, 1e6, R), 10);
    assert.equal(tradeSize(5, 5, 1e6, R), 0, '$0.50 is under the $1 minimum');
    assert.equal(tradeSize(10, 10, 1e6, R), 1);
    assert.equal(tradeSize(50_000, 50_000, 1e9, R), 1000, 'capped at $1,000');
    assert.equal(tradeSize(1_000, 1_000, 2_000, R), 40, '2% of a $2k pool');
    assert.equal(tradeSize(100, 3, 1e6, R), 3, 'not more than the cash left');
  });

  it('screens and only enters when buyers are in control and volume is accelerating', () => {
    assert.equal(screen(pair(), R, NOW), null);
    assert.equal(screen(pair({ liq: 5_000 }), R, NOW), 'liquidity_low');
    assert.equal(screen(pair({ pairCreatedAt: NOW - 5 * 60_000 }), R, NOW), 'too_new');
    assert.equal(entrySignal(pair(), R), null);
    assert.equal(entrySignal(pair({ h1: 400 }), R), 'already_pumped');
    assert.equal(entrySignal(pair({ b5: 20, s5: 40 }), R), 'buyers_not_in_control');
    assert.equal(entrySignal(pair({ v5: 5_000, vh1: 200_000 }), R), 'volume_not_accelerating');
    assert.equal(entrySignal(pair({ m5: -1 }), R), 'not_rising_5m');
  });

  it('refuses tokens that can be minted, frozen, taxed, or are held by a few wallets', () => {
    const pool = 50_000_000; // tokens in the pool
    const poolRaw = BigInt(pool) * 10n ** 6n;
    const small = Array.from({ length: 12 }, () => 10_000_000_000_000n); // 1% each
    assert.equal(safety(goodMint, [poolRaw, ...small], pool, R), null, '10 wallets at 1% each is fine');
    assert.equal(safety({ ...goodMint, mintAuthority: 'Auth' }, [], pool, R), 'mint_authority_live');
    assert.equal(safety({ ...goodMint, freezeAuthority: 'Auth' }, [], pool, R), 'freeze_authority_live');
    assert.equal(safety({ ...goodMint, program: TOKEN_2022_PROGRAM, extensions: ['transferFeeConfig'] }, [], pool, R), 'token2022_transferFeeConfig');
    const whales = Array.from({ length: 10 }, () => 50_000_000_000_000n); // 5% each = 50%
    assert.match(safety(goodMint, [poolRaw, ...whales], pool, R) ?? '', /^top10_hold_50pct$/, 'the pool vault is not counted as a holder');
    assert.equal(safety(null, [], pool, R), 'mint_unreadable');
  });

  it('catches honeypots and sell taxes with a buy-then-sell quote', () => {
    assert.equal(roundTrip(10, 9.75, 0.5, R), null);
    assert.equal(roundTrip(10, null, 0.5, R), 'cannot_sell');
    assert.match(roundTrip(10, 9.5, 0.5, R) ?? '', /^round_trip_loss_5\.0pct$/, 'a 5% sell tax is caught');
    assert.match(roundTrip(10, 9.8, 4, R) ?? '', /^price_impact_4\.0pct$/);
  });

  it('exits: rug first, then the stop, then profit-taking near the high or when the trend turns (all on sellable marks)', () => {
    // A position marked at a sellable price (what a Jupiter sell quote says we would get), 10,000 tokens, $10 cost.
    const at = (price: number, o: Partial<Position> = {}): Position => ({ id: 'p', mint: MINT, symbol: 'MEME', pair: PAIR, openedMs: NOW - 10 * 60_000, costUsd: 10, tokensRaw: '10000000000', decimals: 6, entryPrice: 0.001, peakPrice: Math.max(0.001, price), athAtEntry: 0.002, liquidityAtEntry: 100_000, lastPrice: price, lastValueUsd: price * 10_000, ...o });
    assert.equal(exitDecision(at(0.001), null, NOW, R), 'rug_liquidity', 'pair gone');
    assert.equal(exitDecision(at(0.001), pair({ liq: 60_000 }), NOW, R), 'rug_liquidity', 'liquidity -40%');
    assert.equal(exitDecision(at(0.00089), pair({ price: 0.0012 }), NOW, R), 'stop_loss', 'the chart says +20% but we could only sell at -11%: the stop is on what we would get');
    assert.equal(exitDecision(at(0.00102), pair({ price: 0.00085 }), NOW, R), null, 'the chart prints a dip we cannot sell into; our sale price is fine: hold');
    assert.equal(exitDecision(at(0.0011), pair({ v5: 1_000, vh1: 200_000, m5: -1 }), NOW, R), 'volume_collapse');
    assert.equal(exitDecision(at(0.0012), pair({ b5: 10, s5: 40, m5: -5 }), NOW, R), 'trend_turned', 'in profit, sellers took over: sell now');
    assert.equal(exitDecision(at(0.00195, { peakPrice: 0.00198 }), pair({ m5: -0.5, b5: 30, s5: 35 }), NOW, R), 'ath_take_profit');
    assert.equal(exitDecision(at(0.00197, { peakPrice: 0.00198 }), pair({ m5: 3, b5: 80, s5: 20 }), NOW, R), null, 'at the high but still pushing: hold');
    assert.equal(exitDecision(at(0.00133, { peakPrice: 0.0015, athAtEntry: 0.01 }), pair({ m5: 1 }), NOW, R), 'trailing_stop', 'up 50% then -11% off the peak');
    assert.equal(exitDecision(at(0.00102, { peakPrice: 0.00108, athAtEntry: 0.01 }), pair({ m5: 1 }), NOW, R), null, 'up 8% then back: a wiggle, not a trail (trail starts at +15%)');
    assert.equal(exitDecision(at(0.00104, { openedMs: NOW - 241 * 60_000, athAtEntry: 0.01 }), pair(), NOW, R), 'max_hold');
    assert.equal(exitDecision(at(0.00101, { openedMs: NOW - 50 * 60_000, athAtEntry: 0.01 }), pair(), NOW, R), 'stalled');
    assert.equal(exitDecision(at(0.00103, { athAtEntry: 0.01 }), pair(), NOW, R), null, 'young, small gain, momentum fine: hold');
  });
});

describe('meme desk paper engine', () => {
  function rig(opts: { price?: () => number; liq?: () => number; sellable?: () => boolean } = {}) {
    let t = NOW;
    const price = opts.price ?? (() => 0.001);
    const fake = {
      dex: {
        latestSolanaTokens: async () => [MINT],
        pairsFor: async () => [pair({ price: price(), liq: opts.liq?.() ?? 100_000 })],
      },
      gecko: { allTimeHigh: async () => 0.002 },
      jup: {
        quote: async (inMint: string, outMint: string, amount: bigint) => {
          if (inMint === USDC_MINT) return { inAmount: amount.toString(), outAmount: String(Math.floor((Number(amount) / 1e6 / price()) * 0.995 * 1e6)), priceImpactPct: '0.4' };
          if (opts.sellable && !opts.sellable()) return null;
          void outMint;
          return { inAmount: amount.toString(), outAmount: String(Math.floor((Number(amount) / 1e6) * price() * 0.995 * 1e6)), priceImpactPct: '0.4' };
        },
      },
      rpc: { mint: async () => goodMint, largestAccounts: async () => [] as bigint[] },
    };
    return { fake, tick: (ms: number) => (t += ms), now: () => t };
  }

  async function engine(r: ReturnType<typeof rig>, dir?: string, controlFile?: string) {
    const e = new MemeEngine({ ...r.fake, rules: R, dataDir: dir ?? (await mkdtemp(join(tmpdir(), 'meme-'))), controlFile, startEquityUsd: 100, swapCostUsd: 0.01, now: r.now, log: () => undefined });
    await e.restore();
    return e;
  }

  it('opens one position at 10% of the wallet and closes it on the stop-loss', async () => {
    let p = 0.001;
    const r = rig({ price: () => p });
    const e = await engine(r);
    await e.scan();
    assert.equal(e.state.positions.length, 1);
    assert.equal(e.state.positions[0]!.costUsd, 10.01);
    assert.ok(Math.abs(e.state.cashUsd - 89.99) < 1e-9);
    p = 0.00088; // -12%
    r.tick(15_000);
    await e.watch();
    assert.equal(e.state.positions.length, 0);
    assert.equal(e.state.stats.trades, 1);
    assert.ok(e.state.stats.realizedUsd < -1 && e.state.stats.realizedUsd > -2, `lost about 12% of $10: ${e.state.stats.realizedUsd}`);
    const ledger = (await readFile(join((e as any).d.dataDir, 'meme-ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(ledger[0].reason, 'stop_loss');
    p = 0.001;
    r.tick(3 * 3_600_000);
    await e.scan();
    assert.equal(e.state.positions.length, 0, 'a token that lost us money is not re-entered for a day');
    r.tick(22 * 3_600_000);
    await e.scan();
    assert.equal(e.state.positions.length, 1, 'a day later it is eligible again');
  });

  it('cannot sell → books a total loss as rug_cannot_sell', async () => {
    let sellable = true;
    let liq = 100_000;
    const r = rig({ sellable: () => sellable, liq: () => liq });
    const e = await engine(r);
    await e.scan();
    sellable = false;
    liq = 10_000; // liquidity pulled
    await e.watch();
    const s = e.state.stats;
    assert.equal(s.trades, 1);
    assert.ok(Math.abs(s.realizedUsd + 10.01) < 1e-6, 'whole position lost');
  });

  it('daily loss limit (5%) closes everything and stops new entries until the next UTC day', async () => {
    let p = 0.001;
    const r = rig({ price: () => p });
    const dir = await mkdtemp(join(tmpdir(), 'meme-'));
    const e = await engine(r, dir);
    (e as any).d.rules = { ...R, stopLossPct: 99, maxOpen: 1 }; // force the daily limit to be what triggers
    await e.scan();
    p = 0.0004; // -60% on a $10 position = -$6 = -6% of the wallet
    await e.watch();
    assert.equal(e.state.halted, true);
    assert.equal(e.state.positions.length, 0);
    p = 0.001;
    await e.scan();
    assert.equal(e.state.positions.length, 0, 'halted: no entries');
    r.tick(13 * 3_600_000); // next UTC day
    await e.watch();
    assert.equal(e.state.halted, false, 'new day, new budget');
  });

  it('paused switch: no new entries, but open positions are still managed; state survives a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'meme-'));
    const ctl = join(dir, 'control.json');
    let p = 0.001;
    const r = rig({ price: () => p });
    await setControl(ctl, 'all', true, 't');
    const e = await engine(r, dir, ctl);
    await e.scan();
    assert.equal(e.state.positions.length, 1);
    await setControl(ctl, 'solana', false, 't');
    const e2 = await engine(r, dir, ctl); // "restart"
    assert.equal(e2.state.positions.length, 1, 'position restored');
    assert.equal(e2.paused(), true);
    await e2.scan();
    assert.equal(e2.state.positions.length, 1, 'no new entries while paused');
    p = 0.0008;
    await e2.watch();
    assert.equal(e2.state.positions.length, 0, 'stop-loss still fires while paused');
  });
});
