/**
 * Turns a Route into FisikaExecutor calldata and the unsigned transactions a client signs from its own wallet.
 * Non-custodial: the client approves the executor for the exact input and calls execute(); funds are pulled
 * from the client, swapped, and the output is sent to the client's recipient in the same transaction.
 */
import { encodeFunctionData, keccak256, toHex, zeroAddress, type Hex } from 'viem';
import { MENTO, UNISWAP_V3 } from '../addresses.ts';
import type { Route } from '../router.ts';
import type { V3DexConfig } from '../chains.ts';
import type { Address, Edge } from '../types.ts';
import { brokerAbi, erc20Abi, mentoRouterAbi } from './viem.ts';

export const NO_PATCH = 65535;

export const swapRouter02Abi = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

/**
 * Original Uniswap v3-periphery SwapRouter shape (PancakeSwap v3 SwapRouter keeps it): exactInputSingle carries a
 * deadline inside the params struct. SwapRouter02 (above) dropped it.
 */
export const v3SwapRouterAbi = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

/** exactInputSingle calldata for either router shape. */
export function encodeV3ExactInputSingle(
  kind: V3DexConfig['routerKind'],
  p: { tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountIn: bigint; amountOutMinimum: bigint; deadline: bigint },
): Hex {
  if (kind === 'swaprouter02') {
    return encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: 'exactInputSingle',
      args: [{ tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, recipient: p.recipient, amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum, sqrtPriceLimitX96: 0n }],
    });
  }
  return encodeFunctionData({
    abi: v3SwapRouterAbi,
    functionName: 'exactInputSingle',
    args: [{ tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, recipient: p.recipient, deadline: p.deadline, amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum, sqrtPriceLimitX96: 0n }],
  });
}

const stepTuple = {
  name: 'steps',
  type: 'tuple[]',
  components: [
    { name: 'target', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'amountOffset', type: 'uint16' },
    { name: 'data', type: 'bytes' },
  ],
} as const;

export const fisikaExecutorAbi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'routeId', type: 'bytes32' },
      stepTuple,
      { name: 'tokenIn', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'tokenOut', type: 'address' },
      { name: 'minOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'feeBps', type: 'uint16' },
      { name: 'feeTo', type: 'address' },
    ],
    outputs: [{ name: 'netOut', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Executed',
    inputs: [
      { name: 'routeId', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'tokenIn', type: 'address', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'tokenOut', type: 'address', indexed: false },
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'recipient', type: 'address', indexed: false },
    ],
  },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;

export interface ExecutorStep {
  target: Address;
  spender: Address;
  tokenIn: Address;
  amountIn: bigint;
  amountOffset: number;
  data: Hex;
}

export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: string;
  chainId: number;
  description: string;
}

/** Contracts the executor must allowlist (target and spender) before any route can use them. */
export const EXECUTOR_VENUE_TARGETS: readonly Address[] = [UNISWAP_V3.swapRouter02, MENTO.router, MENTO.brokerV2];

