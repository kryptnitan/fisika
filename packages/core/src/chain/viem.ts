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
import { celo, type Chain } from 'viem/chains';
import { MENTO, UNISWAP_V3 } from '../addresses.ts';
import type { MentoReader } from '../adapters/mento.ts';
import type { UniV3Reader } from '../adapters/uniswapV3.ts';
import type { Address } from '../types.ts';
import { DirectReader, type Reader } from './batch.ts';

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

/**
 * Free Celo mainnet endpoints, in trust order:
 * 1. Forno — run by cLabs, the team that builds Celo (docs.celo.org/build/tools/nodes/forno). Best-effort,
 *    rate limited, no SLA.
 * 2. PublicNode — Allnodes' free endpoint, which describes itself as privacy-first (no API key, no account).
 * Both are read-only for fisika in PAPER mode: nothing is signed, so an RPC can at worst feed wrong prices, and
 * vetRpcs() plus the cross-check in LiveGraph guard against that.
 */
export const FREE_CELO_RPCS = ['https://forno.celo.org', 'https://celo-rpc.publicnode.com'] as const;

/** Never log a full RPC URL: paid providers put the API key in the path or query. */
export function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.length > 1 || u.search ? `${u.protocol}//${u.host}/…` : `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid url)';
  }
}

export interface RpcVetting {
  ok: string[];
  rejected: { rpc: string; reason: string }[];
  blocks: Record<string, number>;
}

/**
 * Check every configured RPC before use: it must answer, report the expected chain (default Celo, 42220), and be within
 * `maxLagBlocks` of the highest block any of them reports. A lying or stale endpoint is dropped, not trusted.
 */
export async function vetRpcs(urls: readonly string[], maxLagBlocks = 20, fetchImpl: typeof fetch = fetch, chainId = 42220): Promise<RpcVetting> {
  const probe = async (url: string) => {
    const rpc = async (method: string) => {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { result?: string; error?: { message?: string } };
      if (!body.result) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      return body.result;
    };
    const [chainId, block] = await Promise.all([rpc('eth_chainId'), rpc('eth_blockNumber')]);
    return { chainId: Number(BigInt(chainId)), block: Number(BigInt(block)) };
  };
  const results = await Promise.all(urls.map(async (url) => ({ url, r: await probe(url).catch((e: Error) => e) })));
  const out: RpcVetting = { ok: [], rejected: [], blocks: {} };
  const heads = results.flatMap((x) => (x.r instanceof Error || x.r.chainId !== chainId ? [] : [x.r.block]));
  const top = heads.length ? Math.max(...heads) : 0;
  for (const { url, r } of results) {
    const name = redactRpc(url);
    if (r instanceof Error) out.rejected.push({ rpc: name, reason: `unreachable: ${r.message}` });
    else if (r.chainId !== chainId) out.rejected.push({ rpc: name, reason: `wrong chain ${r.chainId}` });
    else if (top - r.block > maxLagBlocks) out.rejected.push({ rpc: name, reason: `${top - r.block} blocks behind` });
    else {
      out.ok.push(url);
      out.blocks[name] = r.block;
    }
  }
  return out;
}

/** Public client over an RPC failover list: the first healthy endpoint serves, the rest take over on failure. */
export function makeClient(rpcUrls: readonly string[], chain: Chain = celo): PublicClient {
  if (!rpcUrls.length) throw new Error('no RPC URLs configured');
  return createPublicClient({
    chain,
    transport: fallback(rpcUrls.map((u) => http(u, { timeout: 15_000, retryCount: 2 })), { rank: false }),
  }) as PublicClient;
}

export function viemUniV3Reader(
  client: PublicClient,
  reader: Reader = new DirectReader(client),
  dex: { factory: Address; quoterV2: Address } = { factory: UNISWAP_V3.factory, quoterV2: UNISWAP_V3.quoterV2 },
): UniV3Reader {
  return {
    async getPool(a, b, fee) {
      const pool = await reader.read<Address>({ address: dex.factory, abi: uniV3FactoryAbi, functionName: 'getPool', args: [a, b, fee] });
      return !pool || pool === zeroAddress ? null : (pool.toLowerCase() as Address);
    },
    async quoteExactInputSingle({ tokenIn, tokenOut, amountIn, fee }) {
      // QuoterV2 is not a view function, but it returns its result from a static call, so it batches like one.
      const r = await reader.read<readonly [bigint, bigint, number, bigint]>({
        address: dex.quoterV2,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
      });
      return r ? { amountOut: r[0], gasEstimate: r[3] } : null;
    },
    blockNumber: () => client.getBlockNumber(),
  };
}

/** Token decimals never change; cache them so tradability probes cost one read, not two. */
function decimalsCache(reader: Reader) {
  const cache = new Map<string, Promise<number | null>>();
  return (token: Address) => {
    const k = token.toLowerCase();
    let p = cache.get(k);
    if (!p) {
      p = reader.read<number>({ address: token, abi: erc20Abi, functionName: 'decimals' }).then((d) => (d === null ? null : Number(d)));
      cache.set(k, p);
      void p.then((d) => d === null && cache.delete(k)); // retry failures next time
    }
    return p;
  };
}

/** Mento's FPMM docs build routes with `factory: address(0)`, meaning the router's default factory. */
export function viemMentoReader(client: PublicClient, reader: Reader = new DirectReader(client), factory: Address = zeroAddress): MentoReader {
  const decimals = decimalsCache(reader);
  const amountOut = async (tokenIn: Address, tokenOut: Address, amountIn: bigint) => {
    const amounts = await reader.read<readonly bigint[]>({
      address: MENTO.router,
      abi: mentoRouterAbi,
      functionName: 'getAmountsOut',
      args: [amountIn, [{ from: tokenIn, to: tokenOut, factory }]],
    });
    const out = amounts?.[amounts.length - 1];
    return out && out > 0n ? out : null;
  };
  return {
    getAmountOut: amountOut,
    // Breakers, market hours and trading limits all make the router revert. A tiny probe is the cheapest
    // check that covers all three; the SDK's trading-status call can replace it once verified.
    async isTradable(tokenIn, tokenOut) {
      const dec = await decimals(tokenIn);
      if (dec === null) return false;
      return (await amountOut(tokenIn, tokenOut, 10n ** BigInt(dec))) !== null;
    },
    blockNumber: () => client.getBlockNumber(),
  };
}

/* ------------------------------------------------------------------ Mento v2 (Broker + BiPoolManager)
 * Mento's local-currency stables (KESm, NGNm, GHSm, XOFm, ZARm, BRLm, COPm) are not routable through the v3
 * Router's default factory (verified on-chain 26 Oct 2026). They still trade on the v2 Broker. ABIs below are
 * from the verified Broker / BiPoolManager sources on the Celo explorer (mento-core 2.x).
 */
export const biPoolManagerAbi = [
  {
    type: 'function',
    name: 'getExchanges',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: 'exchanges',
        type: 'tuple[]',
        components: [
          { name: 'exchangeId', type: 'bytes32' },
          { name: 'assets', type: 'address[]' },
        ],
      },
    ],
  },
] as const;

export const brokerAbi = [
  {
    type: 'function',
    name: 'getAmountOut',
    stateMutability: 'view',
    inputs: [
      { name: 'exchangeProvider', type: 'address' },
      { name: 'exchangeId', type: 'bytes32' },
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'swapIn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'exchangeProvider', type: 'address' },
      { name: 'exchangeId', type: 'bytes32' },
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export interface MentoV2Exchange {
  exchangeId: `0x${string}`;
  assets: Address[];
}

export async function discoverMentoV2Exchanges(client: PublicClient, manager: Address = MENTO.biPoolManagerV2): Promise<MentoV2Exchange[]> {
  const ex = await client.readContract({ address: manager, abi: biPoolManagerAbi, functionName: 'getExchanges' });
  return ex.map((e) => ({ exchangeId: e.exchangeId, assets: e.assets.map((a) => a.toLowerCase() as Address) }));
}

/** MentoReader over the v2 Broker for a known set of exchanges. A breaker or limit makes getAmountOut revert. */
export function viemMentoV2Reader(client: PublicClient, exchanges: readonly MentoV2Exchange[], manager: Address = MENTO.biPoolManagerV2, reader: Reader = new DirectReader(client)): MentoReader {
  const decimals = decimalsCache(reader);
  const find = (i: Address, o: Address) =>
    exchanges.find((e) => e.assets.includes(i.toLowerCase() as Address) && e.assets.includes(o.toLowerCase() as Address));
  const amountOut = async (tokenIn: Address, tokenOut: Address, amountIn: bigint) => {
    const ex = find(tokenIn, tokenOut);
    if (!ex) return null;
    const out = await reader.read<bigint>({
      address: MENTO.brokerV2,
      abi: brokerAbi,
      functionName: 'getAmountOut',
      args: [manager, ex.exchangeId, tokenIn, tokenOut, amountIn],
    });
    return out && out > 0n ? out : null;
  };
  return {
    getAmountOut: amountOut,
    async isTradable(tokenIn, tokenOut) {
      const dec = await decimals(tokenIn);
      if (dec === null) return false;
      return (await amountOut(tokenIn, tokenOut, 10n ** BigInt(dec))) !== null;
    },
    blockNumber: () => client.getBlockNumber(),
  };
}
