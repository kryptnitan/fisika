import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, encodeFunctionResult, type PublicClient } from 'viem';
import { BatchReader, multicall2Abi } from '../src/chain/batch.ts';
import { erc20Abi, redactRpc, vetRpcs } from '../src/chain/viem.ts';

const TOKEN = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e';
const BAD = '0x00000000000000000000000000000000000000bd';

/** Fake chain: tokens answer decimals() = 6, BAD reverts; optionally the whole multicall fails. */
function fakeClient(opts: { failAggregate?: boolean } = {}) {
  const calls: number[] = [];
  let direct = 0;
  const client = {
    async call({ to, data }: { to: string; data: `0x${string}` }) {
      if (to.toLowerCase() === '0x633987602de5c4f337e3dbf265303a1080324204') {
        if (opts.failAggregate) throw new Error('gas cap');
        const { args } = decodeFunctionData({ abi: multicall2Abi, data });
        const list = args[1] as readonly { target: string; callData: string }[];
        calls.push(list.length);
        const results = list.map((c) => (c.target.toLowerCase() === BAD ? { success: false, returnData: '0x' as const } : { success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: 6 }) }));
        return { data: encodeFunctionResult({ abi: multicall2Abi, functionName: 'tryAggregate', result: results }) };
      }
      direct += 1;
      if (to.toLowerCase() === BAD) throw new Error('revert');
      return { data: encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: 6 }) };
    },
  };
  return { client: client as unknown as PublicClient, calls, direct: () => direct };
}

describe('batch reader', () => {
  it('coalesces concurrent reads into chunked multicalls and isolates reverts', async () => {
    const f = fakeClient();
    const r = new BatchReader(f.client, { chunkSize: 25 });
    const reads = Array.from({ length: 60 }, (_, i) => r.read<number>({ address: i === 7 ? BAD : TOKEN, abi: erc20Abi, functionName: 'decimals' }));
    const out = await Promise.all(reads);
    assert.deepEqual(f.calls, [25, 25, 10], '60 reads -> 3 eth_calls');
    assert.equal(r.requests, 3);
    assert.equal(out[7], null, 'a reverting read resolves to null');
    assert.equal(out.filter((x) => x === 6).length, 59);
  });

  it('falls back to direct calls when a whole aggregate fails, so nothing is silently dropped', async () => {
    const f = fakeClient({ failAggregate: true });
    const r = new BatchReader(f.client);
    const out = await Promise.all([TOKEN, BAD, TOKEN].map((a) => r.read<number>({ address: a as `0x${string}`, abi: erc20Abi, functionName: 'decimals' })));
    assert.deepEqual(out, [6, null, 6]);
    assert.equal(f.direct(), 3);
  });
});

describe('rpc vetting', () => {
  const rpc = (chainId: number, block: number) => async (_url: string | URL | Request, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body));
    const result = method === 'eth_chainId' ? `0x${chainId.toString(16)}` : `0x${block.toString(16)}`;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  const router = (m: Record<string, ReturnType<typeof rpc> | 'down'>) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const h = m[String(url)];
      if (!h || h === 'down') throw new Error('ECONNREFUSED');
      return h(url, init);
    }) as typeof fetch;

  it('keeps honest endpoints and drops wrong-chain, lagging and dead ones', async () => {
    const v = await vetRpcs(
      ['https://a.example', 'https://b.example/v2/SECRETKEY', 'https://c.example', 'https://d.example'],
      20,
      router({ 'https://a.example': rpc(42220, 1000), 'https://b.example/v2/SECRETKEY': rpc(42220, 995), 'https://c.example': rpc(1, 1000), 'https://d.example': 'down' }),
    );
    assert.deepEqual(v.ok, ['https://a.example', 'https://b.example/v2/SECRETKEY']);
    assert.equal(v.rejected.length, 2);
    assert.match(v.rejected.find((r) => r.rpc.startsWith('https://c'))!.reason, /wrong chain/);
    const lag = await vetRpcs(['https://a.example', 'https://b.example'], 20, router({ 'https://a.example': rpc(42220, 1000), 'https://b.example': rpc(42220, 900) }));
    assert.deepEqual(lag.ok, ['https://a.example']);
    assert.match(lag.rejected[0]!.reason, /100 blocks behind/);
    assert.ok(!JSON.stringify({ r: v.rejected, b: v.blocks }).includes('SECRETKEY'), 'keys never appear in what gets logged');
  });

  it('redacts API keys from RPC URLs', () => {
    assert.equal(redactRpc('https://celo-mainnet.g.alchemy.com/v2/abc123'), 'https://celo-mainnet.g.alchemy.com/…');
    assert.equal(redactRpc('https://forno.celo.org'), 'https://forno.celo.org');
  });
});
