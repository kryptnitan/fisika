'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { createSiweMessage } from 'viem/siwe';
import { encodeFunctionData, erc20Abi, getAddress, parseUnits } from 'viem';
import { agentApi, AgentError, type AgentConfig, type AgentState, type Balances, type EventRow, type Paged, type TradeRow } from '@/lib/agent';
import { UI_CHAINS } from '@/lib/chain';
import { connect, sendTx, signMessage, waitForTx } from '@/lib/wallet';

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const usd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 4 : 2 })}`);
const num = (s: string | null | undefined) => (s === null || s === undefined ? '—' : Number(s).toLocaleString('en-US', { maximumFractionDigits: 6 }));

export default function AgentPage() {
  const [session, setSession] = useState<{ address: string } | null | 'loading'>('loading');
  const [configured, setConfigured] = useState(true);

  const check = useCallback(async () => {
    try {
      setSession(await agentApi<{ address: string }>('session'));
    } catch (e) {
      setSession(null);
      if (e instanceof AgentError && e.status === 404) setConfigured(false);
    }
  }, []);
  useEffect(() => void check(), [check]);

  return (
    <>
      <h1>My agent</h1>
      <p className="lede">The operator console: switch trading on and off, move funds in and out of the bot wallet, and see every trade. Only the owner wallet can sign in.</p>
      {session === 'loading' ? <p className="muted">Checking your session…</p> : session ? <Console owner={session.address} onSignOut={() => setSession(null)} /> : <SignIn configured={configured} onIn={(a) => setSession({ address: a })} />}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------- sign in */

function SignIn({ onIn, configured }: { onIn: (address: string) => void; configured: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setErr(null);
    setBusy(true);
    try {
      const account = await connect(UI_CHAINS.celo);
      const { nonce, configured: ok } = await agentApi<{ nonce: string; configured: boolean }>('nonce');
      if (!ok) throw new Error('The agent console is not set up on this server yet (OWNER_ADDRESS).');
      const message = createSiweMessage({
        address: getAddress(account),
        chainId: 42220,
        domain: window.location.host,
        uri: window.location.origin,
        version: '1',
        nonce,
        issuedAt: new Date(),
        expirationTime: new Date(Date.now() + 5 * 60_000),
        statement: 'Sign in to the fisika agent console. This does not send a transaction or cost gas.',
      });
      const signature = await signMessage(account, message);
      const r = await agentApi<{ address: string }>('login', { message, signature });
      onIn(r.address);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel signin">
      <h2>Sign in</h2>
      <p className="muted">Connect the owner wallet and sign a message. Signing proves you hold the wallet; it sends no transaction and costs no gas. The session lasts 30 minutes.</p>
      {!configured ? <p className="err">The console is not configured on this server.</p> : null}
      <button className="primary" type="button" onClick={go} disabled={busy}>
        {busy ? 'Check your wallet…' : 'Connect wallet and sign in'}
      </button>
      {err ? <p className="err">{err}</p> : null}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------- console */

function Console({ owner, onSignOut }: { owner: string; onSignOut: () => void }) {
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [state, setState] = useState<AgentState | null>(null);
  const [bal, setBal] = useState<Balances | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const guard = useCallback(
    async <T,>(p: Promise<T>) => {
      try {
        return await p;
      } catch (e) {
        if (e instanceof AgentError && e.status === 401) onSignOut();
        else setErr((e as Error).message);
        return null;
      }
    },
    [onSignOut],
  );
  const loadState = useCallback(async () => {
    const s = await guard(agentApi<AgentState>('state'));
    if (s) setState(s);
  }, [guard]);
  const loadBal = useCallback(async () => {
    const b = await guard(agentApi<Balances>('balances'));
    if (b) setBal(b);
  }, [guard]);

  useEffect(() => {
    void guard(agentApi<AgentConfig>('config')).then((c) => c && setCfg(c));
    void loadBal();
  }, [guard, loadBal]);
  useEffect(() => {
    void loadState();
    const t = setInterval(() => void loadState(), 4_000);
    return () => clearInterval(t);
  }, [loadState]);

  const refreshAll = () => {
    void loadState();
    void loadBal();
    setTick((x) => x + 1);
  };
  const signOut = async () => {
    await agentApi('logout', {}).catch(() => undefined);
    onSignOut();
  };

  return (
    <>
      <div className="agent-who">
        <span className="muted">
          Signed in as <span className="num">{short(owner)}</span>
        </span>
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </div>
      {err ? (
        <p className="err" role="alert">
          {err}{' '}
          <button type="button" className="linkish" onClick={() => setErr(null)}>
            dismiss
          </button>
        </p>
      ) : null}
      <Switches state={state} onChange={refreshAll} guard={guard} />
      <div className="agent-grid">
        <BalancesCard cfg={cfg} bal={bal} state={state} onRefresh={loadBal} />
        <Funding cfg={cfg} onDone={refreshAll} guard={guard} />
      </div>
      <History cfg={cfg} refreshKey={tick} guard={guard} />
    </>
  );
}

type Guard = <T>(p: Promise<T>) => Promise<T | null>;

const BADGE: Record<string, string> = { active: 'Active', pausing: 'Pausing…', paused: 'Paused', stopped: 'Stopped (kill file)' };

function Switches({ state, onChange, guard }: { state: AgentState | null; onChange: () => void; guard: Guard }) {
  const [busy, setBusy] = useState<string | null>(null);
  const set = async (target: 'all' | 'celo' | 'bsc', active: boolean) => {
    setBusy(target);
    await guard(agentApi('control', { target, active }));
    setBusy(null);
    onChange();
  };
  if (!state) return <section className="panel">Loading status…</section>;
  return (
    <section className="panel agent-switch" aria-label="Trading switch">
      <div className="agent-switch-main">
        <div>
          <span className={`badge ${state.status}`} role="status">
            {BADGE[state.status]}
          </span>
          <p className="muted">
            {state.active ? 'Opening new trades on every chain that is switched on.' : 'Opens no new trades. Quotes and monitoring keep running.'}
            {state.status === 'pausing' ? ' Finishing the loop already in flight, then stopping.' : ''}
          </p>
          {state.updatedAt ? (
            <p className="muted small">
              Last change {new Date(state.updatedAt).toLocaleString()} by {state.by?.startsWith('0x') ? short(state.by) : state.by}
            </p>
          ) : null}
        </div>
        <button type="button" className={`bigtoggle ${state.active ? 'on' : 'off'}`} aria-pressed={state.active} disabled={busy === 'all'} onClick={() => set('all', !state.active)}>
          <span className="knob" aria-hidden />
          {state.active ? 'Active' : 'Paused'}
        </button>
      </div>
      <div className="agent-chains">
        {state.chains.map((c) => (
          <div key={c.key} className="agent-chain">
            <label className="chk">
              <input type="checkbox" checked={c.switchOn} disabled={busy === c.key} onChange={(e) => set(c.key, e.target.checked)} />
              <b>{c.name}</b>
            </label>
            <span className={`badge small ${c.status}`}>{BADGE[c.status]}</span>
            <span className="muted small">
              {c.trader === 'online' ? (c.inFlight ? 'trade in flight' : 'trader running') : c.trader === 'offline' ? 'trader not responding' : c.trader === 'never_started' ? 'trader not started' : 'no trader configured'}
              {c.halted ? ` · halted: ${c.haltReason}` : ''}
              {c.pendingWithdrawals.length ? ` · ${c.pendingWithdrawals.length} withdrawal(s) pending` : ''}
            </span>
          </div>
        ))}
      </div>
      <p className="muted small">A chain trades only when the main switch and its own switch are both on. Pausing never cuts a loop in half: the one in flight finishes first. Server fallback: <code>sudo fisika pause</code> / <code>sudo fisika resume</code>.</p>
    </section>
  );
}

function BalancesCard({ cfg, bal, state, onRefresh }: { cfg: AgentConfig | null; bal: Balances | null; state: AgentState | null; onRefresh: () => void }) {
  return (
    <section className="panel">
      <div className="row-between">
        <h2>Balances</h2>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {!bal ? <p className="muted">Loading balances…</p> : null}
      {bal?.chains.map((b) => {
        const c = cfg?.chains.find((x) => x.key === b.key);
        return (
          <div key={b.key} className="bal-chain">
            <div className="row-between">
              <b>{c?.name ?? b.key}</b>
              <span className="muted small num">{b.wallet ? <a href={`${c?.explorer}/address/${b.wallet}`} target="_blank" rel="noreferrer">{short(b.wallet)}</a> : 'wallet unknown'}</span>
            </div>
            {b.error ? <p className="muted small">{b.error}</p> : null}
            {b.lowGas ? (
              <p className="err small">
                Low gas: under {b.lowGasBelow} {b.native?.symbol}. The bot stops trading on {c?.name} until you top it up.
              </p>
            ) : null}
            {b.native ? (
              <table className="board compact">
                <tbody>
                  <tr>
                    <td>{b.native.symbol} (gas)</td>
                    <td>{num(b.native.balance)}</td>
                    <td className="muted">{usd(b.native.usd)}</td>
                  </tr>
                  {b.tokens?.map((t) => (
                    <tr key={t.symbol}>
                      <td>{t.symbol}</td>
                      <td>{num(t.balance)}</td>
                      <td className="muted">{usd(t.usd)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="muted">Total</td>
                    <td />
                    <td>{usd(b.totalUsd)}</td>
                  </tr>
                </tbody>
              </table>
            ) : null}
          </div>
        );
      })}
      {state?.chains.some((c) => c.pendingWithdrawals.length) ? <p className="muted small">Pending withdrawals are sent by the trader between trades.</p> : null}
      {bal ? <p className="muted small">As of {new Date(bal.asOf).toLocaleTimeString()}</p> : null}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------- funding */

function Funding({ cfg, onDone, guard }: { cfg: AgentConfig | null; onDone: () => void; guard: Guard }) {
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit');
  return (
    <section className="panel">
      <div className="tabs" role="tablist">
        <button role="tab" type="button" aria-selected={tab === 'deposit'} onClick={() => setTab('deposit')}>
          Deposit
        </button>
        <button role="tab" type="button" aria-selected={tab === 'withdraw'} onClick={() => setTab('withdraw')}>
          Withdraw
        </button>
      </div>
      {!cfg ? <p className="muted">Loading…</p> : tab === 'deposit' ? <Deposit cfg={cfg} onDone={onDone} guard={guard} /> : <Withdraw cfg={cfg} onDone={onDone} guard={guard} />}
    </section>
  );
}

function useChainToken(cfg: AgentConfig) {
  const [chainKey, setChainKey] = useState<'celo' | 'bsc'>('celo');
  const ch = cfg.chains.find((c) => c.key === chainKey) ?? cfg.chains[0]!;
  const options = useMemo(() => [...ch.tokens.filter((t) => ['USDT', 'USDC', 'USDm', 'cNGN'].includes(t.symbol)), ...ch.tokens.filter((t) => !['USDT', 'USDC', 'USDm', 'cNGN'].includes(t.symbol))], [ch]);
  const [token, setToken] = useState('USDT');
  const tok = token === 'native' ? null : (options.find((t) => t.symbol === token) ?? options[0] ?? null);
  return { chainKey, setChainKey, ch, options, token, setToken, tok };
}

function ChainTokenPicker(p: ReturnType<typeof useChainToken> & { cfg: AgentConfig }) {
  return (
    <div className="two">
      <label>
        Chain
        <select value={p.chainKey} onChange={(e) => p.setChainKey(e.target.value as 'celo' | 'bsc')}>
          {p.cfg.chains.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Token
        <select value={p.token} onChange={(e) => p.setToken(e.target.value)}>
          {p.options.map((t) => (
            <option key={t.symbol} value={t.symbol}>
              {t.symbol}
            </option>
          ))}
          <option value="native">{p.ch.nativeSymbol} (gas)</option>
        </select>
      </label>
    </div>
  );
}

function Deposit({ cfg, onDone, guard }: { cfg: AgentConfig; onDone: () => void; guard: Guard }) {
  const ct = useChainToken(cfg);
  const [qr, setQr] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string; url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const addr = ct.ch.wallet;
  useEffect(() => {
    setQr(null);
    if (addr) void QRCode.toDataURL(addr, { margin: 1, width: 180, color: { dark: '#0a1322', light: '#f4f6fa' } }).then(setQr);
  }, [addr]);

  const fromWallet = async () => {
    setErr(null);
    setDone(null);
    try {
      if (!addr) throw new Error('bot wallet unknown');
      if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error('enter an amount');
      setBusy('Confirm in your wallet…');
      const from = await connect(UI_CHAINS[ct.chainKey]);
      const tx = ct.token === 'native' ? { to: addr, data: '0x', value: parseUnits(amount, 18).toString() } : { to: ct.tok!.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [addr as `0x${string}`, parseUnits(amount, ct.tok!.decimals)] }), value: '0' };
      const hash = await sendTx(from, tx);
      setBusy('Waiting for confirmation…');
      if ((await waitForTx(hash)) !== 'success') throw new Error('the transfer reverted');
      await guard(agentApi('deposits', { chain: ct.chainKey, txHash: hash }));
      setDone({ hash, url: `${ct.ch.explorer}/tx/${hash}` });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="funding">
      <ChainTokenPicker {...ct} cfg={cfg} />
      <p className="muted small">
        Send {ct.token === 'native' ? ct.ch.nativeSymbol : ct.token} on <b>{ct.ch.name}</b> only, to the bot wallet:
      </p>
      {addr ? (
        <div className="deposit-addr">
          {qr ? <img src={qr} alt={`QR code for ${addr}`} width={140} height={140} /> : null}
          <div>
            <code className="addr">{addr}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(addr).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy address'}
            </button>
          </div>
        </div>
      ) : (
        <p className="err small">Bot wallet unknown for {ct.ch.name}.</p>
      )}
      <h3>Deposit from your connected wallet</h3>
      <label>
        Amount
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="0.00" />
      </label>
      <button type="button" className="primary" disabled={!!busy || !addr} onClick={fromWallet}>
        {busy ?? `Deposit ${amount || ''} ${ct.token === 'native' ? ct.ch.nativeSymbol : ct.token}`}
      </button>
      {done ? (
        <p className="ok small">
          Deposited.{' '}
          <a href={done.url} target="_blank" rel="noreferrer">
            {short(done.hash)} on the explorer
          </a>
        </p>
      ) : null}
      {err ? <p className="err">{err}</p> : null}
    </div>
  );
}

function Withdraw({ cfg, onDone, guard }: { cfg: AgentConfig; onDone: () => void; guard: Guard }) {
  const ct = useChainToken(cfg);
  const [amount, setAmount] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [job, setJob] = useState<{ chain: string; id: string; status: string; txHash?: string; explorer?: string | null; error?: string; sentAmount?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sym = ct.token === 'native' ? ct.ch.nativeSymbol : ct.token;

  useEffect(() => {
    if (!job || job.status === 'sent' || job.status === 'failed') return;
    const t = setInterval(async () => {
      const r = await guard(agentApi<typeof job>(`withdrawals/${job.chain}/${job.id}`));
      if (r) {
        setJob(r);
        if (r.status === 'sent' || r.status === 'failed') onDone();
      }
    }, 3_000);
    return () => clearInterval(t);
  }, [job, guard, onDone]);

  const submit = async () => {
    setConfirm(false);
    setErr(null);
    const r = await guard(agentApi<{ id: string; chain: string; status: string; note: string }>('withdraw', { chain: ct.chainKey, token: ct.token, amount }));
    if (r) {
      setJob({ chain: r.chain, id: r.id, status: r.status });
      onDone();
    }
  };
  const valid = amount === 'max' || (/^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0);

  return (
    <div className="funding">
      <ChainTokenPicker {...ct} cfg={cfg} />
      <label>
        Amount
        <div className="inline">
          <input inputMode="decimal" value={amount === 'max' ? 'Max' : amount} onChange={(e) => setAmount(e.target.value.trim().toLowerCase() === 'max' ? 'max' : e.target.value.trim())} placeholder="0.00" />
          <button type="button" onClick={() => setAmount('max')}>
            Max
          </button>
        </div>
      </label>
      <p className="muted small">
        Goes to the owner address only: <code>{cfg.withdrawTo ?? 'not configured'}</code>
        {ct.token === 'native' ? ` · Max keeps a small ${ct.ch.nativeSymbol} gas reserve.` : ''}
      </p>
      <button type="button" className="primary" disabled={!valid || !cfg.withdrawTo || (!!job && job.status !== 'sent' && job.status !== 'failed')} onClick={() => setConfirm(true)}>
        Withdraw {amount === 'max' ? 'all' : amount} {sym}
      </button>
      {job ? (
        <p className={job.status === 'sent' ? 'ok small' : job.status === 'failed' ? 'err' : 'muted small'}>
          {job.status === 'requested' ? `Queued. ${ct.ch.name} is paused; the trader sends it after any trade in flight…` : job.status === 'sending' ? 'Sending…' : job.status === 'sent' ? `Sent ${job.sentAmount} ${sym}. ` : `Failed: ${job.error}`}
          {job.explorer ? (
            <a href={job.explorer} target="_blank" rel="noreferrer">
              {short(job.txHash)} on the explorer
            </a>
          ) : null}
          {job.status === 'sent' ? ` ${ct.ch.name} stays paused until you reactivate it.` : ''}
        </p>
      ) : null}
      {err ? <p className="err">{err}</p> : null}
      {confirm ? (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="wd-title">
          <div className="panel">
            <h2 id="wd-title">Confirm withdrawal</h2>
            <p>
              Send <b>{amount === 'max' ? 'all' : amount} {sym}</b> from the bot wallet on <b>{ct.ch.name}</b> to <code>{short(cfg.withdrawTo)}</code>.
            </p>
            <p className="muted small">This pauses {ct.ch.name} first. A trade in flight finishes, then the funds are sent. {ct.ch.name} stays paused until you switch it back on.</p>
            <div className="row-between">
              <button type="button" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="primary narrow" onClick={submit}>
                Withdraw
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------- history */

function History({ cfg, refreshKey, guard }: { cfg: AgentConfig | null; refreshKey: number; guard: Guard }) {
  const [tab, setTab] = useState<'trades' | 'funding' | 'control'>('trades');
  const [chain, setChain] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [data, setData] = useState<Paged<TradeRow | EventRow> & { summary?: { completed: number; pnlUsd: number; feesUsd: number } } | null>(null);

  const qs = useMemo(() => {
    const q = new URLSearchParams();
    if (chain) q.set('chain', chain);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (tab === 'trades' && status) q.set('status', status);
    if (tab !== 'trades') q.set('kind', tab);
    return q;
  }, [chain, from, to, status, tab]);
  const path = tab === 'trades' ? 'trades' : 'activity';

  useEffect(() => setPageNo(1), [qs]);
  useEffect(() => {
    const q = new URLSearchParams(qs);
    q.set('page', String(pageNo));
    q.set('pageSize', '25');
    void guard(agentApi<NonNullable<typeof data>>(`${path}?${q}`)).then((d) => d && setData(d));
  }, [qs, pageNo, path, guard, refreshKey]);

  const csv = `/api/proxy/v1/agent/${path}?${new URLSearchParams([...qs.entries(), ['format', 'csv']])}`;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const chainName = (k: string) => cfg?.chains.find((c) => c.key === k)?.name ?? k;

  return (
    <section className="panel history">
      <div className="row-between">
        <div className="tabs" role="tablist">
          {(['trades', 'funding', 'control'] as const).map((t) => (
            <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === 'trades' ? 'Trades' : t === 'funding' ? 'Deposits & withdrawals' : 'Pause / resume'}
            </button>
          ))}
        </div>
        <a className="button" href={csv} download>
          Export CSV
        </a>
      </div>
      <div className="filters">
        <select value={chain} onChange={(e) => setChain(e.target.value)} aria-label="Chain">
          <option value="">All chains</option>
          {cfg?.chains.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
        {tab === 'trades' ? (
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">All statuses</option>
            <option value="completed">Completed</option>
            <option value="aborted_before_spend">Skipped before spending</option>
            <option value="stuck">Stuck</option>
          </select>
        ) : null}
        <label>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {tab === 'trades' && data?.summary ? (
        <p className="muted small">
          {data.summary.completed} completed · P&amp;L {usd(data.summary.pnlUsd)} · gas {usd(data.summary.feesUsd)}
        </p>
      ) : null}
      <div className="scroll">
        {!data ? (
          <p className="muted">Loading…</p>
        ) : !data.rows.length ? (
          <p className="muted">{tab === 'trades' ? 'No trades yet. Live trades appear here once the agent is funded and active.' : 'Nothing here yet.'}</p>
        ) : tab === 'trades' ? (
          <table className="board">
            <thead>
              <tr>
                <th>Time</th>
                <th>Chain</th>
                <th>Route</th>
                <th>Side</th>
                <th>In</th>
                <th>Out</th>
                <th>P&amp;L</th>
                <th>Gas</th>
                <th>Status</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {(data.rows as TradeRow[]).map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td>{new Date(r.at).toLocaleString()}</td>
                  <td>{chainName(r.chain)}</td>
                  <td title={r.venues}>{r.route}</td>
                  <td>{r.side}</td>
                  <td>
                    {num(r.amountIn)} {r.token}
                  </td>
                  <td>{r.amountOut ? `${num(r.amountOut)} ${r.token}` : '—'}</td>
                  <td className={r.pnlUsd > 0 ? 'ok' : r.pnlUsd < 0 ? 'err' : ''}>{r.status === 'completed' ? usd(r.pnlUsd) : '—'}</td>
                  <td>{usd(r.feesUsd)}</td>
                  <td title={r.note ?? ''}>{r.status.replace(/_/g, ' ')}</td>
                  <td>
                    {r.explorer.length
                      ? r.explorer.map((u, j) => (
                          <a key={u} href={u} target="_blank" rel="noreferrer">
                            {j ? ' ' : ''}
                            {short(r.txs[j])}
                          </a>
                        ))
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="board">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Chain</th>
                <th>Amount</th>
                <th>By</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {(data.rows as EventRow[]).map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td>{new Date(r.at).toLocaleString()}</td>
                  <td title={r.note ?? ''}>{r.type.replace(/_/g, ' ')}</td>
                  <td>{r.chain === 'all' ? 'All chains' : chainName(r.chain)}</td>
                  <td>{r.amount ? `${r.amount === 'max' ? 'max' : num(r.amount)} ${r.token ?? ''}` : '—'}</td>
                  <td>{r.by?.startsWith('0x') ? short(r.by) : (r.by ?? '—')}</td>
                  <td>
                    {r.explorer ? (
                      <a href={r.explorer} target="_blank" rel="noreferrer">
                        {short(r.txHash)}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {data && data.total > data.pageSize ? (
        <div className="pager">
          <button type="button" disabled={pageNo <= 1} onClick={() => setPageNo((p) => p - 1)}>
            Previous
          </button>
          <span className="muted small">
            Page {pageNo} of {pages} · {data.total} rows
          </span>
          <button type="button" disabled={pageNo >= pages} onClick={() => setPageNo((p) => p + 1)}>
            Next
          </button>
        </div>
      ) : null}
    </section>
  );
}
