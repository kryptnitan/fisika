'use client';
import { usePathname } from 'next/navigation';
import { usePoll } from '@/lib/api';
import { setChain, UI_CHAINS, useChain, type ChainKey } from '@/lib/chain';
import { allows, Lock, useSession, type Role } from './session';

export const LINKS: { href: string; label: string; need: Role }[] = [
  { href: '/', label: 'Rates', need: 'member' },
  { href: '/arb', label: 'Arbitrage', need: 'owner' },
  { href: '/agents', label: 'Agent API', need: 'member' },
  { href: '/trades', label: 'Trades', need: 'owner' },
  { href: '/agent', label: 'My agent', need: 'owner' },
];

export function Nav() {
  const path = usePathname();
  const { session } = useSession();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map((l) => {
        const locked = session.status !== 'loading' && !allows(session, l.need);
        return (
          <a key={l.href} href={l.href} aria-current={path === l.href ? 'page' : undefined} className={locked ? 'locked' : undefined} title={locked ? 'Sign in to open' : undefined}>
            {l.label}
            {locked ? <Lock label="locked" /> : null}
          </a>
        );
      })}
    </nav>
  );
}

/** Signed-in wallet and sign-out, or nothing. */
export function Who() {
  const { session, signOut } = useSession();
  if (session.status !== 'in') return null;
  return (
    <div className="who">
      <span className="num" title={session.address}>{`${session.address.slice(0, 6)}…${session.address.slice(-4)}`}</span>
      {session.role === 'member' ? <span className="tag">member</span> : null}
      <button type="button" onClick={() => void signOut().then(() => window.location.assign('/'))}>Sign out</button>
    </div>
  );
}

/** Celo / BNB Chain switch. Every page reads the selected chain; switching reloads onto the other chain's data. */
export function ChainSwitch() {
  const chain = useChain();
  const { session } = useSession();
  if (session.status !== 'in') return null;
  return (
    <div className="chainswitch" role="group" aria-label="Chain">
      {(Object.keys(UI_CHAINS) as ChainKey[]).map((k) => (
        <button key={k} type="button" aria-pressed={chain.key === k} onClick={() => chain.key !== k && setChain(k)}>
          {UI_CHAINS[k].name}
        </button>
      ))}
    </div>
  );
}

export function ChainStatus() {
  const { session } = useSession();
  return session.status === 'in' ? <ChainStatusLive /> : null;
}

function ChainStatusLive() {
  const chain = useChain();
  const { data, error } = usePoll<{ ok: boolean; block: string; graphAgeMs: number | null; chain?: string }>('health', 5_000);
  // Ignore a stale response from the other chain during the first render.
  const mine = data && (data.chain ?? 'celo') === chain.key ? data : null;
  const state = error ? 'stale' : mine?.ok ? 'live' : 'stale';
  return (
    <div className="chain" role="status">
      <span className={`dot ${state}`} aria-hidden />
      {error ? `${chain.name} API unreachable` : mine ? `${chain.name} block ${Number(mine.block).toLocaleString('en-US')}` : 'Connecting'}
    </div>
  );
}
