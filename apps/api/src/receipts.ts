import { receiptHash, routeIdFor, fisikaExecutorAbi } from '@fisika/core/build';
import type { TokenRegistry } from '@fisika/core';
import { parseEventLogs, type Hex, type Log } from 'viem';
import { formatAtomic, type StoredQuote } from './quotes.ts';

export interface TxReceiptLike {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: Log[];
  to: string | null;
}

export interface Receipt {
  id: string;
  quoteId: string;
  txHash: Hex;
  block: string;
  status: 'filled' | 'reverted';
  route: { venue: string; pool: string; from: string; to: string }[][];
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  quotedOut: string;
  realizedOut: string | null;
  fee: string | null;
  quotedRate: number;
  realizedRate: number | null;
  slippageVsQuoteBps: number | null;
  explorer: string;
  hash: Hex;
}

export class ReceiptStore {
  private byId = new Map<string, Receipt>();
  private byTx = new Map<string, string>();
  private order: string[] = [];

  add(r: Receipt): void {
    this.byId.set(r.id, r);
    this.byTx.set(r.txHash.toLowerCase(), r.id);
    this.order.unshift(r.id);
    if (this.order.length > 10_000) this.byId.delete(this.order.pop()!);
  }
  get(id: string): Receipt | undefined {
    return this.byId.get(id) ?? this.byId.get(this.byTx.get(id.toLowerCase()) ?? '');
  }
  latest(n = 50): Receipt[] {
    return this.order.slice(0, n).map((id) => this.byId.get(id)!).filter(Boolean);
  }
}

/**
 * Build a verifiable receipt from the on-chain transaction: the executor's Executed event must carry the routeId
 * derived from this quote, so a receipt cannot be attached to someone else's transaction.
 */
export function makeReceipt(q: StoredQuote, txHash: Hex, tx: TxReceiptLike, executor: string, tokens: TokenRegistry): Receipt {
  const r = q.route;
  const dIn = tokens.decimals(r.tokenIn);
  const dOut = tokens.decimals(r.tokenOut);
  const sym = (a: string) => tokens.get(a)?.symbol ?? a;
  const events = parseEventLogs({ abi: fisikaExecutorAbi, logs: tx.logs, eventName: 'Executed' }).filter(
    (l) => l.address.toLowerCase() === executor.toLowerCase() && l.args.routeId === routeIdFor(q.id),
  );
  const ev = events[0];
  if (tx.status === 'success' && !ev) throw new Error('transaction has no Executed event for this quote');
  const realized = ev ? ev.args.amountOut : null;
  const inNum = Number(formatAtomic(r.amountIn, dIn));
  const quotedRate = Number(formatAtomic(r.amountOut, dOut)) / inNum;
  const realizedRate = realized === null ? null : Number(formatAtomic(realized, dOut)) / inNum;
  const body = {
    quoteId: q.id,
    txHash,
    block: tx.blockNumber.toString(),
    status: tx.status === 'success' ? ('filled' as const) : ('reverted' as const),
    route: r.paths.map((p) => p.edges.map((e) => ({ venue: e.venue, pool: e.poolId, from: sym(e.tokenIn), to: sym(e.tokenOut) }))),
    tokenIn: sym(r.tokenIn),
    tokenOut: sym(r.tokenOut),
    amountIn: formatAtomic(r.amountIn, dIn),
    quotedOut: formatAtomic(r.amountOut, dOut),
    realizedOut: realized === null ? null : formatAtomic(realized, dOut),
    fee: ev ? formatAtomic(ev.args.fee, dOut) : null,
    quotedRate,
    realizedRate,
    slippageVsQuoteBps: realizedRate === null ? null : Math.round(((quotedRate - realizedRate) / quotedRate) * 10_000 * 100) / 100,
    explorer: `https://celoscan.io/tx/${txHash}`,
  };
  return { id: `r_${txHash.slice(2, 18)}`, ...body, hash: receiptHash(body) };
}
