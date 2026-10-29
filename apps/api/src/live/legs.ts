/**
 * Executes one leg of an arbitrage cycle from the arb wallet, as its own transaction(s).
 *
 * Safety rules enforced here, not left to callers:
 * - Calls only go to known venue contracts (SwapRouter02, Mento Router, Mento Broker, Textile reactor or vault
 *   executor). A Textile API response pointing anywhere else is refused.
 * - Approvals are exact (the leg's input), reset to 0 first when a different allowance exists (USDT rule).
 * - Every swap carries an on-chain minimum output.
 * - The amount received is measured from the wallet's balance change, never trusted from a quote.
 */
import { MENTO, TEXTILE, UNISWAP_V3, type Address, type Edge, type TextileAdapter } from '@fisika/core';
import { swapRouter02Abi } from '@fisika/core/build';
import { brokerAbi, erc20Abi, mentoRouterAbi } from '@fisika/core/viem';
import { encodeFunctionData, zeroAddress, type Hex, type PublicClient, type WalletClient } from 'viem';

const lc = (a: string) => a.toLowerCase();
const ALLOWED_TARGETS = new Set([UNISWAP_V3.swapRouter02, MENTO.router, MENTO.brokerV2, TEXTILE.reactor, TEXTILE.vaultOrderExecutor].map(lc));

const approveAbi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface TxCost {
  hash: Hex;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export interface LegResult {
  amountOut: bigint;
  txs: TxCost[];
}

export class LegError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export interface Chain {
  pub: PublicClient;
  wallet: WalletClient;
  account: Address;
  /** Seconds to wait for a receipt before giving up on a transaction. */
  receiptTimeoutSec?: number;
}

export async function balanceOf(c: Chain, token: Address): Promise<bigint> {
  return c.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [c.account] });
}

async function send(c: Chain, to: Address, data: Hex): Promise<TxCost> {
  if (!ALLOWED_TARGETS.has(lc(to)) && !(await isTokenCall(c, to))) throw new LegError(`refusing to call unknown contract ${to}`, false);
  const hash = await c.wallet.sendTransaction({ account: c.wallet.account!, chain: c.wallet.chain, to, data, value: 0n });
  const r = await c.pub.waitForTransactionReceipt({ hash, timeout: (c.receiptTimeoutSec ?? 90) * 1000 });
  const cost = { hash, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice };
  if (r.status !== 'success') throw Object.assign(new LegError(`transaction reverted: ${hash}`, true), { cost });
  return cost;
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
  if (!ALLOWED_TARGETS.has(lc(spender))) throw new LegError(`refusing to approve unknown spender ${spender}`, false);
  const current = await c.pub.readContract({ address: token, abi: approveAbi, functionName: 'allowance', args: [c.account, spender] });
  if (current >= amount && current - amount < amount / 100n + 1n) return []; // already (about) exact
  const txs: TxCost[] = [];
  if (current > 0n) txs.push(await send(c, token, encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [spender, 0n] })));
  txs.push(await send(c, token, encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [spender, amount] })));
  return txs;
}

/** Run one leg: spend exactly `amountIn` of e.tokenIn, require at least `minOut` of e.tokenOut. */
export async function executeLeg(c: Chain, e: Edge, amountIn: bigint, minOut: bigint, textile: TextileAdapter | null, deadlineSec: number): Promise<LegResult> {
  const before = await balanceOf(c, e.tokenOut);
  const txs: TxCost[] = [];
  const deadline = BigInt(deadlineSec);

  switch (e.venue) {
    case 'uniswap-v3': {
      const fee = Number(e.meta?.fee);
      if (!Number.isInteger(fee)) throw new LegError(`uniswap edge ${e.poolId} has no fee tier`, false);
      txs.push(...(await approveExact(c, e.tokenIn, UNISWAP_V3.swapRouter02, amountIn)));
      txs.push(
        await send(
          c,
          UNISWAP_V3.swapRouter02,
          encodeFunctionData({
            abi: swapRouter02Abi,
            functionName: 'exactInputSingle',
            args: [{ tokenIn: e.tokenIn, tokenOut: e.tokenOut, fee, recipient: c.account, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
          }),
        ),
      );
      break;
    }
    case 'mento': {
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
      if (!ALLOWED_TARGETS.has(lc(q.swap.to)) || !ALLOWED_TARGETS.has(lc(q.spender))) throw new LegError(`Textile response points at an unknown contract (${q.swap.to}, ${q.spender})`, false);
      if (q.swap.value !== 0n) throw new LegError('Textile swap asks for native value', false);
      txs.push(...(await approveExact(c, e.tokenIn, q.spender, q.takerPays)));
      // The approval must be mined before the swap; and never broadcast after the accept cutoff.
      if (Date.now() >= q.expiresAt - 1_500) throw new LegError('Textile quote expired during approval', true);
      const swap = await send(c, q.swap.to, q.swap.data);
      txs.push(swap);
      void textile.submit(q.rfqId, swap.hash);
      break;
    }
  }

  const received = (await balanceOf(c, e.tokenOut)) - before;
  if (received < minOut) throw new LegError(`received ${received}, below minimum ${minOut}`, false);
  return { amountOut: received, txs };
}
