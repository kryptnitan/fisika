'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export async function api<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown; auth?: string }): Promise<T> {
  const res = await fetch(`/api/proxy/${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init?.auth ? { authorization: `Bearer ${init.auth}` } : {}) },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** Poll an endpoint; keeps the last good value on transient errors. */
export function usePoll<T>(path: string, everyMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    void load();
    const t = setInterval(() => void load(), everyMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load, everyMs]);
  return { data, error, reload: load };
}

export function fmtRate(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return '—';
  if (r >= 1000) return r.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (r >= 1) return r.toFixed(4);
  return r.toPrecision(4);
}

export function fmtUsd(n: number, digits = 2): string {
  return `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function ago(iso: string | number | null | undefined): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

export const VENUE_LABEL: Record<string, string> = { 'uniswap-v3': 'Uniswap', mento: 'Mento', 'mento-v2': 'Mento v2', textile: 'Textile' };
