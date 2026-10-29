/**
 * How much better is fisika's route than what a user gets by going to the single best venue themselves?
 * That improvement is the most fisika can charge before a user is better off ignoring it.
 *
 * Baseline per corridor and size = the best route using ONE venue only (multi-hop within that venue allowed,
 * like the venue's own app would do), across all venues. fisika = best route across all venues.
 * Both are compared net of gas, in output-token terms, with no fisika fee.
 *
 * Usage: node scripts/fee-headroom.ts <graph-snapshot.json> [out.md]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { PriceGraph, type EdgeSnapshot } from '../packages/core/src/graph.ts';
import { Pricer } from '../packages/core/src/pricer.ts';
import { bestRoute, type RouteRequest } from '../packages/core/src/router.ts';
import { TokenRegistry } from '../packages/core/src/tokens.ts';
import type { VenueId } from '../packages/core/src/types.ts';

const CORRIDORS: [string, string][] = [
  ['USDT', 'USDC'], ['USDC', 'USDT'], ['USDT', 'USDm'], ['USDm', 'USDT'], ['USDC', 'USDm'],
  ['USDT', 'cNGN'], ['cNGN', 'USDT'], ['USDT', 'NGNm'], ['NGNm', 'USDT'],
  ['USDT', 'KESm'], ['KESm', 'USDT'], ['USDT', 'GHSm'], ['GHSm', 'USDT'], ['USDT', 'XOFm'], ['USDT', 'ZARm'],
  ['USDT', 'wBRL'], ['wBRL', 'USDT'], ['USDT', 'wARS'], ['wARS', 'USDT'], ['USDT', 'BRLA'], ['USDT', 'COPM'],
  ['cNGN', 'KESm'], ['cNGN', 'GHSm'], ['wBRL', 'wARS'], ['cNGN', 'NGNm'],
];
const SIZES = [10, 100, 1_000, 10_000];
/** What a user can reach in one app: Mento's app routes through both its v2 and v3 pools. */
const APPS: Record<string, VenueId[]> = { Uniswap: ['uniswap-v3'], Mento: ['mento', 'mento-v2'], Textile: ['textile'] };
const LABEL: Record<string, string> = { 'uniswap-v3': 'Uniswap', mento: 'Mento', 'mento-v2': 'Mento', textile: 'Textile' };

const [file, outFile] = process.argv.slice(2);
if (!file) throw new Error('usage: fee-headroom.ts <graph-snapshot.json> [out.md]');
const snap = JSON.parse(await readFile(file, 'utf8')) as { now: number; gasPrice: string; nativeUsd: number; edges: EdgeSnapshot[] };
const tokens = new TokenRegistry();
const full = PriceGraph.fromSnapshot(snap.edges);
const pricer = new Pricer(tokens, full, 600_000);
const perApp = new Map(Object.entries(APPS).map(([app, vs]) => [app, PriceGraph.fromSnapshot(snap.edges.filter((e) => vs.includes(e.venue)))] as const));

type Cell = { usd: number; gainBps: number | null; fisikaVenues: string; baselineVenue: string | null; onlyFisika: boolean };
const rows: { pair: string; cells: Cell[] }[] = [];

for (const [a, b] of CORRIDORS) {
  const tin = tokens.bySymbol(a).address;
  const tout = tokens.bySymbol(b).address;
  const cells: Cell[] = [];
  for (const usd of SIZES) {
    const amountIn = pricer.amountForUsd(tin, usd, snap.now);
    if (!amountIn) {
      cells.push({ usd, gainBps: null, fisikaVenues: '—', baselineVenue: null, onlyFisika: false });
      continue;
    }
    const req: RouteRequest = { tokenIn: tin, tokenOut: tout, amountIn, nowMs: snap.now, maxAgeMs: 600_000, gasPriceWei: BigInt(snap.gasPrice), nativeUsd: snap.nativeUsd ?? (snap as { celoUsd?: number }).celoUsd ?? 0.08 };
    const fisika = bestRoute(full, pricer, req);
    let base: { v: string; net: bigint } | null = null;
    for (const [v, g] of perApp) {
      const r = bestRoute(g, pricer, req); // pricer reads the full graph for gas/USD conversion only
      if (r && (!base || r.netValueOut > base.net)) base = { v, net: r.netValueOut };
    }
    if (!fisika) {
      cells.push({ usd, gainBps: null, fisikaVenues: '—', baselineVenue: base?.v ?? null, onlyFisika: false });
      continue;
    }
    // Gain as a share of the order's value, so a venue that would wreck the order shows as a large but finite number.
    const outUsd = (x: bigint) => pricer.usdValue(tout, x < 0n ? 0n : x, snap.now) ?? 0;
    const gainBps = base ? ((outUsd(fisika.netValueOut) - outUsd(base.net)) / usd) * 10_000 : null;
    cells.push({
      usd,
      gainBps,
      fisikaVenues: [...new Set(fisika.paths.flatMap((p) => p.edges.map((e) => LABEL[e.venue])))].join('+') + (fisika.paths.length > 1 ? ' split' : ''),
      baselineVenue: base?.v ?? null,
      onlyFisika: !base,
    });
  }
  rows.push({ pair: `${a}→${b}`, cells });
}

const fmt = (c: Cell) => (c.onlyFisika ? 'only fisika' : c.gainBps === null ? '—' : c.gainBps > 500 ? '>500' : `${Math.max(0, c.gainBps).toFixed(1)}`);
const lines = [
  `# Fee headroom`,
  ``,
  `Snapshot ${new Date(snap.now).toISOString()}. Cells: how much more fisika's route returns than the best single app (Uniswap, Mento or Textile), in bps of the order's value, net of gas. >500 = the best single app would lose over 5% of the order. "only fisika" = no single venue can fill it.`,
  ``,
  `| Pair | $10 | $100 | $1k | $10k | fisika route ($1k) | best single venue ($1k) |`,
  `|---|---|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.pair} | ${r.cells.map(fmt).join(' | ')} | ${r.cells[2]!.fisikaVenues} | ${r.cells[2]!.baselineVenue ?? '—'} |`),
];
const all = rows.flatMap((r) => r.cells).filter((c) => c.gainBps !== null) as (Cell & { gainBps: number })[];
const sorted = all.map((c) => c.gainBps).sort((x, y) => x - y);
const med = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
const atLeast = (bps: number) => all.filter((c) => c.gainBps >= bps).length;
lines.push('', `Cells compared: ${all.length}. Median gain ${med.toFixed(1)} bps. ≥5 bps: ${atLeast(5)}. ≥10 bps: ${atLeast(10)}. ≥25 bps: ${atLeast(25)}. Only fisika can fill: ${rows.flatMap((r) => r.cells).filter((c) => c.onlyFisika).length}.`);
const md = lines.join('\n');
console.log(md);
if (outFile) await writeFile(outFile, md);
