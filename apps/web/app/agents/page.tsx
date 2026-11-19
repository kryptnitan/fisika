'use client';
import { usePoll } from '@/lib/api';
import { allows, Gate, useSession } from '../session';

type Stats = { uptimeSec: number; calls: Record<string, number>; paidCalls: number; revenueUsdc: number; freeTierCalls: number; topPayers: { payer: string; calls: number }[] };

export default function AgentsPage() {
  return (
    <Gate need="member" title="For agents and apps">
      <AgentsInner />
    </Gate>
  );
}

function AgentsInner() {
  const { session } = useSession();
  const health = usePoll<{ executionEnabled: boolean; serviceFeeBps?: number }>('health', 30_000);
  return (
    <>
      <h1>For agents and apps</h1>
      <p className="lede">
        Other agents can buy quotes and ready-to-sign swaps on Celo or BNB Chain from fisika over HTTP, paying per call in USDC on Celo with x402. fisika publishes an ERC-8004 identity on Celo, so callers can find it and leave on-chain feedback.
      </p>
      {allows(session, 'owner') ? <OwnerStats executionEnabled={!!health.data?.executionEnabled} /> : null}
      <Docs serviceFeeBps={health.data?.serviceFeeBps} />
    </>
  );
}

/** Calls served, x402 revenue and who pays: the owner's business numbers. */
function OwnerStats({ executionEnabled }: { executionEnabled: boolean }) {
  const stats = usePoll<Stats>('v1/stats', 10_000);
  const s = stats.data;
  const served = s ? Object.entries(s.calls).filter(([k]) => k.includes('/v1/')).reduce((a, [, n]) => a + n, 0) : 0;
  return (
    <>
      {s ? (
        <div className="stats">
          <div className="stat"><b className="num">{served.toLocaleString('en-US')}</b><span>API calls served</span></div>
          <div className="stat"><b className="num">{s.paidCalls.toLocaleString('en-US')}</b><span>Paid with x402</span></div>
          <div className="stat"><b className="num">{s.revenueUsdc.toFixed(3)} USDC</b><span>x402 revenue</span></div>
          <div className="stat"><b className="num">{s.freeTierCalls}</b><span>Free-tier calls</span></div>
          <div className="stat"><b>{executionEnabled ? 'Quotes + swaps' : 'Quotes only'}</b><span>Mode</span></div>
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
    </>
  );
}

function Docs({ serviceFeeBps }: { serviceFeeBps?: number }) {
  return (
    <>
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
        <dt>Swap transactions</dt><dd>POST /v1/build · 0.001 USDC{serviceFeeBps ? ` + ${serviceFeeBps / 100}% of the swap` : ', no cut of the swap'}</dd>
        <dt>Free</dt><dd>/v1/board, /v1/pairs, /v1/receipts/&#123;id&#125;, /v1/chains</dd>
        <dt>BNB Chain</dt><dd>Same routes under /bsc (POST /bsc/v1/quote); payment is still USDC on Celo</dd>
        <dt>Registration file</dt><dd>/.well-known/agent-registration.json</dd>
        <dt>Spec</dt><dd>/openapi.json</dd>
      </dl>
    </>
  );
}
