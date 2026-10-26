'use client';
import { usePoll } from '@/lib/api';

type Stats = { uptimeSec: number; calls: Record<string, number>; paidCalls: number; revenueUsdc: number; freeTierCalls: number; topPayers: { payer: string; calls: number }[] };

export default function AgentsPage() {
  const stats = usePoll<Stats>('v1/stats', 10_000);
  const health = usePoll<{ executionEnabled: boolean }>('health', 30_000);
  const s = stats.data;
  const served = s ? Object.entries(s.calls).filter(([k]) => k.includes('/v1/')).reduce((a, [, n]) => a + n, 0) : 0;
  return (
    <>
      <h1>For agents and apps</h1>
      <p className="lede">
        Other agents can buy quotes and ready-to-sign swaps from fisika over HTTP, paying per call in USDC on Celo with x402. fisika is listed in the ERC-8004 registry on Celo, where callers can leave on-chain feedback.
      </p>
      {s ? (
        <div className="stats">
          <div className="stat"><b className="num">{served.toLocaleString('en-US')}</b><span>API calls served</span></div>
          <div className="stat"><b className="num">{s.paidCalls.toLocaleString('en-US')}</b><span>Paid with x402</span></div>
          <div className="stat"><b className="num">{s.revenueUsdc.toFixed(3)} USDC</b><span>x402 revenue</span></div>
          <div className="stat"><b className="num">{s.freeTierCalls}</b><span>Free-tier calls</span></div>
          <div className="stat"><b>{health.data?.executionEnabled ? 'Quotes + swaps' : 'Quotes only'}</b><span>Mode</span></div>
        </div>
      ) : stats.error ? (
        <p className="err">{stats.error}</p>
      ) : null}

      <h2>Top paying agents</h2>
      {s?.topPayers.length ? (
        <table className="board" style={{ maxWidth: 640 }}>
          <thead>
            <tr><th scope="col">Payer</th><th scope="col">Paid calls</th></tr>
          </thead>
          <tbody>
            {s.topPayers.map((p) => (
              <tr key={p.payer}>
                <td><a href={`https://celoscan.io/address/${p.payer}`} target="_blank" rel="noreferrer">{p.payer.slice(0, 10)}…{p.payer.slice(-6)}</a></td>
                <td>{p.calls}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No paid calls yet.</p>
      )}

      <h2>Calling the API</h2>
      <p className="muted">A paid call returns HTTP 402 with payment requirements in the PAYMENT-REQUIRED header. Any x402 client pays and retries automatically.</p>
      <pre className="panel num" style={{ overflowX: 'auto', fontSize: 12 }}>{`import { wrapFetchWithPayment } from '@x402/fetch';

const pay = wrapFetchWithPayment(fetch, celoWallet); // USDC on Celo (eip155:42220)
const quote = await pay('<API>/v1/quote', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tokenIn: 'cNGN', tokenOut: 'USDT', amount: '50000' }),
}).then((r) => r.json());
// quote.quoteId, quote.amountOut, quote.minOut, quote.paths …`}</pre>
      <dl className="kv" style={{ maxWidth: 560 }}>
        <dt>Quote</dt><dd>POST /v1/quote · 0.001 USDC</dd>
        <dt>Swap transactions</dt><dd>POST /v1/build · 0.001 USDC + 0.1% in-swap</dd>
        <dt>Free</dt><dd>/v1/board, /v1/pairs, /v1/receipts</dd>
        <dt>Registration file</dt><dd>/.well-known/agent-registration.json</dd>
        <dt>Spec</dt><dd>/openapi.json</dd>
      </dl>
    </>
  );
}
