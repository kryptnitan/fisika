'use client';
import { useMemo, useState } from 'react';
import { api, fmtRate, usePoll, VENUE_LABEL, ago } from '@/lib/api';
import { connect, sendTx, waitForTx } from '@/lib/wallet';

type Size = { usd: number; rate: number | null; venues?: string[]; hops?: number; split?: boolean; execution?: string; firm?: boolean; directByVenue?: { venue: string; rate: number }[] };
type Row = { corridor: string; from: string; to: string; sizes: Size[]; spreadBps: number | null };
type Board = { asOf: string; block: string; rows: Row[] };
type Heat = { samples: { atMs: number; depth: Record<string, Record<string, number>>; maxSampledUsd?: number }[] };

export default function RatesPage() {
  const board = usePoll<Board>('v1/board', 5_000);
  const heat = usePoll<Heat>('v1/heatmap?limit=60', 60_000);
  const [pick, setPick] = useState<{ from: string; to: string }>({ from: 'cNGN', to: 'USDT' });

  return (
    <>
      <h1>Stablecoin FX on Celo</h1>
      <p className="lede">
        The best rate for each currency pair right now, at three order sizes. fisika checks every venue, splits large orders and takes multi-hop paths when they pay more.
      </p>
      <div className="grid">
        <section aria-label="Live rates">
          <BoardTable board={board.data} error={board.error} onPick={setPick} selected={`${pick.from}-${pick.to}`} />
          <Heatmap data={heat.data} />
        </section>
        <Ticket key={`${pick.from}-${pick.to}`} initial={pick} tokens={board.data ? [...new Set(board.data.rows.flatMap((r) => [r.from, r.to]))] : []} />
      </div>
    </>
  );
}

