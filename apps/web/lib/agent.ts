'use client';
/** Calls to the owner-only agent console API. Chain-independent: no chain prefix; the session cookie does the auth. */
export class AgentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function agentApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/proxy/v1/agent/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new AgentError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface AgentConfig {
  owner: string;
  withdrawTo: string | null;
  chains: { key: 'celo' | 'bsc'; name: string; chainId: number; explorer: string; nativeSymbol: string; wallet: string | null; traderConfigured: boolean; tokens: { symbol: string; address: string; decimals: number }[] }[];
}

export interface AgentState {
  active: boolean;
  status: 'active' | 'pausing' | 'paused';
  updatedAt: string | null;
  by: string | null;
  chains: {
    key: 'celo' | 'bsc';
    name: string;
    switchOn: boolean;
    trading: boolean;
    status: 'active' | 'pausing' | 'paused' | 'stopped';
    trader: 'online' | 'offline' | 'never_started' | 'not_configured';
    inFlight: boolean;
    killFileOn: boolean;
    halted: boolean;
    haltReason: string | null;
    lastSkip: Record<string, number>;
    pendingWithdrawals: { id: string; token: string; amount: string; status: string }[];
  }[];
}

export interface Balances {
  asOf: string;
  chains: {
    key: 'celo' | 'bsc';
    wallet: string | null;
    error?: string;
    native?: { symbol: string; balance: string | null; usd: number | null };
    lowGas?: boolean;
    lowGasBelow?: string;
    tokens?: { symbol: string; address: string; decimals: number; balance: string; usd: number | null }[];
    totalUsd?: number;
  }[];
}

export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
  rows: T[];
}

export interface TradeRow {
  at: string;
  chain: string;
  route: string;
  venues: string;
  side: string;
  token: string;
  amountIn: string;
  amountOut: string | null;
  pnlUsd: number;
  feesUsd: number;
  status: string;
  txs: string[];
  explorer: string[];
  note: string | null;
}

export interface EventRow {
  at: string;
  type: string;
  chain: string;
  token?: string;
  amount?: string;
  txHash?: string;
  explorer: string | null;
  by?: string;
  note?: string;
}
