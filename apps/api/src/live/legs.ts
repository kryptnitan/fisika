/**
 * Executes one leg of an arbitrage cycle from the arb wallet, as its own transaction(s).
 *
 * Safety rules enforced here, not left to callers:
 * - Calls only go to known venue contracts of the chain being traded (Celo: SwapRouter02, Mento Router, Mento
 *   Broker; BNB Chain: Uniswap SwapRouter02, PancakeSwap v3 SwapRouter; both: Textile reactor or vault executor).
 *   A Textile API response pointing anywhere else is refused.
 * - Approvals are exact (the leg's input), reset to 0 first when a different allowance exists (USDT rule).
 * - Every swap carries an on-chain minimum output.
 * - The amount received is read from the swap receipt's Transfer logs (what the chain says we got), never trusted
 *   from a quote. A balance read is only a fallback, retried, because a public RPC pool can answer a block behind:
 *   the first live loop was wrongly booked as "not filled" when a lagging node reported the old balance.
 * - Any transaction that was actually sent travels on the error (`sent`), so the caller never mistakes a filled
 *   leg for one that never happened.
 */
import { CELO, MENTO, type Address, type ChainConfig, type Edge, type TextileAdapter } from '@fisika/core';
import { encodeV3ExactInputSingle } from '@fisika/core/build';
import { brokerAbi, erc20Abi, mentoRouterAbi } from '@fisika/core/viem';
import { decodeEventLog, encodeFunctionData, zeroAddress, type Hex, type Log, type PublicClient, type WalletClient } from 'viem';

const lc = (a: string) => a.toLowerCase();
const allowedCache = new Map<string, Set<string>>();
/** The only contracts a leg may call or approve on this chain. */
export function allowedTargets(cfg: ChainConfig): Set<string> {
  let s = allowedCache.get(cfg.key);
  if (!s) {
    s = new Set(
      [
        ...cfg.v3Dexes.map((d) => d.router),
        ...(cfg.mento ? [MENTO.router, MENTO.brokerV2] : []),
        ...(cfg.textile ? [cfg.textile.reactor, cfg.textile.vaultOrderExecutor] : []),
      ].map(lc),
    );
    allowedCache.set(cfg.key, s);
  }
  return s;
}

const approveAbi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface TxCost {
  hash: Hex;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** Logs of the mined transaction; the swap's Transfer events tell how much the wallet received. */
  logs?: Log[];
}

/** An error from a leg; `sent` lists every transaction that was broadcast before it, mined or not. */
export class LegError extends Error {
  readonly retryable: boolean;
  sent: TxCost[] = [];
  constructor(message: string, retryable: boolean, sent: TxCost[] = []) {
    super(message);
    this.retryable = retryable;
    this.sent = sent;
  }
}

export interface LegResult {
  amountOut: bigint;
  txs: TxCost[];
}


export interface Chain {
  pub: PublicClient;
  wallet: WalletClient;
  account: Address;
  /** Seconds to wait for a receipt before giving up on a transaction. */
  receiptTimeoutSec?: number;
  /** Which chain this wallet trades on. Defaults to Celo. */
  config?: ChainConfig;
}

const cfgOf = (c: Chain) => c.config ?? CELO;

export async function balanceOf(c: Chain, token: Address): Promise<bigint> {
  return c.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [c.account] });
}

async function send(c: Chain, to: Address, data: Hex): Promise<TxCost> {
  if (!allowedTargets(cfgOf(c)).has(lc(to)) && !(await isTokenCall(c, to))) throw new LegError(`refusing to call unknown contract ${to}`, false);
  let hash: Hex;
  try {
    hash = await c.wallet.sendTransaction({ account: c.wallet.account!, chain: c.wallet.chain, to, data, value: 0n });
  } catch (e) {
    // Gas estimation simulates the call first: a swap that would miss its minimum fails here, before anything is
    // sent and without spending gas. That is the market moving, so it is retryable after a fresh quote.
    const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message.split('\n')[0]!;
    throw new LegError(`not sent: ${msg}`, true);
  }
  let r;
  try {
    r = await c.pub.waitForTransactionReceipt({ hash, timeout: (c.receiptTimeoutSec ?? 90) * 1000 });
  } catch (e) {
    // No receipt in time does not mean no transaction: it was broadcast and may well mine. Never retry on top of it.
    throw new LegError(`no receipt for ${hash} within ${c.receiptTimeoutSec ?? 90}s: ${(e as Error).message.split('\n')[0]}`, false, [{ hash, gasUsed: 0n, effectiveGasPrice: 0n }]);
  }
  const cost: TxCost = { hash, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, logs: r.logs };
  if (r.status !== 'success') throw Object.assign(new LegError(`transaction reverted: ${hash}`, true, [cost]), { cost });
  return cost;
}

