'use client';
import { useState } from 'react';
import { api, fmtUsd, usePoll, VENUE_LABEL, ago } from '@/lib/api';

type ArbStatus = {
  mode: string;
  wallet?: string;
  balances?: Record<string, number | null>;
  lastSkip?: Record<string, number>;
  killed: boolean;
  halted: boolean;
  haltReason: string | null;
  detected: number;
  filled: number;
  winRate: number | null;
  realizedUsd: number;
  todayUsd: number;
  limits: { maxTradeUsd: number; minEdgeBps: number; minEdgeUsd: number; dailyLossLimitUsd: number; maxTokenExposureUsd: number };
  events: { atMs: number; action: string; reason?: string; path: string; venues: string[]; sizeUsd: number; netBps: number; netUsd: number; txCount: number; indicativeLegs: number; txs?: string[] }[];
  equity: { atMs: number; equityUsd: number; baselineUsd: number }[];
};

const REASON: Record<string, string> = {
  edge_bps_below_min: 'edge below minimum (bps)',
  edge_usd_below_min: 'edge below minimum ($)',
  size_above_max: 'size above cap',
  inventory_exposure: 'would hold too much of one token between transactions',
  stale_edge: 'price too old',
  kill_switch: 'kill switch on',
  requote_failed: 'a leg could not be re-quoted',
  already_filled_prices_unchanged: 'already filled at these prices',
};

