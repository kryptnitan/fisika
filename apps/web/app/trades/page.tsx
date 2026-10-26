'use client';
import { fmtRate, usePoll } from '@/lib/api';

type Receipt = {
  id: string;
  txHash: string;
  status: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  quotedOut: string;
  realizedOut: string | null;
  quotedRate: number;
  realizedRate: number | null;
  slippageVsQuoteBps: number | null;
  route: { venue: string }[][];
  explorer: string;
  hash: string;
};

export default function TradesPage() {
  const { data, error } = usePoll<Receipt[]>('v1/receipts?limit=100', 10_000);
  return (
    <>
      <h1>Trades</h1>
      <p className="lede">
        Every swap executed through fisika, with the rate it was quoted and the rate it got. Each receipt is checked against the transaction on Celo and carries a hash of its contents so it can be verified independently.
      </p>
      {error && !data ? <p className="err">{error}</p> : null}
      <div className="scroll">
        <table className="board">
          <thead>
            <tr>
              <th scope="col">Trade</th>
              <th scope="col">Sold</th>
              <th scope="col">Quoted rate</th>
              <th scope="col">Got</th>
              <th scope="col">vs quote</th>
              <th scope="col">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {!data?.length ? (
              <tr>
                <td colSpan={6} className="muted">No trades yet. Swaps made from the Rates page appear here once they are mined.</td>
              </tr>
            ) : (
              data.map((r) => (
                <tr key={r.id}>
                  <td className="pair">
                    {r.tokenIn}
                    <span className="arrow">→</span>
                    {r.tokenOut}
                  </td>
                  <td>{r.amountIn}</td>
                  <td>{fmtRate(r.quotedRate)}</td>
                  <td>{r.status === 'filled' ? fmtRate(r.realizedRate) : <span className="err">reverted</span>}</td>
                  <td className={r.slippageVsQuoteBps !== null && r.slippageVsQuoteBps <= 0 ? 'ok' : undefined}>
                    {r.slippageVsQuoteBps === null ? '—' : `${r.slippageVsQuoteBps > 0 ? '−' : '+'}${Math.abs(r.slippageVsQuoteBps).toFixed(1)} bps`}
                  </td>
                  <td>
                    <a href={r.explorer} target="_blank" rel="noreferrer">
                      {r.txHash.slice(0, 10)}…
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
