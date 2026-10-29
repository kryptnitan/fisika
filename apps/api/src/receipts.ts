import { receiptHash, routeIdFor, fisikaExecutorAbi } from '@fisika/core/build';
import type { TokenRegistry } from '@fisika/core';
import { erc20Abi, parseEventLogs, type Hex, type Log } from 'viem';
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

/** How the quote was executed: through the fisika executor, or directly against a venue contract. */
export type ReceiptMode =
  | { kind: 'executor'; executor: string; explorer?: string }
  | { kind: 'direct'; target: string; recipient: string; explorer?: string };

/**
 * Build a verifiable receipt from the on-chain transaction.
 * - executor: the Executed event must carry the routeId derived from this quote, so a receipt cannot be attached
 *   to someone else's transaction.
 * - direct (no executor on the chain): the transaction must call the venue contract fisika built it for, and the
 *   realized output is the tokenOut transferred to the recipient fisika built it for, read from the logs.
 */
export function makeReceipt(q: StoredQuote, txHash: Hex, tx: TxReceiptLike, mode: ReceiptMode | string, tokens: TokenRegistry): Receipt {
  const m: ReceiptMode = typeof mode === 'string' ? { kind: 'executor', executor: mode } : mode;
  const r = q.route;
  const dIn = tokens.decimals(r.tokenIn);
  const dOut = tokens.decimals(r.tokenOut);
  const sym = (a: string) => tokens.get(a)?.symbol ?? a;
  let realized: bigint | null = null;
  let fee: bigint | null = null;
  if (m.kind === 'executor') {
    const events = parseEventLogs({ abi: fisikaExecutorAbi, logs: tx.logs, eventName: 'Executed' }).filter(
      (l) => l.address.toLowerCase() === m.executor.toLowerCase() && l.args.routeId === routeIdFor(q.id),
    );
    const ev = events[0];
    if (tx.status === 'success' && !ev) throw new Error('transaction has no Executed event for this quote');
    realized = ev ? ev.args.amountOut : null;
    fee = ev ? ev.args.fee : null;
  } else {
    if ((tx.to ?? '').toLowerCase() !== m.target.toLowerCase()) throw new Error('transaction does not call the contract this quote was built for');
    if (tx.status === 'success') {
      const ins = parseEventLogs({ abi: erc20Abi, logs: tx.logs, eventName: 'Transfer' }).filter(
        (l) => l.address.toLowerCase() === r.tokenOut.toLowerCase() && l.args.to.toLowerCase() === m.recipient.toLowerCase(),
      );
      if (!ins.length) throw new Error('transaction paid no output token to the recipient');
      realized = ins.reduce((a, l) => a + l.args.value, 0n);
      fee = 0n;
    }
  }
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
    fee: fee === null ? null : formatAtomic(fee, dOut),
    quotedRate,
    realizedRate,
    slippageVsQuoteBps: realizedRate === null ? null : Math.round(((quotedRate - realizedRate) / quotedRate) * 10_000 * 100) / 100,
    explorer: `${m.explorer ?? 'https://celoscan.io'}/tx/${txHash}`,
  };
  return { id: `r_${txHash.slice(2, 18)}`, ...body, hash: receiptHash(body) };
}
