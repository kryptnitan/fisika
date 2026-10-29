/**
 * One unattended PAPER session: live Celo prices on free RPCs, the arbitrage engine with every risk limit,
 * nothing signed. Run repeatedly (the `paper` workflow runs it every hour) to build the multi-day paper record
 * the go-live checklist asks for before any capital is used.
 *
 *   SESSION_MINUTES=25 OUT_DIR=paper node src/paper-session.ts
 *
 * Appends one JSON line per session to OUT_DIR/paper-log.jsonl, carries "already filled" state across sessions
 * in OUT_DIR/paper-state.json, and rewrites OUT_DIR/paper-summary.md from the whole log.
 */
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TokenRegistry } from '@fisika/core';
import { createVenues, LiveGraph } from '@fisika/core/setup';
import { FREE_CELO_RPCS, makeClient, redactRpc, vetRpcs } from '@fisika/core/viem';
import { PaperArbRunner } from './arb.ts';

const minutes = Number(process.env.SESSION_MINUTES ?? 25);
const refreshMs = Number(process.env.GRAPH_REFRESH_MS ?? 15_000);
const outDir = process.env.OUT_DIR ?? 'paper';
const urls = (process.env.CELO_RPC_URLS || FREE_CELO_RPCS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const limits = {
  maxTradeUsd: Number(process.env.MAX_TRADE_USD ?? 1_000),
  minEdgeBps: Number(process.env.MIN_EDGE_BPS ?? 5),
  minEdgeUsd: Number(process.env.MIN_EDGE_USD ?? 0.05),
  slippageBps: Number(process.env.SLIPPAGE_BPS ?? 30),
  dailyLossLimitUsd: Number(process.env.DAILY_LOSS_LIMIT_USD ?? 25),
  maxTokenExposureUsd: Number(process.env.MAX_TOKEN_EXPOSURE_USD ?? 200),
};

interface SessionLine {
  start: string;
  end: string;
  minutes: number;
  rpcs: string[];
  rpcRejected: { rpc: string; reason: string }[];
  rpcRequests: number;
  refreshes: number;
  refreshFailures: Record<string, number>;
  graphEdges: number;
  opportunities: number;
  fills: number;
  skipped: Record<string, number>;
  pnlUsd: number;
  fillsDetail: { at: string; path: string; venues: string[]; sizeUsd: number; netBps: number; netUsd: number; txCount: number }[];
}

await mkdir(outDir, { recursive: true });
const startMs = Date.now();

// 1. Vet the free RPCs: right chain, reachable, not lagging. Only vetted endpoints are used.
const vetting = await vetRpcs(urls);
if (!vetting.ok.length) {
  console.error('no usable RPC', vetting.rejected);
  process.exit(1);
}
console.log(`rpc ok: ${vetting.ok.map(redactRpc).join(', ')}${vetting.rejected.length ? ` · rejected: ${JSON.stringify(vetting.rejected)}` : ''}`);

const client = makeClient(vetting.ok);
const tokens = new TokenRegistry();
const venues = await createVenues(client, tokens);
const live = new LiveGraph(client, tokens, venues, refreshMs * 2.5, vetting.ok);
await live.start(refreshMs);

const usd = ['USDT', 'USDC', 'USDm'].map((s) => tokens.bySymbol(s).address);
const arb = new PaperArbRunner(() => live.state, tokens, venues.byId, {
  startTokens: usd,
  sizesUsd: [10, 100, 1_000],
  maxLen: 4,
  maxAgeMs: refreshMs * 2.5,
  textileAtomic: false,
  ...limits,
});

// 2. Carry "already paper-filled at these prices" across sessions so a static price is never counted twice.
const statePath = join(outDir, 'paper-state.json');
try {
  const saved = JSON.parse(await readFile(statePath, 'utf8')) as { consumed?: [string, number][] };
  for (const [k, t] of saved.consumed ?? []) if (startMs - t < 6 * 3_600_000) arb.consumed.set(k, t);
} catch {
  /* first session */
}

// 3. Run.
let refreshes = 0;
const refreshFailures: Record<string, number> = {};
const endAt = startMs + minutes * 60_000;
while (Date.now() < endAt) {
  await new Promise((r) => setTimeout(r, refreshMs));
  refreshes += 1;
  for (const r of live.state.lastRefresh) if (!r.ok) refreshFailures[r.venue] = (refreshFailures[r.venue] ?? 0) + 1;
  await arb.tick().catch((e: Error) => console.error('tick failed:', e.message));
}
live.stop();

// 4. Record.
const events = arb.events.filter((e) => e.atMs >= startMs);
const skipped: Record<string, number> = {};
for (const e of events) if (e.action === 'skipped') skipped[e.reason ?? 'unknown'] = (skipped[e.reason ?? 'unknown'] ?? 0) + 1;
const fills = events.filter((e) => e.action === 'filled');
const line: SessionLine = {
  start: new Date(startMs).toISOString(),
  end: new Date().toISOString(),
  minutes,
  rpcs: vetting.ok.map(redactRpc),
  rpcRejected: vetting.rejected,
  rpcRequests: venues.reader.requests,
  refreshes,
  refreshFailures,
  graphEdges: live.state.graph.size(),
  opportunities: events.length,
  fills: fills.length,
  skipped,
  pnlUsd: fills.reduce((s, e) => s + e.netUsd, 0),
  fillsDetail: fills.map((e) => ({ at: new Date(e.atMs).toISOString(), path: e.path, venues: e.venues, sizeUsd: e.sizeUsd, netBps: e.netBps, netUsd: e.netUsd, txCount: e.txCount })),
};
await appendFile(join(outDir, 'paper-log.jsonl'), `${JSON.stringify(line)}\n`);
await writeFile(statePath, JSON.stringify({ consumed: [...arb.consumed.entries()] }));
await writeFile(join(outDir, 'paper-summary.md'), summarize(await readFile(join(outDir, 'paper-log.jsonl'), 'utf8')));
console.log(`session done: ${refreshes} refreshes, ${line.rpcRequests} RPC requests, ${line.opportunities} opportunities, ${line.fills} paper fills, $${line.pnlUsd.toFixed(4)}`);
process.exit(0);

function summarize(jsonl: string): string {
  const s = jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as SessionLine);
  const sum = (f: (x: SessionLine) => number) => s.reduce((a, x) => a + f(x), 0);
  const hours = sum((x) => x.minutes) / 60;
  const fills = s.flatMap((x) => x.fillsDetail);
  const byCycle = new Map<string, { n: number; usd: number; bps: number[] }>();
  for (const f of fills) {
    const k = `${f.path} (${f.venues.join(', ')})`;
    const c = byCycle.get(k) ?? { n: 0, usd: 0, bps: [] };
    c.n += 1;
    c.usd += f.netUsd;
    c.bps.push(f.netBps);
    byCycle.set(k, c);
  }
  const skipped: Record<string, number> = {};
  for (const x of s) for (const [k, v] of Object.entries(x.skipped)) skipped[k] = (skipped[k] ?? 0) + v;
  const pnl = sum((x) => x.pnlUsd);
  const days = s.length ? (Date.parse(s.at(-1)!.end) - Date.parse(s[0]!.start)) / 86_400_000 : 0;
  return [
    '# fisika paper trading record',
    '',
    `${s.length} sessions over ${days.toFixed(1)} days (${hours.toFixed(1)} hours watched), ${s[0]?.start ?? '—'} to ${s.at(-1)?.end ?? '—'}. Live Celo prices on free RPCs, nothing signed.`,
    '',
    '| | |',
    '|---|---|',
    `| Opportunities that cleared the first check | ${sum((x) => x.opportunities)} |`,
    `| Paper fills (passed live re-quote and every risk limit) | ${fills.length} |`,
    `| Paper P&L | $${pnl.toFixed(4)} |`,
    `| P&L per watched hour | $${hours ? (pnl / hours).toFixed(4) : '0'} |`,
    `| RPC requests | ${sum((x) => x.rpcRequests).toLocaleString('en-US')} (${hours ? Math.round(sum((x) => x.rpcRequests) / (hours * 3600) * 100) / 100 : 0}/s) |`,
    `| Venue refresh failures | ${JSON.stringify(s.reduce<Record<string, number>>((a, x) => { for (const [k, v] of Object.entries(x.refreshFailures)) a[k] = (a[k] ?? 0) + v; return a; }, {}))} |`,
    '',
    '## Fills by cycle',
    '',
    '| Cycle | Fills | Paper P&L | Median edge |',
    '|---|---|---|---|',
    ...[...byCycle.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([k, c]) => `| ${k} | ${c.n} | $${c.usd.toFixed(4)} | ${c.bps.sort((x, y) => x - y)[Math.floor(c.bps.length / 2)]!.toFixed(1)} bps |`),
    '',
    '## Why opportunities were skipped',
    '',
    ...Object.entries(skipped).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Sessions',
    '',
    '| Start | Min | RPCs | Requests | Opps | Fills | P&L |',
    '|---|---|---|---|---|---|---|',
    ...s.slice(-48).reverse().map((x) => `| ${x.start.slice(0, 16).replace('T', ' ')} | ${x.minutes} | ${x.rpcs.join(', ')} | ${x.rpcRequests} | ${x.opportunities} | ${x.fills} | $${x.pnlUsd.toFixed(4)} |`),
  ].join('\n');
}
