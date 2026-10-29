/**
 * Replay a routing decision offline against a published graph snapshot.
 * Usage: node scripts/replay.ts <graph-snapshot.json> <SYMBOL_IN> <SYMBOL_OUT> <usd>
 */
import { readFile } from 'node:fs/promises';
import { PriceGraph } from '../packages/core/src/graph.ts';
import { Pricer } from '../packages/core/src/pricer.ts';
import { bestRoute, enumeratePaths, simulatePath } from '../packages/core/src/router.ts';
import { TokenRegistry } from '../packages/core/src/tokens.ts';

const [file, a, b, usdArg] = process.argv.slice(2);
if (!file || !a || !b || !usdArg) throw new Error('usage: replay.ts <snapshot.json> <IN> <OUT> <usd>');
const snap = JSON.parse(await readFile(file, 'utf8'));
const tokens = new TokenRegistry();
const graph = PriceGraph.fromSnapshot(snap.edges);
const pricer = new Pricer(tokens, graph, 600_000);
const tin = tokens.bySymbol(a).address;
const tout = tokens.bySymbol(b).address;
const now: number = snap.now;
const amountIn = pricer.amountForUsd(tin, Number(usdArg), now)!;
const sym = (t: string) => tokens.get(t)?.symbol ?? t.slice(0, 8);
const fmt = (x: bigint, t: string) => (Number(x) / 10 ** (tokens.get(t)?.decimals ?? 18)).toPrecision(8);

console.log(`amountIn ${fmt(amountIn, tin)} ${a}`);
const req = { tokenIn: tin, tokenOut: tout, amountIn, nowMs: now, maxAgeMs: 600_000, gasPriceWei: BigInt(snap.gasPrice), nativeUsd: snap.nativeUsd ?? (snap as { celoUsd?: number }).celoUsd ?? 0.08 };
for (const p of enumeratePaths(graph, req)) {
  const sim = simulatePath(p, amountIn);
  const cap = p.map((e) => `${e.venue}:${sym(e.tokenIn)}>${sym(e.tokenOut)} cap ${fmt(e.points.at(-1)!.amountIn, e.tokenIn)} pts ${e.points.length}`);
  console.log(`${sim ? fmt(sim.at(-1)!, tout) : 'NO DEPTH'}  <=  ${cap.join(' | ')}`);
}
const r = bestRoute(graph, pricer, req);
console.log('best:', r && r.paths.map((p) => `${p.edges.map((e) => `${e.venue}:${sym(e.tokenIn)}>${sym(e.tokenOut)}`).join(' ')} in ${fmt(p.amountIn, tin)} out ${fmt(p.amountOut, tout)}`));
