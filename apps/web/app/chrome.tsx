'use client';
import { usePathname } from 'next/navigation';
import { usePoll } from '@/lib/api';

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

export function ChainStatus() {
  const { data, error } = usePoll<{ ok: boolean; block: string; graphAgeMs: number | null }>('health', 5_000);
  const state = error ? 'stale' : data?.ok ? 'live' : 'stale';
  return (
    <div className="chain" role="status">
      <span className={`dot ${state}`} aria-hidden />
      {error ? 'API unreachable' : data ? `Celo block ${Number(data.block).toLocaleString('en-US')}` : 'Connecting'}
    </div>
  );
}