const transferAbi = [{ type: 'event', name: 'Transfer', inputs: [{ indexed: true, name: 'from', type: 'address' }, { indexed: true, name: 'to', type: 'address' }, { indexed: false, name: 'value', type: 'uint256' }] }] as const;

/** Sum of `token` Transfer events into the wallet in these logs: the chain's own statement of what the swap paid. */
export function receivedFromLogs(logs: Log[] | undefined, token: Address, account: Address): bigint | null {
  if (!logs) return null;
  let sum = 0n;
  let seen = false;
  for (const l of logs) {
    if (lc(l.address) !== lc(token)) continue;
    try {
      const ev = decodeEventLog({ abi: transferAbi, data: l.data, topics: l.topics });
      if (ev.eventName === 'Transfer' && lc(ev.args.to) === lc(account)) {
        sum += ev.args.value;
        seen = true;
      }
    } catch {
      /* not a Transfer */
    }
  }
  return seen ? sum : null;
}

/** Balance read that waits for a lagging node: returns once the balance is at least `atLeast`, or the last reading. */
async function balanceAtLeast(c: Chain, token: Address, atLeast: bigint, tries = 10): Promise<bigint> {
  let last = 0n;
  for (let i = 0; i < tries; i++) {
    last = await balanceOf(c, token);
    if (last >= atLeast) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

/** Approvals go to token contracts; only tokens the registry knows are passed in by the trader. */
const knownTokens = new Set<string>();
export function registerTokens(addrs: readonly string[]): void {
  for (const a of addrs) knownTokens.add(lc(a));
}
async function isTokenCall(_c: Chain, to: Address): Promise<boolean> {
  return knownTokens.has(lc(to));
}

async function approveExact(c: Chain, token: Address, spender: Address, amount: bigint): Promise<TxCost[]> {
  if (!allowedTargets(cfgOf(c)).has(lc(spender))) throw new LegError(`refusing to approve unknown spender ${spender}`, false);
  const current = await c.pub.readContract({ address: token, abi: approveAbi, functionName: 'allowance', args: [c.account, spender] });
  if (current >= amount && current - amount < amount / 100n + 1n) return []; // already (about) exact
  const txs: TxCost[] = [];
  if (current > 0n) txs.push(await send(c, token, encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [spender, 0n] })));
  txs.push(await send(c, token, encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [spender, amount] })));
  return txs;
}

/** Run one leg: spend exactly `amountIn` of e.tokenIn, require at least `minOut` of e.tokenOut. */
export async function executeLeg(c: Chain, e: Edge, amountIn: bigint, minOut: bigint, textile: TextileAdapter | null, deadlineSec: number): Promise<LegResult> {
  const txs: TxCost[] = [];
  try {
    return await runLeg(c, e, amountIn, minOut, textile, deadlineSec, txs);
  } catch (err) {
    // Whatever went wrong, the caller must know what was broadcast.
    if (err instanceof LegError) {
      for (const t of txs) if (!err.sent.some((x) => x.hash === t.hash)) err.sent.push(t);
      throw err;
    }
    throw new LegError((err as Error).message.split('\n')[0]!, false, [...txs]);
  }
}