/** Encode one hop. `amount` is the planned input; `executor` receives the output so the next hop can spend it. */
export function encodeHop(e: Edge, amount: bigint, executor: Address, deadline: bigint): Omit<ExecutorStep, 'amountIn' | 'amountOffset'> & { offset: number } {
  switch (e.venue) {
    case 'uniswap-v3': {
      const fee = Number(e.meta?.fee);
      if (!Number.isInteger(fee)) throw new Error(`uniswap edge ${e.poolId} has no fee tier`);
      return {
        target: UNISWAP_V3.swapRouter02,
        spender: UNISWAP_V3.swapRouter02,
        tokenIn: e.tokenIn,
        // selector(4) + tokenIn, tokenOut, fee, recipient → amountIn at byte 132
        offset: 132,
        data: encodeFunctionData({
          abi: swapRouter02Abi,
          functionName: 'exactInputSingle',
          args: [{ tokenIn: e.tokenIn, tokenOut: e.tokenOut, fee, recipient: executor, amountIn: amount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
        }),
      };
    }
    case 'mento':
      return {
        target: MENTO.router,
        spender: MENTO.router,
        tokenIn: e.tokenIn,
        offset: 4, // amountIn is the first argument
        data: encodeFunctionData({
          abi: mentoRouterAbi,
          functionName: 'swapExactTokensForTokens',
          args: [amount, 0n, [{ from: e.tokenIn, to: e.tokenOut, factory: zeroAddress }], executor, deadline],
        }),
      };
    case 'mento-v2':
      return {
        target: MENTO.brokerV2,
        spender: MENTO.brokerV2,
        tokenIn: e.tokenIn,
        // selector(4) + exchangeProvider, exchangeId, tokenIn, tokenOut → amountIn at byte 132
        offset: 132,
        data: encodeFunctionData({
          abi: brokerAbi,
          functionName: 'swapIn',
          args: [MENTO.biPoolManagerV2, e.poolId as Hex, e.tokenIn, e.tokenOut, amount, 0n],
        }),
      };
    case 'textile':
      throw new Error('textile legs settle through a taker-bound firm quote, not inside the executor (aggregator key pending)');
    default:
      // The executor is deployed on Celo only; other chains' venues (PancakeSwap on BNB Chain) are quote-only.
      throw new Error(`venue ${e.venue} has no executor encoding (Celo executor only)`);
  }
}

/**
 * Executor steps for an atomic route. The first hop of each path spends a fixed amount. Later hops spend the
 * executor's whole balance of their input token (amount patched on-chain), which is exact when that
 * intermediate token belongs to one path only. When two split paths share an intermediate token, later hops
 * use a fixed amount reduced by the slippage allowance instead, and any dust is swept back to the caller.
 */
export function executorSteps(route: Route, executor: Address, deadline: bigint, slippageBps: number): ExecutorStep[] {
  if (route.execution !== 'atomic') throw new Error(`route is ${route.execution}; only atomic routes run through the executor`);
  const intermediateUse = new Map<string, number>();
  for (const p of route.paths) for (const e of p.edges.slice(1)) intermediateUse.set(e.tokenIn, (intermediateUse.get(e.tokenIn) ?? 0) + 1);
  const steps: ExecutorStep[] = [];
  for (const p of route.paths) {
    p.edges.forEach((e, i) => {
      const planned = p.hopAmounts[i]!;
      const dynamic = i > 0 && intermediateUse.get(e.tokenIn) === 1;
      const amount = i === 0 ? planned : dynamic ? 0n : (planned * BigInt(10_000 - slippageBps)) / 10_000n;
      const hop = encodeHop(e, dynamic ? planned : amount, executor, deadline);
      steps.push({ target: hop.target, spender: hop.spender, tokenIn: hop.tokenIn, data: hop.data, amountIn: amount, amountOffset: dynamic ? hop.offset : NO_PATCH });
    });
  }
  return steps;
}

export interface BuildParams {
  executor: Address;
  taker: Address;
  recipient: Address;
  slippageBps: number;
  feeBps: number;
  feeTo: Address;
  deadlineSec: number;
  routeId: Hex;
  chainId?: number;
}

/** approve(executor, amountIn) + execute(...), ready for the client's wallet. */
export function buildClientTxs(route: Route, p: BuildParams): { txs: UnsignedTx[]; minOut: bigint } {
  const chainId = p.chainId ?? 42220;
  const deadline = BigInt(p.deadlineSec);
  const steps = executorSteps(route, p.executor, deadline, p.slippageBps);
  const gross = route.grossOut;
  const net = gross - (gross * BigInt(p.feeBps)) / 10_000n;
  const minOut = (net * BigInt(10_000 - p.slippageBps)) / 10_000n;
  return {
    minOut,
    txs: [
      {
        to: route.tokenIn,
        data: encodeFunctionData({ abi: erc20Abi_approve, functionName: 'approve', args: [p.executor, route.amountIn] }),
        value: '0',
        chainId,
        description: 'Approve exactly the input amount to the fisika executor (skip if allowance already covers it; USDT needs a reset to 0 first if a different nonzero allowance exists)',
      },
      {
        to: p.executor,
        data: encodeFunctionData({
          abi: fisikaExecutorAbi,
          functionName: 'execute',
          args: [p.routeId, steps, route.tokenIn, route.amountIn, route.tokenOut, minOut, p.recipient, deadline, p.feeBps, p.feeTo],
        }),
        value: '0',
        chainId,
        description: 'Swap atomically through the fisika executor: every leg fills and the output clears minOut, or nothing happens',
      },
    ],
  };
}

const erc20Abi_approve = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/**
 * Chains without a fisika executor (BNB Chain): a single-hop AMM route becomes approve(router, exact) + the router's
 * own exactInputSingle, sent from the client's wallet with the client as recipient. Same non-custodial guarantee:
 * the router enforces minOut on-chain, funds never touch fisika. Split or multi-hop routes need the executor.
 */
export function buildDirectTxs(
  route: Route,
  dexes: readonly V3DexConfig[],
  p: { recipient: Address; slippageBps: number; deadlineSec: number; chainId: number },
): { txs: UnsignedTx[]; minOut: bigint } {
  if (route.paths.length !== 1 || route.paths[0]!.edges.length !== 1) {
    throw new Error('without an executor on this chain only single-hop, unsplit routes can be built');
  }
  const e = route.paths[0]!.edges[0]!;
  const dex = dexes.find((d) => d.id === e.venue);
  if (!dex) throw new Error(`venue ${e.venue} cannot be built directly on this chain`);
  const fee = Number(e.meta?.fee);
  if (!Number.isInteger(fee)) throw new Error(`edge ${e.poolId} has no fee tier`);
  const minOut = (route.grossOut * BigInt(10_000 - p.slippageBps)) / 10_000n;
  return {
    minOut,
    txs: [
      {
        to: route.tokenIn,
        data: encodeFunctionData({ abi: erc20Abi_approve, functionName: 'approve', args: [dex.router, route.amountIn] }),
        value: '0',
        chainId: p.chainId,
        description: `Approve exactly the input amount to the ${dex.label} router (skip if allowance already covers it)`,
      },
      {
        to: dex.router,
        data: encodeV3ExactInputSingle(dex.routerKind, { tokenIn: e.tokenIn, tokenOut: e.tokenOut, fee, recipient: p.recipient, amountIn: route.amountIn, amountOutMinimum: minOut, deadline: BigInt(p.deadlineSec) }),
        value: '0',
        chainId: p.chainId,
        description: `Swap on ${dex.label} (fee tier ${fee}); reverts unless at least minOut arrives`,
      },
    ],
  };
}

/** Stable route id: hash of the quote id, so receipts can be joined back to quotes from the Executed event. */
export function routeIdFor(quoteId: string): Hex {
  return keccak256(toHex(quoteId));
}

/** Canonical JSON (sorted keys, bigint as decimal string) and its keccak256, for verifiable receipts. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (typeof x === 'bigint') return x.toString();
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    return x;
  };
  return JSON.stringify(norm(v));
}

export function receiptHash(receipt: unknown): Hex {
  return keccak256(toHex(canonicalJson(receipt)));
}

export { erc20Abi };
