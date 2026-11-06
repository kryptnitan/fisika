/**
 * Agent console API (/v1/agent/*). Owner only, behind Sign-In With Ethereum; nothing here is reachable without a
 * session, and Caddy does not route /v1/agent/* from the internet at all: only the dashboard's own server-side proxy
 * reaches it, on localhost.
 *
 * The API holds no keys. Pause/resume writes the shared control file; a withdrawal is a request the live trader
 * (the key holder) sends to the owner address from its own environment.
 */
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { erc20Abi, formatUnits, parseEventLogs, type Hex } from 'viem';
import type { Address, ChainConfig, TokenRegistry } from '@fisika/core';
import type { GraphState } from '@fisika/core/setup';
import { AgentAuth, AuthError, Limiter, SESSION_COOKIE, SESSION_TTL_MS } from './auth.ts';
import { chainTrades, logEvent, readControl, readEvents, setControl, SWITCH_CHAINS, type AgentEvent, type ControlTarget } from './control.ts';
import { listRequests, readRequest, saveRequest, withdrawDir, type WithdrawRequest } from './withdrawals.ts';
import type { LedgerEntry } from '../live/trader.ts';

/** What the console needs to read from a chain. */
export interface AgentChainClient {
  getBalance(a: { address: Address }): Promise<bigint>;
  readContract(a: { address: Address; abi: typeof erc20Abi; functionName: 'balanceOf'; args: [Address] }): Promise<bigint>;
  getTransactionReceipt(a: { hash: Hex }): Promise<{ status: string; to: string | null; from: string; logs: never[] | unknown[] }>;
  getTransaction(a: { hash: Hex }): Promise<{ to: string | null; from: string; value: bigint }>;
}

export interface AgentChain {
  chain: ChainConfig;
  tokens: TokenRegistry;
  client: AgentChainClient;
  state: () => GraphState;
  /** Where this chain's trader keeps its status, ledger and withdrawal requests. Null: no live trader configured. */
  dataDir: string | null;
  /** The bot wallet (public address). From env, else from the trader's status file. */
  wallet: Address | null;
  /** Below this much gas token the console warns (and the trader stops trading). */
  lowGas: bigint;
}

export interface AgentDeps {
  owner: Address | null;
  withdrawTo: Address | null;
  /** Hosts a SIWE message may name (fisika.lol). */
  domains: string[];
  secureCookie: boolean;
  controlFile: string;
  eventsFile: string;
  chains: AgentChain[];
  now?: () => number;
}

const ONLINE_MS = 90_000;
const lc = (a: string) => a.toLowerCase();

interface TraderStatus {
  wallet?: string;
  updatedAt?: string;
  inFlight?: boolean;
  halted?: boolean;
  haltReason?: string | null;
  lastSkip?: Record<string, number>;
  pendingWithdrawals?: number;
  killed?: boolean;
}