async function runLeg(c: Chain, e: Edge, amountIn: bigint, minOut: bigint, textile: TextileAdapter | null, deadlineSec: number, txs: TxCost[]): Promise<LegResult> {
  const cfg = cfgOf(c);
  const before = await balanceOf(c, e.tokenOut);
  const deadline = BigInt(deadlineSec);

  switch (e.venue) {
    case 'uniswap-v3':
    case 'pancake-v3': {
      const dex = cfg.v3Dexes.find((d) => d.id === e.venue);
      if (!dex) throw new LegError(`${e.venue} is not configured on ${cfg.name}`, false);
      const fee = Number(e.meta?.fee);
      if (!Number.isInteger(fee)) throw new LegError(`${e.venue} edge ${e.poolId} has no fee tier`, false);
      txs.push(...(await approveExact(c, e.tokenIn, dex.router, amountIn)));
      txs.push(
        await send(
          c,
          dex.router,
          encodeV3ExactInputSingle(dex.routerKind, { tokenIn: e.tokenIn, tokenOut: e.tokenOut, fee, recipient: c.account, amountIn, amountOutMinimum: minOut, deadline }),
        ),
      );
      break;
    }
    case 'mento': {
      if (!cfg.mento) throw new LegError(`Mento is not on ${cfg.name}`, false);
      txs.push(...(await approveExact(c, e.tokenIn, MENTO.router, amountIn)));
      txs.push(
        await send(
          c,
          MENTO.router,
          encodeFunctionData({ abi: mentoRouterAbi, functionName: 'swapExactTokensForTokens', args: [amountIn, minOut, [{ from: e.tokenIn, to: e.tokenOut, factory: zeroAddress }], c.account, deadline] }),
        ),
      );
      break;
    }
    case 'mento-v2': {
      if (!cfg.mento) throw new LegError(`Mento is not on ${cfg.name}`, false);
      txs.push(...(await approveExact(c, e.tokenIn, MENTO.brokerV2, amountIn)));
      txs.push(
        await send(
          c,
          MENTO.brokerV2,
          encodeFunctionData({ abi: brokerAbi, functionName: 'swapIn', args: [MENTO.biPoolManagerV2, e.poolId as Hex, e.tokenIn, e.tokenOut, amountIn, minOut] }),
        ),
      );
      break;
    }
    case 'textile': {
      if (!textile) throw new LegError('Textile leg needs TEXTILE_API_KEY', false);
      const q = await textile.firmQuote({ sellToken: e.tokenIn, buyToken: e.tokenOut, sellAmount: amountIn, taker: c.account });
      if (q.status !== 'quoted') throw new LegError(`Textile gave no quote: ${q.reason}`, true);
      if (q.buyAmount < minOut) throw new LegError(`Textile firm quote ${q.buyAmount} below minimum ${minOut}`, true);
      if (q.takerPays > amountIn) throw new LegError('Textile asked for more than the leg input', false);
      if (!allowedTargets(cfg).has(lc(q.swap.to)) || !allowedTargets(cfg).has(lc(q.spender))) throw new LegError(`Textile response points at an unknown contract (${q.swap.to}, ${q.spender})`, false);
      if (q.swap.value !== 0n) throw new LegError('Textile swap asks for native value', false);
      txs.push(...(await approveExact(c, e.tokenIn, q.spender, q.takerPays)));
      // The approval must be mined before the swap; and never broadcast after the accept cutoff.
      if (Date.now() >= q.expiresAt - 1_500) throw new LegError('Textile quote expired during approval', true);
      const swap = await send(c, q.swap.to, q.swap.data);
      txs.push(swap);
      void textile.submit(q.rfqId, swap.hash);
      break;
    }
    default:
      throw new LegError(`no live execution for venue ${e.venue}`, false);
  }

  // What did the swap pay? The receipt's Transfer events are authoritative; a balance read is the fallback and is
  // retried because a public RPC pool can answer from a node that has not seen the block yet.
  const swapTx = txs[txs.length - 1];
  const fromLogs = receivedFromLogs(swapTx?.logs, e.tokenOut, c.account);
  const received = fromLogs ?? (await balanceAtLeast(c, e.tokenOut, before + minOut)) - before;
  if (received < minOut) throw new LegError(`received ${received}, below minimum ${minOut} (${fromLogs === null ? 'balance' : 'receipt'})`, false, [...txs]);
  return { amountOut: received, txs };
}
