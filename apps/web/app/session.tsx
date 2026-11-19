'use client';
/**
 * Who is looking at the site. The session is the console's SIWE cookie (HttpOnly; the browser never sees it); this
 * only asks the API who it belongs to. Hiding a page here is presentation — the data itself is refused by the
 * website's server (app/api/proxy) to anyone without the right role.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { createSiweMessage } from 'viem/siwe';
import { getAddress } from 'viem';
import { agentApi, AgentError } from '@/lib/agent';
import { UI_CHAINS } from '@/lib/chain';
import { connect, signMessage } from '@/lib/wallet';

export type Role = 'owner' | 'member';
export type SessionState =
  | { status: 'loading' }
  | { status: 'out'; configured: boolean }
  | { status: 'in'; address: string; role: Role; expiresAt: string };

type Ctx = { session: SessionState; refresh: () => Promise<void>; signedIn: (s: { address: string; role: Role; expiresAt: string }) => void; signOut: () => Promise<void> };
const SessionCtx = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const refresh = useCallback(async () => {
    try {
      const s = await agentApi<{ address: string; role?: Role; expiresAt: string }>('session');
      setSession({ status: 'in', address: s.address, role: s.role ?? 'owner', expiresAt: s.expiresAt });
    } catch (e) {
      setSession({ status: 'out', configured: !(e instanceof AgentError && e.status === 404) });
    }
  }, []);
  useEffect(() => {
    void refresh();
    // Sessions last 30 minutes; notice expiry without a reload.
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);
  const signedIn = useCallback((s: { address: string; role: Role; expiresAt: string }) => setSession({ status: 'in', ...s }), []);
  const signOut = useCallback(async () => {
    await agentApi('logout', {}).catch(() => undefined);
    setSession({ status: 'out', configured: true });
  }, []);
  return <SessionCtx.Provider value={{ session, refresh, signedIn, signOut }}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}

/** True when the signed-in role is allowed `need`. */
export function allows(s: SessionState, need: Role): boolean {
  return s.status === 'in' && (s.role === 'owner' || need === 'member');
}

export function SignIn({ title = 'Sign in', note }: { title?: string; note?: ReactNode }) {
  const { session, signedIn } = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const configured = session.status !== 'out' || session.configured;
  const go = async () => {
    setErr(null);
    setBusy(true);
    try {
      const account = await connect(UI_CHAINS.celo);
      const { nonce, configured: ok } = await agentApi<{ nonce: string; configured: boolean }>('nonce');
      if (!ok) throw new Error('Sign-in is not set up on this server yet (OWNER_ADDRESS).');
      const message = createSiweMessage({
        address: getAddress(account),
        chainId: 42220,
        domain: window.location.host,
        uri: window.location.origin,
        version: '1',
        nonce,
        issuedAt: new Date(),
        expirationTime: new Date(Date.now() + 5 * 60_000),
        statement: 'Sign in to fisika. This does not send a transaction or cost gas.',
      });
      const signature = await signMessage(account, message);
      const r = await agentApi<{ address: string; role?: Role; expiresAt: string }>('login', { message, signature });
      signedIn({ address: r.address, role: r.role ?? 'owner', expiresAt: r.expiresAt });
    } catch (e) {
      const m = (e as Error).message;
      setErr(e instanceof AgentError && e.status === 403 ? 'This wallet does not have access to fisika yet.' : m);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel signin">
      <h2>{title}</h2>
      <p className="muted">{note ?? 'Connect a wallet with access and sign a message. Signing proves you hold the wallet; it sends no transaction and costs no gas. The session lasts 30 minutes.'}</p>
      {!configured ? <p className="err">Sign-in is not configured on this server.</p> : null}
      <button className="primary" type="button" onClick={go} disabled={busy}>
        {busy ? 'Check your wallet…' : 'Connect wallet and sign in'}
      </button>
      {err ? <p className="err">{err}</p> : null}
    </section>
  );
}

/** Renders children only for a role that may see them; otherwise a locked notice with sign-in. */
export function Gate({ need, title, children }: { need: Role; title: string; children: ReactNode }) {
  const { session } = useSession();
  if (session.status === 'loading') return <p className="muted">Checking your session…</p>;
  if (allows(session, need)) return <>{children}</>;
  if (session.status === 'in')
    return (
      <>
        <h1>{title}</h1>
        <section className="panel locked">
          <p><Lock /> Only the owner wallet can open this page.</p>
        </section>
      </>
    );
  return (
    <>
      <h1>{title}</h1>
      <p className="lede"><Lock /> This page is private. Sign in to see it.</p>
      <SignIn />
    </>
  );
}

/** A small padlock in the text colour (an emoji lock would be yellow on the dark theme). */
export function Lock({ label }: { label?: string }) {
  return (
    <svg className="lock" width="12" height="12" viewBox="0 0 16 16" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <rect x="2.5" y="7" width="11" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