async function readJson<T>(f: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(f, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function readLedger(f: string): Promise<LedgerEntry[]> {
  try {
    return (await readFile(f, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry);
  } catch {
    return [];
  }
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Quote, and neutralise spreadsheet formulas.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const toCsv = (rows: Record<string, unknown>[], cols: string[]) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';

function inRange(at: string, from?: string, to?: string) {
  const t = Date.parse(at);
  if (from && t < Date.parse(from)) return false;
  // A bare date for "to" means through the end of that day.
  if (to && t > Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to)) return false;
  return true;
}

function page<T>(rows: T[], q: Record<string, string>) {
  const pageSize = Math.min(Math.max(Number(q.pageSize) || 50, 1), 500);
  const pageNo = Math.max(Number(q.page) || 1, 1);
  return { total: rows.length, page: pageNo, pageSize, rows: rows.slice((pageNo - 1) * pageSize, pageNo * pageSize) };
}

export function createAgentApp(d: AgentDeps) {
  const now = d.now ?? Date.now;
  const auth = new AgentAuth(d.owner, d.domains, now);
  const limits = new Limiter(now);
  const app = new Hono();
  const byKey = new Map<string, AgentChain>(d.chains.map((c) => [c.chain.key, c]));

  app.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error('[agent]', err);
    return c.json({ error: 'internal error' }, 500);
  });
  app.use('*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });

  // ---------------------------------------------------------------- sign-in (no session needed)
  app.get('/v1/agent/nonce', (c) => {
    if (!limits.take('nonce', 60)) throw new HttpError(429, 'too many sign-in attempts; wait a minute');
    return c.json({ nonce: auth.nonce(), configured: !!d.owner });
  });
  app.post('/v1/agent/login', async (c) => {
    if (!limits.take('login', 20)) throw new HttpError(429, 'too many sign-in attempts; wait a minute');
    const body = (await c.req.json().catch(() => null)) as { message?: string; signature?: string } | null;
    const { token, session } = await auth.login(body?.message ?? '', body?.signature ?? '');
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: d.secureCookie, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL_MS / 1000 });
    console.log(`[agent] owner signed in ${session.address}`);
    return c.json({ address: session.address, expiresAt: new Date(session.expiresMs).toISOString() });
  });
  app.post('/v1/agent/logout', (c) => {
    auth.logout(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });
  app.get('/v1/agent/session', (c) => {
    const s = auth.session(getCookie(c, SESSION_COOKIE));
    return s ? c.json({ address: s.address, expiresAt: new Date(s.expiresMs).toISOString() }) : c.json({ error: 'not signed in', configured: !!d.owner }, 401);
  });

  // ---------------------------------------------------------------- everything else: owner session required
  const owner = (c: Context) => {
    const s = auth.session(getCookie(c, SESSION_COOKIE));
    if (!s) throw new HttpError(401, 'sign in with the owner wallet');
    return s;
  };
  const act = (c: Context, kind: string, perMinute: number) => {
    const s = owner(c);
    if (!limits.take(`${kind}:${s.address}`, perMinute)) throw new HttpError(429, 'too many actions; wait a minute');
    return s;
  };
  const chainOf = (key: string | undefined) => {
    const ch = key ? byKey.get(key) : undefined;
    if (!ch) throw new HttpError(400, `unknown chain ${key}`);
    return ch;
  };
  const walletOf = async (ch: AgentChain): Promise<Address | null> => {
    if (ch.wallet) return ch.wallet;
    const st = ch.dataDir ? await readJson<TraderStatus>(`${ch.dataDir}/live-status.json`) : null;
    return st?.wallet ? (lc(st.wallet) as Address) : null;
  };

  app.get('/v1/agent/config', async (c) => {
    owner(c);
    return c.json({
      owner: d.owner,
      withdrawTo: d.withdrawTo,
      chains: await Promise.all(
        d.chains.map(async (ch) => ({
          key: ch.chain.key,
          name: ch.chain.name,
          chainId: ch.chain.id,
          explorer: ch.chain.explorer,
          nativeSymbol: ch.chain.nativeSymbol,
          wallet: await walletOf(ch),
          traderConfigured: !!ch.dataDir,
          tokens: ch.tokens
            .usable()
            .filter((t) => !(ch.chain.key === 'celo' && lc(t.address) === lc(ch.chain.wrappedNative)))
            .map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals })),
        })),
      ),
    });
  });

  app.get('/v1/agent/state', async (c) => {
    owner(c);
    const ctl = await readControl(d.controlFile);
    const chains = await Promise.all(
      d.chains.map(async (ch) => {
        const st = ch.dataDir ? await readJson<TraderStatus>(`${ch.dataDir}/live-status.json`) : null;
        const ageMs = st?.updatedAt ? now() - Date.parse(st.updatedAt) : null;
        const online = ageMs !== null && ageMs < ONLINE_MS;
        const trading = chainTrades(ctl, ch.chain.key);
        const inFlight = online && !!st?.inFlight;
        const pending = ch.dataDir ? (await listRequests(withdrawDir(ch.dataDir))).filter((r) => r.chain === ch.chain.key && (r.status === 'requested' || r.status === 'sending')) : [];
        return {
          key: ch.chain.key,
          name: ch.chain.name,
          switchOn: ctl.chains[ch.chain.key as 'celo' | 'bsc'] !== false,
          trading,
          status: trading ? (st?.killed ? 'stopped' : 'active') : inFlight ? 'pausing' : 'paused',
          trader: !ch.dataDir ? 'not_configured' : online ? 'online' : st ? 'offline' : 'never_started',
          traderAgeMs: ageMs,
          inFlight,
          killFileOn: !!st?.killed,
          halted: !!st?.halted,
          haltReason: st?.haltReason ?? null,
          lastSkip: st?.lastSkip ?? {},
          pendingWithdrawals: pending,
        };
      }),
    );
    const anyInFlight = chains.some((x) => x.inFlight && !x.trading);
    return c.json({
      active: ctl.active,
      status: ctl.active ? 'active' : anyInFlight ? 'pausing' : 'paused',
      updatedAt: ctl.updatedAt,
      by: ctl.by,
      chains,
    });
  });

  app.post('/v1/agent/control', async (c) => {
    const s = act(c, 'control', 20);
    const body = (await c.req.json().catch(() => null)) as { target?: string; active?: boolean } | null;
    const target = body?.target as ControlTarget;
    if (!target || !['all', ...SWITCH_CHAINS].includes(target) || typeof body?.active !== 'boolean') throw new HttpError(400, 'body must be { target: "all"|"celo"|"bsc", active: boolean }');
    const next = await setControl(d.controlFile, target, body.active, s.address, d.eventsFile);
    console.log(`[agent] ${body.active ? 'resume' : 'pause'} ${target} by owner`);
    return c.json(next);
  });

  app.get('/v1/agent/balances', async (c) => {
    owner(c);
    const t = now();
    const out = await Promise.all(
      d.chains.map(async (ch) => {
        const wallet = await walletOf(ch);
        if (!wallet) return { key: ch.chain.key, wallet: null, error: 'bot wallet unknown (start the trader once, or set AGENT_WALLET_*)' };
        const st = ch.state();
        const native = await ch.client.getBalance({ address: wallet }).catch(() => null);
        const toks = ch.tokens.usable().filter((x) => !(ch.chain.key === 'celo' && lc(x.address) === lc(ch.chain.wrappedNative)));
        const bals = await Promise.all(toks.map((x) => ch.client.readContract({ address: x.address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }).catch(() => null)));
        const nativeUsd = native === null ? null : st.nativeUsd ? (Number(native) / 1e18) * st.nativeUsd : null;
        const tokens = toks
          .map((x, i) => ({ symbol: x.symbol, address: x.address, decimals: x.decimals!, raw: bals[i] }))
          .filter((x) => x.raw !== null && (x.raw! > 0n || ch.chain.startTokens.includes(x.symbol)))
          .map((x) => ({ symbol: x.symbol, address: x.address, decimals: x.decimals, balance: formatUnits(x.raw!, x.decimals), usd: st.updatedMs ? st.pricer.usdValue(x.address, x.raw!, t) : null }));
        return {
          key: ch.chain.key,
          wallet,
          native: { symbol: ch.chain.nativeSymbol, balance: native === null ? null : formatUnits(native, 18), usd: nativeUsd },
          lowGas: native !== null && native < ch.lowGas,
          lowGasBelow: formatUnits(ch.lowGas, 18),
          tokens,
          totalUsd: tokens.reduce((a, x) => a + (x.usd ?? 0), 0) + (nativeUsd ?? 0),
        };
      }),
    );
    return c.json({ asOf: new Date(t).toISOString(), chains: out });
  });

  // Record a deposit made from the console: verified on-chain, only transfers INTO the bot wallet count.
  app.post('/v1/agent/deposits', async (c) => {
    const s = act(c, 'deposit', 30);
    const body = (await c.req.json().catch(() => null)) as { chain?: string; txHash?: string } | null;
    const ch = chainOf(body?.chain);
    const hash = body?.txHash ?? '';
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new HttpError(400, 'txHash must be a transaction hash');
    const wallet = await walletOf(ch);
    if (!wallet) throw new HttpError(409, 'bot wallet unknown');
    const seen = (await readEvents(d.eventsFile)).some((e) => e.type === 'deposit' && lc(e.txHash ?? '') === lc(hash));
    if (seen) return c.json({ recorded: [], note: 'already recorded' });
    const rec = await ch.client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
    if (!rec) throw new HttpError(404, 'transaction not found or not mined yet');
    if (rec.status !== 'success') throw new HttpError(422, 'transaction failed on-chain');
    const recorded: { token: string; amount: string }[] = [];
    const logs = parseEventLogs({ abi: erc20Abi, logs: rec.logs as never, eventName: 'Transfer' });
    for (const l of logs) {
      if (lc(l.args.to) !== wallet) continue;
      const t = ch.tokens.get(l.address);
      if (!t || t.decimals === null) continue;
      recorded.push({ token: t.symbol, amount: formatUnits(l.args.value, t.decimals) });
    }
    const tx = await ch.client.getTransaction({ hash: hash as Hex }).catch(() => null);
    if (tx && tx.to && lc(tx.to) === wallet && tx.value > 0n) recorded.push({ token: ch.chain.nativeSymbol, amount: formatUnits(tx.value, 18) });
    if (!recorded.length) throw new HttpError(422, 'this transaction sent nothing to the bot wallet');
    for (const r of recorded) await logEvent(d.eventsFile, { type: 'deposit', chain: ch.chain.key, token: r.token, amount: r.amount, txHash: hash, by: s.address, note: tx ? `from ${lc(tx.from)}` : undefined });
    return c.json({ recorded });
  });

  app.post('/v1/agent/withdraw', async (c) => {
    const s = act(c, 'withdraw', 5);
    const body = (await c.req.json().catch(() => null)) as { chain?: string; token?: string; amount?: string } | null;
    const ch = chainOf(body?.chain);
    if (!d.withdrawTo) throw new HttpError(409, 'no owner withdraw address is configured (WITHDRAW_ADDRESS)');
    if (!ch.dataDir) throw new HttpError(409, `no live trader is configured for ${ch.chain.name}`);
    const token = body?.token ?? '';
    const native = token === 'native' || token === ch.chain.nativeSymbol;
    if (!native) {
      let t;
      try {
        t = ch.tokens.bySymbol(token);
      } catch {
        t = null;
      }
      if (!t || t.decimals === null) throw new HttpError(400, `unknown token ${token}`);
    }
    const amount = (body?.amount ?? '').trim();
    if (amount !== 'max' && !(/^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0)) throw new HttpError(400, 'amount must be a positive number or "max"');
    // Pause this chain first; the trader also refuses to send while it would be trading.
    await setControl(d.controlFile, ch.chain.key as 'celo' | 'bsc', false, `${s.address} (withdraw)`, d.eventsFile);
    const r: WithdrawRequest = { id: `w_${randomUUID()}`, chain: ch.chain.key, token: native ? 'native' : token, amount, requestedAt: new Date(now()).toISOString(), by: s.address, status: 'requested' };
    await saveRequest(withdrawDir(ch.dataDir), r);
    await logEvent(d.eventsFile, { type: 'withdraw_requested', chain: ch.chain.key, id: r.id, token: native ? ch.chain.nativeSymbol : token, amount, by: s.address });
    const st = await readJson<TraderStatus>(`${ch.dataDir}/live-status.json`);
    const online = !!st?.updatedAt && now() - Date.parse(st.updatedAt) < ONLINE_MS;
    console.log(`[agent] withdrawal ${r.id} ${amount} ${r.token} on ${ch.chain.key} requested by owner`);
    return c.json({ ...r, to: d.withdrawTo, traderOnline: online, note: online ? 'the trader sends it after any trade in flight' : 'the trader is not running; it sends this as soon as it starts' });
  });

  app.get('/v1/agent/withdrawals/:chain/:id', async (c) => {
    owner(c);
    const ch = chainOf(c.req.param('chain'));
    if (!ch.dataDir) throw new HttpError(404, 'no trader');
    const r = await readRequest(withdrawDir(ch.dataDir), c.req.param('id'));
    if (!r) throw new HttpError(404, 'unknown withdrawal');
    return c.json({ ...r, explorer: r.txHash ? `${ch.chain.explorer}/tx/${r.txHash}` : null });
  });

  app.get('/v1/agent/trades', async (c) => {
    owner(c);
    const q = c.req.query();
    const rows: Record<string, unknown>[] = [];
    for (const ch of d.chains) {
      if (!ch.dataDir || (q.chain && q.chain !== ch.chain.key)) continue;
      for (const e of await readLedger(`${ch.dataDir}/live-ledger.jsonl`)) {
        if (q.status && q.status !== e.status) continue;
        if (!inRange(e.at, q.from, q.to)) continue;
        let dec = e.startDecimals;
        if (dec === undefined) {
          try {
            dec = ch.tokens.bySymbol(e.startToken).decimals ?? 18;
          } catch {
            dec = 18;
          }
        }
        const amountIn = formatUnits(BigInt(e.amountIn), dec);
        const out = e.amountOut ?? (e.status === 'completed' && e.realizedStart !== null ? (BigInt(e.amountIn) + BigInt(e.realizedStart)).toString() : null);
        rows.push({
          at: e.at,
          chain: e.chain ?? ch.chain.key,
          route: e.path,
          venues: e.venues.join('+'),
          side: 'loop',
          token: e.startToken,
          amountIn,
          amountOut: out === null ? null : formatUnits(BigInt(out), dec),
          pnlUsd: Number(e.realizedUsd.toFixed(6)),
          feesUsd: Number(e.gasUsd.toFixed(6)),
          status: e.status,
          txs: e.txs,
          explorer: e.txs.map((h) => `${ch.chain.explorer}/tx/${h}`),
          note: e.note ?? null,
        });
      }
    }
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (q.format === 'csv') {
      c.header('content-type', 'text/csv; charset=utf-8');
      c.header('content-disposition', `attachment; filename="fisika-trades-${new Date(now()).toISOString().slice(0, 10)}.csv"`);
      return c.body(toCsv(rows.map((r) => ({ ...r, txs: (r.txs as string[]).join(' ') })), ['at', 'chain', 'route', 'venues', 'side', 'token', 'amountIn', 'amountOut', 'pnlUsd', 'feesUsd', 'status', 'txs', 'note']));
    }
    const completed = rows.filter((r) => r.status === 'completed');
    return c.json({ ...page(rows, q), summary: { completed: completed.length, pnlUsd: completed.reduce((a, r) => a + (r.pnlUsd as number), 0), feesUsd: rows.reduce((a, r) => a + (r.feesUsd as number), 0) } });
  });

  app.get('/v1/agent/activity', async (c) => {
    owner(c);
    const q = c.req.query();
    const funding = new Set<AgentEvent['type']>(['deposit', 'withdraw_requested', 'withdraw_sent', 'withdraw_failed']);
    const explorer = (chain: string) => byKey.get(chain)?.chain.explorer ?? d.chains[0]?.chain.explorer ?? '';
    const rows = (await readEvents(d.eventsFile))
      .filter((e) => (q.kind === 'funding' ? funding.has(e.type) : q.kind === 'control' ? !funding.has(e.type) : true))
      .filter((e) => !q.chain || e.chain === q.chain || e.chain === 'all')
      .filter((e) => inRange(e.at, q.from, q.to))
      .map((e) => ({ ...e, explorer: e.txHash ? `${explorer(e.chain)}/tx/${e.txHash}` : null }))
      .reverse();
    if (q.format === 'csv') {
      c.header('content-type', 'text/csv; charset=utf-8');
      c.header('content-disposition', `attachment; filename="fisika-activity-${new Date(now()).toISOString().slice(0, 10)}.csv"`);
      return c.body(toCsv(rows as unknown as Record<string, unknown>[], ['at', 'type', 'chain', 'token', 'amount', 'txHash', 'by', 'note']));
    }
    return c.json(page(rows, q));
  });

  return { app, auth };
}

export class HttpError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 422 | 429;
  constructor(status: 400 | 401 | 404 | 409 | 422 | 429, message: string) {
    super(message);
    this.status = status;
  }
}
