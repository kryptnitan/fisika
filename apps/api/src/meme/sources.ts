/**
 * Market data for the Solana meme desk. Every endpoint below is from the provider's own docs (checked Nov 2026):
 *
 * - DexScreener (docs.dexscreener.com/api/reference): /token-profiles/latest/v1 and /token-boosts/latest/v1 for
 *   discovery (60 req/min), /tokens/v1/{chainId}/{tokenAddresses} for pair data (up to 30 addresses per call).
 * - GeckoTerminal keyless API (docs.coingecko.com/docs/keyless-public-api): base https://api.geckoterminal.com/api/v2,
 *   pool OHLCV at /networks/{network}/pools/{pool}/ohlcv/{timeframe}; about 10 calls/min. Used for all-time highs.
 * - Jupiter (developers.jup.ag): GET https://api.jup.ag/swap/v1/quote for executable prices. Keyless 0.5 req/s,
 *   free key 1 req/s (x-api-key). Live trading later uses /swap/v2/order + /execute.
 * - Solana JSON-RPC: getAccountInfo (jsonParsed) for mint/freeze authority and Token-2022 extensions,
 *   getTokenLargestAccounts for holder concentration.
 *
 * Every client is rate limited on our side and backs off on 429, so a busy market cannot get the desk banned.
 */

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

type Fetch = typeof fetch;

