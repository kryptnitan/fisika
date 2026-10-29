'use client';
import { useEffect, useState } from 'react';

/** Chains the dashboard can show. Mirrors packages/core/src/chains.ts (the API is the source of truth for data). */
export type ChainKey = 'celo' | 'bsc';

export interface UiChain {
  key: ChainKey;
  name: string;
  chainIdHex: string;
  nativeSymbol: string;
  explorer: string;
  rpc: string;
  /** API path prefix: Celo is the default at /v1/*. */
  prefix: string;
}

export const UI_CHAINS: Record<ChainKey, UiChain> = {
  celo: { key: 'celo', name: 'Celo', chainIdHex: '0xa4ec', nativeSymbol: 'CELO', explorer: 'https://celoscan.io', rpc: 'https://forno.celo.org', prefix: '' },
  bsc: { key: 'bsc', name: 'BNB Chain', chainIdHex: '0x38', nativeSymbol: 'BNB', explorer: 'https://bscscan.com', rpc: 'https://bsc-dataseed.bnbchain.org', prefix: 'bsc/' },
};

const STORE = 'fisika.chain';

/** Current chain: ?chain= in the URL wins, then the last choice, then Celo. Safe outside the browser. */
export function currentChain(): UiChain {
  if (typeof window === 'undefined') return UI_CHAINS.celo;
  const q = new URLSearchParams(window.location.search).get('chain');
  if (q && q in UI_CHAINS) return UI_CHAINS[q as ChainKey];
  try {
    const s = window.localStorage.getItem(STORE);
    if (s && s in UI_CHAINS) return UI_CHAINS[s as ChainKey];
  } catch {
    /* storage blocked */
  }
  return UI_CHAINS.celo;
}

export function setChain(key: ChainKey): void {
  try {
    window.localStorage.setItem(STORE, key);
  } catch {
    /* storage blocked: the URL still carries it */
  }
  const url = new URL(window.location.href);
  if (key === 'celo') url.searchParams.delete('chain');
  else url.searchParams.set('chain', key);
  window.location.assign(url.toString());
}

/** Client-side hook. Renders Celo on the server and first paint, then the real choice (no hydration mismatch). */
export function useChain(): UiChain {
  const [c, setC] = useState<UiChain>(UI_CHAINS.celo);
  useEffect(() => setC(currentChain()), []);
  return c;
}