export default function ArbPage() {
  const { data, error, reload } = usePoll<ArbStatus>('v1/arb', 5_000);
  return (
    <>
      <h1>Arbitrage engine</h1>
      <p className="lede">
        Scans every venue for loops that end with more dollars than they started with, re-quotes each leg live, then applies the risk limits.{' '}
        {data?.mode === 'LIVE' ? 'This engine trades real money from its own wallet. Profit and loss are measured from the wallet balance.' : 'This deployment runs in paper mode: nothing is signed or sent.'}
      </p>
      {error && !data ? <p className="err">{error}</p> : null}
      {data ? (
        <>
          <div className="stats">
            <div className="stat"><b>{data.mode === 'PAPER' ? 'Paper' : 'Live'}</b><span>{data.killed ? 'Kill switch on' : data.halted ? `Halted: ${data.haltReason}` : 'Running'}</span></div>
            {data.mode === 'LIVE' ? (
              <div className="stat"><b className="num">{data.balances ? Object.entries(data.balances).map(([k, v]) => `${v === null ? '—' : v.toFixed(k === 'CELO' ? 2 : 2)} ${k}`).join(' · ') : '—'}</b><span>Wallet <a href={`https://celoscan.io/address/${data.wallet}`} target="_blank" rel="noreferrer">{data.wallet?.slice(0, 8)}…</a></span></div>
            ) : (
              <div className="stat"><b className="num">{data.detected}</b><span>Cycles evaluated</span></div>
            )}
            <div className="stat"><b className="num">{data.filled}</b><span>{data.mode === 'LIVE' ? 'Trades' : 'Paper fills'}</span></div>
            <div className="stat"><b className="num">{data.winRate === null ? '—' : `${Math.round(data.winRate * 100)}%`}</b><span>Win rate</span></div>
            <div className="stat"><b className={`num ${data.realizedUsd >= 0 ? 'ok' : ''}`}>{fmtUsd(data.realizedUsd, 4)}</b><span>{data.mode === 'LIVE' ? 'Realized P&L' : 'P&L since start'}</span></div>
          </div>
          <Equity points={data.equity} live={data.mode === 'LIVE'} />
          <KillSwitch killed={data.killed} onChange={reload} />
          <h2>Recent decisions</h2>
          <div className="scroll">
            <table className="board">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Cycle</th>
                  <th scope="col">Size</th>
                  <th scope="col">Net</th>
                  <th scope="col">Net $</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data.events.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">No profitable loops found yet. On thin Celo liquidity that is the normal state; the engine checks again every few seconds.</td>
                  </tr>
                ) : (
                  data.events.slice(0, 40).map((e, i) => (
                    <tr key={i}>
                      <td>{ago(e.atMs)}</td>
                      <td style={{ textAlign: 'left' }}>
                        {e.path} <span className="venues">{e.venues.map((v) => VENUE_LABEL[v] ?? v).join(', ')}</span>
                        {e.txCount > 1 ? <span className="tag warn">{e.txCount} txs</span> : null}
                      </td>
                      <td>${e.sizeUsd}</td>
                      <td>{e.netBps.toFixed(1)} bps</td>
                      <td>{fmtUsd(e.netUsd, 4)}</td>
                      <td style={{ textAlign: 'left' }} className={e.action === 'filled' ? 'ok' : 'muted'}>
                        {e.action === 'filled' ? (data.mode === 'LIVE' ? 'Traded' : 'Paper fill') : `${data.mode === 'LIVE' ? 'Not traded' : 'Skipped'}: ${REASON[e.reason ?? ''] ?? e.reason}`}
                        {e.txs?.length ? <> · <a href={`https://celoscan.io/tx/${e.txs.at(-1)}`} target="_blank" rel="noreferrer">tx</a></> : null}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <h2>Limits in force</h2>
          <dl className="kv" style={{ maxWidth: 420 }}>
            <dt>Largest trade</dt><dd>${data.limits.maxTradeUsd}</dd>
            <dt>Minimum edge</dt><dd>{data.limits.minEdgeBps} bps and ${data.limits.minEdgeUsd}</dd>
            <dt>Daily loss before halting</dt><dd>${data.limits.dailyLossLimitUsd}</dd>
            <dt>Most held of one token between txs</dt><dd>${data.limits.maxTokenExposureUsd}</dd>
          </dl>
        </>
      ) : null}
    </>
  );
}

function Equity({ points, live }: { points: ArbStatus['equity']; live?: boolean }) {
  if (points.length < 2) return <p className="muted">{live ? 'The profit curve appears after the second trade.' : 'The equity curve appears after the first minute of running.'}</p>;
  const W = 760, H = 140, pad = 6;
  const ys = points.flatMap((p) => [p.equityUsd, p.baselineUsd]);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const t0 = points[0]!.atMs, t1 = points.at(-1)!.atMs, tspan = t1 - t0 || 1;
  const x = (t: number) => pad + ((t - t0) / tspan) * (W - pad * 2);
  const y = (v: number) => H - pad - ((v - lo) / span) * (H - pad * 2);
  const line = (k: 'equityUsd' | 'baselineUsd') => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.atMs).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  return (
    <figure className="panel" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Paper equity versus holding dollars">
        <path d={line('baselineUsd')} fill="none" stroke="var(--dim)" strokeDasharray="4 4" />
        <path d={line('equityUsd')} fill="none" stroke="var(--amber)" strokeWidth="2" />
      </svg>
      <figcaption className="muted">{live ? 'Cumulative realized profit after gas (amber) against zero (dashed).' : 'Paper equity (amber) against simply holding the starting dollars (dashed).'}</figcaption>
    </figure>
  );
}

function KillSwitch({ killed, onChange }: { killed: boolean; onChange: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  async function toggle() {
    const token = window.prompt('Admin token for the kill switch');
    if (!token) return;
    try {
      await api('v1/admin/kill', { method: 'POST', body: { on: !killed }, auth: token });
      setMsg(killed ? 'Engine resumed.' : 'Engine stopped. No new trades will be attempted.');
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <p style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
      <button className={`danger ${killed ? 'on' : ''}`} onClick={toggle} aria-pressed={killed}>
        {killed ? 'Resume engine' : 'Stop engine'}
      </button>
      <span className="muted">{msg ?? 'Stops the engine immediately. Pausing the on-chain executor is a separate guardian-key action.'}</span>
    </p>
  );
}
