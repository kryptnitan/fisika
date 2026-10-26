/**
 * Production bindings of the adapter reader interfaces, built on viem. Kept apart from the pure core so the
 * routing maths can be tested without a chain.
 *
 * ABI provenance:
 * - QuoterV2 / UniswapV3Factory: Uniswap v3-periphery and v3-core (QuoterV2.sol, UniswapV3Factory.sol).
 * - Mento v3 Router: Route struct {from, to, factory} and swapExactTokensForTokens are taken from Mento's FPMM
 *   docs; getAmountsOut follows the same router family. BOTH are exercised by scripts/verify-onchain.ts
 *   against the live USDC/USDm FPMM before any adapter is enabled. If that check fails, Mento stays off.
 */
import { createPublicClient, fallback, http, zeroAddress, type PublicClient } from 'viem';
import { celo } from 'viem/chains';
import { MENTO, UNISWAP_V3 } from '../addresses.ts';
import type { MentoReader } from '../adapters/mento.ts';
import type { UniV3Reader } from '../adapters/uniswapV3.ts';
import type { Address } from '../types.ts';

export const uniV3FactoryAbi = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const;

export const quoterV2Abi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const mentoRoute = {
  name: 'routes',
  type: 'tuple[]',
  components: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'factory', type: 'address' },
  ],
} as const;

export const mentoRouterAbi = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [{ name: 'amountIn', type: 'uint256' }, mentoRoute],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'swapExactTokensForTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      mentoRoute,
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const;

export const erc20Abi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/** Public client over an RPC failover list. A paid RPC goes first once configured. */
export function makeClient(rpcUrls: readonly string[]): PublicClient {
  if (!rpcUrls.length) throw new Error('no RPC URLs configured');
  return createPublicClient({
    chain: celo,
    transport: fallback(rpcUrls.map((u) => http(u, { timeout: 10_000, retryCount: 1 })), { rank: false }),
  }) as PublicClient;
}

export function viemUniV3Reader(client: PublicClient): UniV3Reader {
  return {
    async getPool(a, b, fee) {
      const pool = await client.readContract({ address: UNISWAP_V3.factory, abi: uniV3FactoryAbi, functionName: 'getPool', args: [a, b, fee] });
      return pool === zeroAddress ? null : (pool.toLowerCase() as Address);
    },
    async quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee }) {
      try {
        const { result } = await client.simulateContract({
          address: UNISWAP_V3.quoterV2,
          abi: quoterV2Abi,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
        });
        return { amountOut: result[0], gasEstimate: result[3] };
      } catch {
        return null;
      }
    },
    blockNumber: () => client.getBlockNumber(),
  };
}

/** Mento's FPMM docs build routes with `factory: address(0)`, meaning the router's default factory. */
export function viemMentoReader(client: PublicClient, factory: Address = zeroAddress): MentoReader {
  const amountOut = async (tokenIn: Address, tokenOut: Address, amountIn: bigint) => {
    try {
      const amounts = await client.readContract({
        address: MENTO.router,
        abi: mentoRouterAbi,
        functionName: 'getAmountsOut',
        args: [amountIn, [{ from: tokenIn, to: tokenOut, factory }]],
      });
      const out = amounts[amounts.length - 1];
      return out && out > 0n ? out : null;
    } catch {
      return null;
    }
  };
  return {
    getAmountOut: amountOut,
    // Breakers, market hours and trading limits all make the router revert. A tiny probe is the cheapest
    // check that covers all three; the SDK's trading-status call can replace it once verified.
    async isTradable(tokenIn, tokenOut) {
      const dec = await client.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'decimals' }).catch(() => null);
      if (dec === null) return false;
      return (await amountOut(tokenIn, tokenOut, 10n ** BigInt(dec))) !== null;
    },
    blockNumber: () => client.getBlockNumber(),
  };
}
