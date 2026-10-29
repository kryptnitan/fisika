'use client';
import { usePathname } from 'next/navigation';
import { usePoll } from '@/lib/api';
import { setChain, UI_CHAINS, useChain, type ChainKey } from '@/lib/chain';

const LINKS = [
  { href: '/', label: 'Rates' },
  { href: '/arb', label: 'Arbitrage' },
  { href: '/agents', label: 'Agent API' },
  { href: '/trades', label: 'Trades' },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map((l) => (
        <a key={l.href} href={l.href} aria-current={path === l.href ? 'page' : undefined}>
          {l.label}
        </a>
      ))}
    </nav>
  );
}

/** Celo / BNB Chain switch. Every page reads the selected chain; switching reloads onto the other chain's data. */
export function ChainSwitch() {
  const chain = useChain();
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