/** Spaces calls to at most `perMinute`, one queue per provider. */
export class Pacer {
  private next = 0;
  private readonly gapMs: number;
  constructor(perMinute: number) {
    this.gapMs = Math.ceil(60_000 / perMinute);
  }
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

export class SourceError extends Error {}

async function getJson<T>(f: Fetch, pacer: Pacer, url: string, init: RequestInit = {}, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    await pacer.wait();
    const res = await f(url, { ...init, signal: AbortSignal.timeout(15_000) }).catch((e: Error) => {
      throw new SourceError(`${new URL(url).host}: ${e.message}`);
    });
    if (res.status === 429 && i < tries - 1) {
      await new Promise((r) => setTimeout(r, 2_000 * 2 ** i));
      continue;
    }
    if (!res.ok) throw new SourceError(`${new URL(url).host} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    return (await res.json()) as T;
  }
}

/* ------------------------------------------------------------------------------------------- DexScreener */

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string | null;
  liquidity?: { usd?: number | null; base?: number; quote?: number };
  volume?: Record<string, number>;
  txns?: Record<string, { buys: number; sells: number }>;
  priceChange?: Record<string, number | null>;
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null;
}

export class DexScreener {
  private readonly f: Fetch;
  private readonly discover = new Pacer(50);
  private readonly pairs = new Pacer(200);
  readonly base = 'https://api.dexscreener.com';
  constructor(f: Fetch = fetch) {
    this.f = f;
  }

  /** Newest Solana tokens with profiles or boosts: where new memes show up first. */
  async latestSolanaTokens(): Promise<string[]> {
    const lists = await Promise.all([
      getJson<{ chainId: string; tokenAddress: string }[]>(this.f, this.discover, `${this.base}/token-profiles/latest/v1`).catch(() => []),
      getJson<{ chainId: string; tokenAddress: string }[]>(this.f, this.discover, `${this.base}/token-boosts/latest/v1`).catch(() => []),
    ]);
    const out = new Set<string>();
    for (const l of lists) for (const t of Array.isArray(l) ? l : []) if (t?.chainId === 'solana' && t.tokenAddress) out.add(t.tokenAddress);
    return [...out];
  }

  /** Pairs for up to 30 Solana tokens per call. */
  async pairsFor(tokens: string[]): Promise<DexPair[]> {
    const out: DexPair[] = [];
    for (let i = 0; i < tokens.length; i += 30) {
      const chunk = tokens.slice(i, i + 30);
      const r = await getJson<DexPair[] | { pairs?: DexPair[] }>(this.f, this.pairs, `${this.base}/tokens/v1/solana/${chunk.join(',')}`);
      out.push(...(Array.isArray(r) ? r : (r.pairs ?? [])));
    }
    return out.filter((p) => p.chainId === 'solana');
  }
}

/** The deepest pair quoted in SOL or USDC for each token. */
export function bestPairs(pairs: DexPair[]): Map<string, DexPair> {
  const best = new Map<string, DexPair>();
  for (const p of pairs) {
    if (![SOL_MINT, USDC_MINT].includes(p.quoteToken?.address)) continue;
    const cur = best.get(p.baseToken.address);
    if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(p.baseToken.address, p);
  }
  return best;
}

/* ----------------------------------------------------------------------------------------- GeckoTerminal */

export class GeckoTerminal {
  private readonly f: Fetch;
  private readonly pacer = new Pacer(9);
  private cache = new Map<string, { atMs: number; ath: number | null }>();
  readonly base = 'https://api.geckoterminal.com/api/v2';
  constructor(f: Fetch = fetch) {
    this.f = f;
  }

  /** Highest USD price in the pool's hourly history (up to 1000 hours back). Cached 10 minutes. */
  async allTimeHigh(pool: string): Promise<number | null> {
    const c = this.cache.get(pool);
    if (c && Date.now() - c.atMs < 600_000) return c.ath;
    const r = await getJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
      this.f,
      this.pacer,
      `${this.base}/networks/solana/pools/${pool}/ohlcv/hour?aggregate=1&limit=1000&currency=usd&token=base`,
      { headers: { accept: 'application/json' } },
    );
    const list = r.data?.attributes?.ohlcv_list ?? [];
    const ath = list.length ? Math.max(...list.map((k) => Number(k[2]) || 0)) : null;
    this.cache.set(pool, { atMs: Date.now(), ath });
    return ath;
  }
}

/* ------------------------------------------------------------------------------------------------ Jupiter */

export interface JupQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan?: { swapInfo?: { label?: string } }[];
}

export class Jupiter {
  private readonly f: Fetch;
  private readonly pacer: Pacer;
  private readonly key: string | undefined;
  readonly base = 'https://api.jup.ag/swap/v1';
  constructor(apiKey?: string, f: Fetch = fetch) {
    this.f = f;
    this.key = apiKey || undefined;
    // Keyless 0.5 req/s, free key 1 req/s; stay a little under.
    this.pacer = new Pacer(this.key ? 55 : 27);
  }
  async quote(inputMint: string, outputMint: string, amount: bigint, slippageBps = 300): Promise<JupQuote | null> {
    if (amount <= 0n) return null;
    const q = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps), restrictIntermediateTokens: 'true' });
    try {
      return await getJson<JupQuote>(this.f, this.pacer, `${this.base}/quote?${q}`, { headers: this.key ? { 'x-api-key': this.key } : {} });
    } catch (e) {
      // "No route" means it cannot be sold/bought right now: a hard signal, not an outage.
      if (/40[04]/.test((e as Error).message)) return null;
      throw e;
    }
  }
}

/* --------------------------------------------------------------------------------------------- Solana RPC */

export interface MintInfo {
  program: string;
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: string[];
}

export class SolanaRpc {
  private readonly f: Fetch;
  private readonly urls: string[];
  private readonly pacer = new Pacer(240);
  private id = 0;
  constructor(urls: string[], f: Fetch = fetch) {
    this.f = f;
    this.urls = urls;
  }
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    let last: Error | null = null;
    for (const url of this.urls) {
      try {
        const r = await getJson<{ result?: T; error?: { message: string } }>(this.f, this.pacer, url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        });
        if (r.error) throw new SourceError(`${method}: ${r.error.message}`);
        return r.result as T;
      } catch (e) {
        last = e as Error;
      }
    }
    throw last ?? new SourceError('no Solana RPC');
  }

  async genesisHash(): Promise<string> {
    return this.call<string>('getGenesisHash', []);
  }

  async mint(address: string): Promise<MintInfo | null> {
    const r = await this.call<{ value: { owner: string; data: { parsed?: { info?: any } } } | null }>('getAccountInfo', [address, { encoding: 'jsonParsed' }]);
    const info = r.value?.data?.parsed?.info;
    if (!r.value || !info) return null;
    return {
      program: r.value.owner,
      decimals: Number(info.decimals),
      supply: BigInt(info.supply ?? '0'),
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      extensions: Array.isArray(info.extensions) ? info.extensions.map((x: { extension: string }) => x.extension) : [],
    };
  }

  /** Raw amounts of the 20 largest token accounts. */
  async largestAccounts(mint: string): Promise<bigint[]> {
    const r = await this.call<{ value: { amount: string }[] }>('getTokenLargestAccounts', [mint]);
    return (r.value ?? []).map((a) => BigInt(a.amount));
  }
}

/** Solana mainnet-beta genesis hash: RPCs that report anything else are not mainnet. */
export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const FREE_SOLANA_RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
