/**
 * Turns a meme desk data directory (after a `MEME_SESSION_MINUTES=…` run) into a markdown report.
 * Run: MEME_DATA_DIR=/tmp/meme node scripts/meme-session-report.ts   → verification/meme-session.md
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const dir = process.env.MEME_DATA_DIR ?? '/tmp/meme';
const status = JSON.parse(await readFile(`${dir}/meme-status.json`, 'utf8')) as {
  mode: string;
  updatedAt: string;
  paused: boolean;
  halted: boolean;
  equityUsd: number;
  startEquityUsd: number;
  cashUsd: number;
  dayPnlUsd: number;
  dayLossPct: number;
  stats: { trades: number; wins: number; realizedUsd: number; scans: number; candidates: number };
  watching: number;
  positions: { symbol: string; pair: string; openedAt: string; costUsd: number; valueUsd: number; pnlPct: number }[];
  rules: Record<string, number>;
  recent: { at: string; symbol: string; action: string; reason: string; usd?: number }[];
};
let ledger: { at: string; symbol: string; heldMin: number; costUsd: number; proceedsUsd: number; pnlUsd: number; pnlPct: number; reason: string }[] = [];
try {
  ledger = (await readFile(`${dir}/meme-ledger.jsonl`, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
} catch {
  /* no closed trades */
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const r = status.rules;
const L: string[] = [];
L.push(`# Meme desk session (${status.mode})`);
L.push('');
L.push(`Reported ${status.updatedAt}. Paper equity ${usd(status.equityUsd)} (start ${usd(status.startEquityUsd)}, cash ${usd(status.cashUsd)}). Day P&L ${usd(status.dayPnlUsd)}, loss used ${status.dayLossPct.toFixed(2)}% of ${r.dailyLossPct}%. ${status.halted ? '**Halted by the daily loss limit.**' : ''}`);
L.push('');
L.push(`Rules: size ${r.sizePct}% ($${r.minTradeUsd}–$${r.maxTradeUsd}), stop −${r.stopLossPct}%, trail ${r.trailPct}% after +${r.trailActivatePct}%, ATH zone ${r.athZonePct}%, max hold ${r.maxHoldMin} min, max ${r.maxOpen} open.`);
L.push('');
L.push(`Scans ${status.stats.scans} · candidates passing the screen ${status.stats.candidates} · tokens watched ${status.watching} · closed ${status.stats.trades} (${status.stats.wins} wins) · realized ${usd(status.stats.realizedUsd)} · open ${status.positions.length}`);
L.push('');
if (status.positions.length) {
  L.push('## Open at the end of the session');
  L.push('');
  L.push('| Token | Opened | Cost | Value | P&L |');
  L.push('|---|---|---|---|---|');
  for (const p of status.positions) L.push(`| [${p.symbol}](https://dexscreener.com/solana/${p.pair}) | ${p.openedAt} | ${usd(p.costUsd)} | ${usd(p.valueUsd)} | ${p.pnlPct.toFixed(1)}% |`);
  L.push('');
}
if (ledger.length) {
  L.push('## Closed trades');
  L.push('');
  L.push('| Closed | Token | Held | Cost | Back | P&L | Exit |');
  L.push('|---|---|---|---|---|---|---|');
  for (const t of ledger) L.push(`| ${t.at} | ${t.symbol} | ${t.heldMin} min | ${usd(t.costUsd)} | ${usd(t.proceedsUsd)} | ${usd(t.pnlUsd)} (${t.pnlPct.toFixed(1)}%) | ${t.reason} |`);
  L.push('');
}
L.push('## Last decisions');
L.push('');
const skips = new Map<string, number>();
for (const d of status.recent) if (d.action === 'skip') skips.set(d.reason, (skips.get(d.reason) ?? 0) + 1);
if (skips.size) L.push(`Skip reasons: ${[...skips.entries()].map(([k, v]) => `${k} ×${v}`).join(', ')}`);
L.push('');
for (const d of status.recent.slice(0, 25)) L.push(`- ${d.at} ${d.action} ${d.symbol}: ${d.reason}${d.usd !== undefined ? ` (${usd(d.usd)})` : ''}`);
L.push('');
L.push('Paper mode: real DexScreener prices, Jupiter quotes and on-chain mint checks; fills are simulated at the quoted amounts. Nothing was signed or sent.');

await mkdir('verification', { recursive: true });
await writeFile('verification/meme-session.md', L.join('\n'));
console.log(L.join('\n'));
