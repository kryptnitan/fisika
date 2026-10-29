/**
 * On-chain verification for every address and assumption fisika depends on (research report §9).
 * Run: CHAIN=celo|bsc [RPC_URLS=https://...] node scripts/verify-onchain.ts
 * Writes verification/onchain[-<chain>].json/.md. Exits 1 if any hard check fails.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { formatUnits, zeroAddress, type Address } from 'viem';
import { ERC8004, FEE_CURRENCY_ADAPTERS, MENTO, PERMIT2, TEXTILE, UNISWAP_V3 } from '../packages/core/src/addresses.ts';
import { erc20Abi, makeClient, mentoRouterAbi, uniV3FactoryAbi } from '../packages/core/src/chain/viem.ts';
import { MULTICALL3 } from '../packages/core/src/chain/batch.ts';
import { chainByKey } from '../packages/core/src/chains.ts';

const chain = chainByKey(process.env.CHAIN);
const suffix = chain.key === 'celo' ? '' : `-${chain.key}`;
const rpcEnv = chain.key === 'celo' ? process.env.CELO_RPC_URLS || process.env.RPC_URLS : process.env.RPC_URLS;
const rpcs = (rpcEnv || chain.freeRpcs.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const client = makeClient(rpcs, chain.viem);
const CHAIN_TOKENS = chain.tokens;
const failures: string[] = [];
const report: Record<string, unknown> = { at: new Date().toISOString() };

const pairAbi = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

async function main() {
  const chainId = await client.getChainId();
  report.chainId = chainId;
  report.chain = chain.name;
  if (chainId !== chain.id) failures.push(`RPC chainId ${chainId}, expected ${chain.id}`);
  report.block = (await client.getBlockNumber()).toString();

  // 1. Contract code exists at every configured address.
  const dexContracts = Object.fromEntries(
    chain.v3Dexes.flatMap((d) => [[`${d.id}.factory`, d.factory], [`${d.id}.quoterV2`, d.quoterV2], [`${d.id}.router`, d.router]]),
  );
  const textileContracts = chain.textile
    ? { 'textile.reactor': chain.textile.reactor, 'textile.feeController': chain.textile.feeController, 'textile.vaultOrderExecutor': chain.textile.vaultOrderExecutor }
    : {};
  const contracts: Record<string, string> = chain.key !== 'celo' ? { ...dexContracts, ...textileContracts, multicall3: MULTICALL3, permit2: PERMIT2 } : {
    'uniswap.factory': UNISWAP_V3.factory,
    'uniswap.quoterV2': UNISWAP_V3.quoterV2,
    'uniswap.swapRouter02': UNISWAP_V3.swapRouter02,
    'uniswap.multicall2': UNISWAP_V3.multicall2,
    multicall3: MULTICALL3,
    permit2: PERMIT2,
    'textile.reactor': TEXTILE.reactor,
    'textile.feeController': TEXTILE.feeController,
    'textile.vaultOrderExecutor': TEXTILE.vaultOrderExecutor,
    'erc8004.identity': ERC8004.identityRegistry,
    'erc8004.reputation': ERC8004.reputationRegistry,
    'feeAdapter.USDC': FEE_CURRENCY_ADAPTERS.USDC,
    ...Object.fromEntries(Object.entries(MENTO).filter(([, v]) => typeof v === 'string').map(([k, v]) => [`mento.${k}`, v as string])),
    ...Object.fromEntries(Object.entries(MENTO.fpmmPools).map(([k, v]) => [`mento.pool.${k}`, v])),
  };
  const code: Record<string, number> = {};
  for (const [name, addr] of Object.entries(contracts)) {
    const c = await client.getCode({ address: addr as Address }).catch(() => undefined);
    code[name] = c ? (c.length - 2) / 2 : 0;
    if (!code[name]) failures.push(`no code at ${name} ${addr}`);
  }
  report.codeBytes = code;

  // 2. Token decimals and symbols.
  const tokens: Record<string, { address: string; symbol: string | null; decimals: number | null; configured: number | null; supply?: string }> = {};
  for (const t of CHAIN_TOKENS) {
    const [decimals, symbol] = await Promise.all([
      client.readContract({ address: t.address, abi: erc20Abi, functionName: 'decimals' }).catch(() => null),
      client.readContract({ address: t.address, abi: erc20Abi, functionName: 'symbol' }).catch(() => null),
    ]);
    tokens[t.symbol] = { address: t.address, symbol, decimals: decimals === null ? null : Number(decimals), configured: t.decimals };
    if (decimals === null) failures.push(`${t.symbol}: decimals() failed`);
    else if (t.decimals !== null && Number(decimals) !== t.decimals) failures.push(`${t.symbol}: decimals ${decimals} != configured ${t.decimals}`);
  }
  report.tokens = tokens;
  const dec = (addr: string) => Object.values(tokens).find((t) => t.address === addr.toLowerCase())?.decimals ?? 18;
  const sym = (addr: string) => CHAIN_TOKENS.find((t) => t.address === addr.toLowerCase())?.symbol ?? addr;

  // 3. v3 pools on every DEX: every token against each hub, all fee tiers, with pool balances as depth proxy.
  const hubs = CHAIN_TOKENS.filter((t) => chain.hubs.includes(t.symbol));
  const pools: { dex: string; pair: string; fee: number; pool: string; balances: Record<string, string> }[] = [];
  for (const dex of chain.v3Dexes) for (const hub of hubs) {
    for (const t of CHAIN_TOKENS) {
      if (t.address === hub.address || (t.usd && hubs.indexOf(hub) > hubs.findIndex((h) => h.address === t.address))) continue;
      for (const fee of dex.feeTiers) {
        const pool = await client.readContract({ address: dex.factory, abi: uniV3FactoryAbi, functionName: 'getPool', args: [hub.address, t.address, fee] }).catch(() => zeroAddress);
        if (pool === zeroAddress) continue;
        const [bh, bt] = await Promise.all(
          [hub.address, t.address].map((a) => client.readContract({ address: a, abi: erc20Abi, functionName: 'balanceOf', args: [pool] }).catch(() => 0n)),
        );
        pools.push({
          dex: dex.label,
          pair: `${hub.symbol}/${t.symbol}`,
          fee,
          pool,
          balances: { [hub.symbol]: formatUnits(bh!, dec(hub.address)), [t.symbol]: formatUnits(bt!, dec(t.address)) },
        });
      }
    }
  }
  report.uniswapPools = pools;

  // 4. Mento (Celo only): FPMM pool tokens, router ABI check, and which local tokens quote against USDm.
  const mento: Record<string, unknown> = {};
  if (chain.mento) for (const [name, addr] of Object.entries(MENTO.fpmmPools)) {
    const [t0, t1] = await Promise.all(['token0', 'token1'].map((fn) => client.readContract({ address: addr as Address, abi: pairAbi, functionName: fn as 'token0' }).catch(() => null)));
    let quote: string | null = null;
    if (t0 && t1) {
      const amounts = await client
        .readContract({ address: MENTO.router, abi: mentoRouterAbi, functionName: 'getAmountsOut', args: [10n ** BigInt(dec(t0)), [{ from: t0, to: t1, factory: zeroAddress }]] })
        .catch((e: Error) => `ERR ${e.message.split('\n')[0]}`);
      quote = typeof amounts === 'string' ? amounts : `1 ${sym(t0)} -> ${formatUnits(amounts[amounts.length - 1]!, dec(t1))} ${sym(t1)}`;
    }
    mento[name] = { pool: addr, token0: t0 && sym(t0), token1: t1 && sym(t1), quote };
    if (name === 'USDC/USDm' && (!quote || quote.startsWith('ERR'))) failures.push(`Mento router getAmountsOut ABI check failed on USDC/USDm: ${quote}`);
  }
  const usdm = CHAIN_TOKENS.find((t) => t.symbol === 'USDm');
  if (usdm) for (const t of CHAIN_TOKENS.filter((x) => x.issuer === 'Mento' && !x.usd)) {
    const r = await client
      .readContract({ address: MENTO.router, abi: mentoRouterAbi, functionName: 'getAmountsOut', args: [10n ** BigInt(dec(usdm.address)), [{ from: usdm.address, to: t.address, factory: zeroAddress }]] })
      .then((a) => `1 USDm -> ${formatUnits(a[a.length - 1]!, dec(t.address))} ${t.symbol}`)
      .catch((e: Error) => `not routable via default factory: ${e.message.split('\n')[0]}`);
    mento[`USDm->${t.symbol}`] = r;
  }
  report.mento = mento;

  // 5. Textile public ladder snapshot.
  report.textileLevels = !chain.textile ? 'no Textile on this chain' : await fetch(`${TEXTILE.apiBase}/v2/rfq/levels?chainId=${chain.textile.chainId}`, { signal: AbortSignal.timeout(15_000) })
    .then((r) => r.json())
    .then((b: any) =>
      (b.data?.pairs ?? []).map((p: any) => ({
        pair: `${sym(p.sellToken)}->${sym(p.buyToken)}`,
        min: formatUnits(BigInt(p.minSellAmount), p.sellDecimals),
        max: formatUnits(BigInt(p.maxSellAmount), p.sellDecimals),
        sellDecimals: p.sellDecimals,
        buyDecimals: p.buyDecimals,
        points: p.levels.length,
      })),
    )
    .catch((e: Error) => `ERR ${e.message}`);

  report.failures = failures;
  await mkdir('verification', { recursive: true });
  await writeFile(`verification/onchain${suffix}.json`, JSON.stringify(report, null, 2));
  await writeFile(`verification/onchain${suffix}.md`, toMarkdown());
  console.log(toMarkdown());
  if (failures.length) process.exit(1);
}

function toMarkdown(): string {
  const lines = [`# On-chain verification — ${chain.name}`, ``, `Block ${report.block} · ${report.at}`, ``];
  lines.push(failures.length ? `## FAILURES\n${failures.map((f) => `- ${f}`).join('\n')}` : `All hard checks passed.`, '');
  lines.push('## Tokens', '| Token | On-chain symbol | Decimals | Configured |', '|---|---|---|---|');
  for (const [k, v] of Object.entries(report.tokens as Record<string, any>)) lines.push(`| ${k} | ${v.symbol} | ${v.decimals} | ${v.configured ?? '—'} |`);
  lines.push('', '## v3 pools', '| DEX | Pair | Fee | Pool | Balances |', '|---|---|---|---|---|');
  for (const p of report.uniswapPools as any[]) lines.push(`| ${p.dex} | ${p.pair} | ${p.fee} | \`${p.pool}\` | ${Object.entries(p.balances).map(([s, b]) => `${Number(b).toFixed(2)} ${s}`).join(' / ')} |`);
  if (chain.mento) lines.push('', '## Mento', '```json', JSON.stringify(report.mento, null, 2), '```');
  lines.push('', '## Textile levels', '```json', JSON.stringify(report.textileLevels, null, 2), '```');
  return lines.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