function BoardTable({ board, error, onPick, selected }: { board: Board | null; error: string | null; onPick: (p: { from: string; to: string }) => void; selected: string }) {
  if (error && !board) return <p className="err">{error}</p>;
  if (!board) return <p className="muted">Loading live rates from Celo…</p>;
  return (
    <div className="scroll">
      <table className="board">
        <caption className="muted" style={{ textAlign: 'left', padding: '0 0 8px', fontFamily: 'var(--sans)' }}>
          Output per 1 unit sold, after venue fees. Updated {ago(board.asOf)}. Select a pair to quote it.
        </caption>
        <thead>
          <tr>
            <th scope="col">Pair</th>
            <th scope="col">$10</th>
            <th scope="col">$100</th>
            <th scope="col">$1,000</th>
            <th scope="col">Route at $100</th>
            <th scope="col">Venue spread</th>
          </tr>
        </thead>
        <tbody>
          {board.rows.map((r) => {
            const s100 = r.sizes[1];
            return (
              <tr key={r.corridor} className={r.corridor === selected ? 'selected' : undefined}>
                <td>
                  <button className="pair" style={{ all: 'unset', cursor: 'pointer' }} onClick={() => onPick({ from: r.from, to: r.to })} aria-label={`Quote ${r.from} to ${r.to}`}>
                    <span className="pair">
                      {r.from}
                      <span className="arrow">→</span>
                      {r.to}
                    </span>
                  </button>
                </td>
                {r.sizes.map((s) => (
                  <td key={s.usd}>{fmtRate(s.rate)}</td>
                ))}
                <td className="venues">
                  {s100?.venues?.map((v) => VENUE_LABEL[v] ?? v).join(' + ') ?? '—'}
                  {s100?.split ? <span className="tag">split</span> : null}
                  {s100 && s100.hops && s100.hops > 1 ? <span className="tag">{s100.hops} hops</span> : null}
                  {s100?.execution && s100.execution !== 'atomic' ? <span className="tag warn">{s100.execution === 'multi-tx' ? '2+ txs' : 'RFQ'}</span> : null}
                </td>
                <td>{r.spreadBps === null ? '—' : `${r.spreadBps.toFixed(0)} bps`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Heatmap({ data }: { data: Heat | null }) {
  const latest = data?.samples.at(-1);
  const venues = useMemo(() => {
    const set = new Set<string>();
    for (const row of Object.values(latest?.depth ?? {})) for (const v of Object.keys(row)) set.add(v);
    return [...set];
  }, [latest]);
  if (!latest) return null;
  const max = Math.max(1, ...Object.values(latest.depth).flatMap((r) => Object.values(r)));
  return (
    <>
      <h2>Where the liquidity sits</h2>
      <p className="muted">Largest order each venue can fill directly for a pair, in dollars; $10k+ means at least the largest size fisika tests. Brighter means deeper. Sampled every minute.</p>
      <div className="scroll">
        <table className="board heat">
          <thead>
            <tr>
              <th scope="col">Pair</th>
              {venues.map((v) => (
                <th key={v} scope="col">
                  {VENUE_LABEL[v] ?? v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(latest.depth)
              .filter(([, r]) => Object.keys(r).length)
              .map(([pair, r]) => (
                <tr key={pair}>
                  <td className="pair">{pair.replace('-', ' → ')}</td>
                  {venues.map((v) => {
                    const d = r[v];
                    const a = d ? 0.12 + 0.88 * Math.sqrt(d / max) : 0;
                    return (
                      <td key={v} className="cell">
                        <span className="swatch" style={{ background: d ? `rgba(233,185,73,${a.toFixed(2)})` : 'transparent', color: a > 0.55 ? 'var(--amber-ink)' : undefined }}>
                          {d ? `$${d >= 1000 ? `${Math.round(d / 1000)}k` : d}${v !== 'textile' && d >= (latest.maxSampledUsd ?? Infinity) ? '+' : ''}` : ''}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

type QuoteView = {
  quoteId: string;
  tokenIn: { symbol: string };
  tokenOut: { symbol: string };
  amountIn: string;
  amountOut: string;
  minOut: string;
  rate: number;
  serviceFee: string;
  serviceFeeBps: number;
  gasUsd: number;
  execution: string;
  txCount: number;
  firm: boolean;
  paths: { amountIn: string; hops: { venue: string; from: string; to: string; amountOut: string }[] }[];
  expiresAt: string;
};

function Ticket({ initial, tokens }: { initial: { from: string; to: string }; tokens: string[] }) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [amount, setAmount] = useState('50000');
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const list = tokens.length ? tokens : [from, to];

  async function getQuote() {
    setErr(null);
    setDone(null);
    setBusy('Finding the best route…');
    try {
      setQuote(await api<QuoteView>('v1/quote', { method: 'POST', body: { tokenIn: from, tokenOut: to, amount } }));
    } catch (e) {
      setQuote(null);
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function swap() {
    if (!quote) return;
    setErr(null);
    try {
      setBusy('Connecting wallet…');
      const account = await connect();
      setBusy('Preparing transactions…');
      const built = await api<{ txs: { to: string; data: string; value: string; description: string }[] }>('v1/build', { method: 'POST', body: { quoteId: quote.quoteId, taker: account } });
      let last = '';
      for (const [i, tx] of built.txs.entries()) {
        setBusy(`Confirm transaction ${i + 1} of ${built.txs.length} in your wallet…`);
        last = await sendTx(account, tx);
        setBusy(`Waiting for transaction ${i + 1} to be mined…`);
        if ((await waitForTx(last)) !== 'success') throw new Error(`Transaction ${i + 1} reverted; nothing further was sent.`);
      }
      const receipt = await api<{ realizedOut: string; tokenOut: string; explorer: string }>('v1/receipts', { method: 'POST', body: { quoteId: quote.quoteId, txHash: last } });
      setDone(`Swapped. You received ${receipt.realizedOut} ${receipt.tokenOut}.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <aside className="panel ticket" aria-label="Swap">
      <h2>Swap</h2>
      <div className="row">
        <div className="field">
          <label htmlFor="from">You sell</label>
          <select id="from" value={from} onChange={(e) => (setFrom(e.target.value), setQuote(null))}>
            {list.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="to">You get</label>
          <select id="to" value={to} onChange={(e) => (setTo(e.target.value), setQuote(null))}>
            {list.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="amt">Amount of {from}</label>
        <input id="amt" className="big" inputMode="decimal" value={amount} onChange={(e) => (setAmount(e.target.value.replace(/[^\d.]/g, '')), setQuote(null))} />
      </div>
      <button className="primary" onClick={getQuote} disabled={!!busy || !amount || from === to}>
        Get quote
      </button>

      {quote ? (
        <div style={{ marginTop: 18 }}>
          <div className="muted">You receive about</div>
          <div className="out">
            {Number(quote.amountOut).toLocaleString('en-US', { maximumFractionDigits: 6 })} {quote.tokenOut.symbol}
          </div>
          <div className="muted num">1 {quote.tokenIn.symbol} = {fmtRate(quote.rate)} {quote.tokenOut.symbol}</div>
          <dl className="kv">
            <dt>Guaranteed minimum</dt>
            <dd>
              {Number(quote.minOut).toLocaleString('en-US', { maximumFractionDigits: 6 })} {quote.tokenOut.symbol}
            </dd>
            <dt>fisika fee</dt>
            <dd>{quote.serviceFeeBps ? `${quote.serviceFeeBps / 100}%` : 'None'}</dd>
            <dt>Network gas</dt>
            <dd>{quote.gasUsd < 0.01 ? '< $0.01' : `$${quote.gasUsd.toFixed(2)}`}</dd>
            <dt>Transactions</dt>
            <dd>{quote.execution === 'atomic' ? '1 swap (all or nothing)' : `${quote.txCount}, includes a Textile RFQ leg`}</dd>
          </dl>
          <ul className="hops">
            {quote.paths.map((p, i) => (
              <li key={i}>
                {p.amountIn} via {p.hops.map((h) => `${VENUE_LABEL[h.venue] ?? h.venue} ${h.from}→${h.to}`).join(', ')}
              </li>
            ))}
          </ul>
          {!quote.firm ? <p className="muted">Part of this route is an indicative RFQ price; the maker confirms the final price before you sign.</p> : null}
          <button className="primary" style={{ marginTop: 14 }} onClick={swap} disabled={!!busy}>
            Swap with my wallet
          </button>
        </div>
      ) : null}
      {busy ? <p className="muted" role="status">{busy}</p> : null}
      {err ? <p className="err" role="alert">{err}</p> : null}
      {done ? <p className="ok" role="status">{done}</p> : null}
    </aside>
  );
}
