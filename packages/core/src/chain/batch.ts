/**
 * Coalesces contract reads into Multicall2.tryAggregate eth_calls.
 *
 * A graph refresh issues a few hundred quote reads at once (every pool × direction × size). Sent one by one that
 * is ~100 requests/second at a 3 s refresh, far beyond any free RPC. Batched, each wave of concurrent reads
 * becomes ceil(n / chunkSize) requests. Reads that revert resolve to null individually, exactly like a direct call
 * that throws. If a whole aggregate call fails (RPC error, gas cap), that chunk falls back to direct calls, so
 * batching can never silently drop a pool.
 *
 * Multicall2 address: Uniswap's Celo deployment (docs.uniswap.org), code verified on-chain by verify-onchain.ts.
 */
import { decodeFunctionResult, encodeFunctionData, type Abi, type Hex, type PublicClient } from 'viem';
import { UNISWAP_V3 } from '../addresses.ts';
import type { Address } from '../types.ts';

export const multicall2Abi = [
  {
    type: 'function',
    name: 'tryAggregate',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'requireSuccess', type: 'bool' },
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/** One contract read. Works for view and for "static-call" functions like QuoterV2.quoteExactInputSingle. */
export interface Read {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export interface Reader {
  read<T = unknown>(r: Read): Promise<T | null>;
  /** Number of eth_call requests sent so far (for usage reporting). */
  readonly requests: number;
}

/** Unbatched: one eth_call per read. */
export class DirectReader implements Reader {
  requests = 0;
  private readonly client: PublicClient;
  constructor(client: PublicClient) {
    this.client = client;
  }
  async read<T>(r: Read): Promise<T | null> {
    this.requests += 1;
    try {
      const data = encodeFunctionData({ abi: r.abi, functionName: r.functionName, args: r.args } as never);
      const res = await this.client.call({ to: r.address, data });
      if (!res.data) return null;
      return decodeFunctionResult({ abi: r.abi, functionName: r.functionName, data: res.data } as never) as T;
    } catch {
      return null;
    }
  }
}

interface Pending {
  r: Read;
  data: Hex;
  resolve: (v: unknown) => void;
}

export class BatchReader implements Reader {
  requests = 0;
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly client: PublicClient;
  private readonly direct: DirectReader;
  private readonly chunkSize: number;
  private readonly waitMs: number;
  private readonly multicall: Address;

  constructor(client: PublicClient, opts: { chunkSize?: number; waitMs?: number; multicall?: Address } = {}) {
    this.client = client;
    this.direct = new DirectReader(client);
    // QuoterV2 can burn ~2.7M gas on a sparse pool; 25 per call keeps the aggregate well under node gas caps.
    this.chunkSize = opts.chunkSize ?? 25;
    this.waitMs = opts.waitMs ?? 5;
    this.multicall = opts.multicall ?? (UNISWAP_V3.multicall2 as Address);
  }

  read<T>(r: Read): Promise<T | null> {
    let data: Hex;
    try {
      data = encodeFunctionData({ abi: r.abi, functionName: r.functionName, args: r.args } as never);
    } catch {
      return Promise.resolve(null);
    }
    return new Promise<T | null>((resolve) => {
      this.queue.push({ r, data, resolve: resolve as (v: unknown) => void });
      this.timer ??= setTimeout(() => void this.flush(), this.waitMs);
    });
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const items = this.queue;
    this.queue = [];
    const chunks: Pending[][] = [];
    for (let i = 0; i < items.length; i += this.chunkSize) chunks.push(items.slice(i, i + this.chunkSize));
    await Promise.all(chunks.map((c) => this.send(c)));
  }

  private async send(chunk: Pending[]): Promise<void> {
    this.requests += 1;
    try {
      const res = await this.client.call({
        to: this.multicall,
        data: encodeFunctionData({ abi: multicall2Abi, functionName: 'tryAggregate', args: [false, chunk.map((p) => ({ target: p.r.address, callData: p.data }))] }),
      });
      if (!res.data) throw new Error('empty multicall result');
      const out = decodeFunctionResult({ abi: multicall2Abi, functionName: 'tryAggregate', data: res.data });
      chunk.forEach((p, i) => {
        const o = out[i];
        if (!o?.success || o.returnData === '0x') return p.resolve(null);
        try {
          p.resolve(decodeFunctionResult({ abi: p.r.abi, functionName: p.r.functionName, data: o.returnData } as never));
        } catch {
          p.resolve(null);
        }
      });
    } catch {
      // Whole aggregate failed: retry each read directly so no pool silently disappears.
      await Promise.all(chunk.map(async (p) => p.resolve(await this.direct.read(p.r))));
      this.requests += this.direct.requests;
      this.direct.requests = 0;
    }
  }
}
