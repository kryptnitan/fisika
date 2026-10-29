import { buildClientTxs, buildDirectTxs, routeIdFor, type UnsignedTx } from '@fisika/core/build';
import type { GraphState } from '@fisika/core/setup';
import { bestRoute, CELO, curveOut, SAMPLE_USD, type Address, type ChainConfig, type TextileAdapter, type TokenRegistry } from '@fisika/core';
import { Hono, type MiddlewareHandler } from 'hono';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { encodeFunctionData, erc20Abi, type Hex } from 'viem';
import type { ApiConfig } from './config.ts';
import { QuoteBook, QuoteError, quoteView, type QuoteRequest } from './quotes.ts';
import { makeReceipt, ReceiptStore, type TxReceiptLike } from './receipts.ts';
import type { PaperArbRunner } from './arb.ts';
import type { Heatmap } from './heatmap.ts';
import { registrationFile } from './registration.ts';

/** Celo corridors (kept for callers that predate multi-chain). Each chain's own list lives in its ChainConfig. */
export const CORRIDORS = CELO.corridors;

export interface AppDeps {
  cfg: ApiConfig;
  tokens: TokenRegistry;
  state: () => GraphState;
  paymentGate: MiddlewareHandler;
  getTxReceipt: (hash: Hex) => Promise<TxReceiptLike | null>;
  arb?: PaperArbRunner;
  heatmap?: Heatmap;
  quotes?: QuoteBook;
  receipts?: ReceiptStore;
  now?: () => number;
  /** Chain this app serves. Defaults to Celo. */
  chain?: ChainConfig;
  /** fisika executor on this chain (only Celo has one). Defaults to cfg.executor on Celo, none elsewhere. */
  executor?: Address | null;
  /** Textile adapter with the API key, for taker-bound firm quotes when a client trades a Textile route. */
  textile?: TextileAdapter | null;
  /** This chain's live trader status and kill files. Defaults to cfg.live on Celo. */
  live?: { statusFile: string | null; killFile: string | null };
}

export interface Stats {
  startedMs: number;
  calls: Record<string, number>;
  paidCalls: number;
  revenueAtomicUsdc: bigint;
  freeTierCalls: number;
  payers: Map<string, number>;
}

/** Decode the x402 PAYMENT-RESPONSE settlement header (base64 JSON) to attribute revenue to a payer. */
export function decodeSettlement(header: string | null | undefined): { payer?: string; transaction?: string; success?: boolean } | null {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Map the live trader's status file onto the shape the dashboard's arb panel reads. */
function liveView(s: any, killFile: string | null) {
  const recent: any[] = s.recent ?? [];
  let equity = 0;
  const eq = recent
    .filter((r) => r.status === 'completed')
    .slice()
    .reverse()
    .map((r) => ({ atMs: Date.parse(r.at), equityUsd: (equity += r.realizedUsd), baselineUsd: 0 }));
  return {
    mode: 'LIVE',
    wallet: s.wallet,
    balances: s.balances,
    killed: killFile ? existsSync(killFile) : s.killed,
    halted: s.halted,
    haltReason: s.haltReason,
    detected: recent.length,
    filled: s.trades,
    winRate: s.trades ? s.wins / s.trades : null,
    realizedUsd: s.realizedUsd,
    todayUsd: s.todayUsd,
    limits: s.limits,
    lastSkip: s.lastSkip,
    updatedAt: s.updatedAt,
    events: recent.map((r) => ({
      atMs: Date.parse(r.at),
      action: r.status === 'completed' ? 'filled' : 'skipped',
      reason: r.status === 'completed' ? undefined : r.note ?? r.status,
      path: r.path,
      venues: r.venues,
      sizeUsd: 0,
      netBps: r.expectedNetBps,
      netUsd: r.realizedUsd,
      txCount: r.txs.length,
      indicativeLegs: 0,
      txs: r.txs,
    })),
    equity: eq,
  };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

export function createApp(d: AppDeps) {
  const now = d.now ?? Date.now;
  const chain = d.chain ?? CELO;
  const executor = d.executor !== undefined ? d.executor : chain.key === 'celo' ? d.cfg.executor : null;
  const live = d.live ?? (chain.key === 'celo' ? d.cfg.live : { statusFile: null, killFile: null });
  // A service fee can only be collected by the executor; routes sent straight to a venue carry none.
  const feeBps = executor ? d.cfg.serviceFeeBps : 0;
  const corridors = chain.corridors;
  const quotes = d.quotes ?? new QuoteBook();
  const receipts = d.receipts ?? new ReceiptStore();
  const stats: Stats = { startedMs: now(), calls: {}, paidCalls: 0, revenueAtomicUsdc: 0n, freeTierCalls: 0, payers: new Map() };
  const freeUse = new Map<string, { day: string; n: number }>();
  let boardCache: { at: number; body: unknown } | null = null;

  const app = new Hono();

  app.use('*', async (c, next) => {
    const key = `${c.req.method} ${c.req.routePath === '*' ? new URL(c.req.url).pathname : c.req.routePath}`;
    stats.calls[key] = (stats.calls[key] ?? 0) + 1;
    await next();
    c.header('Access-Control-Allow-Origin', '*');
    // Revenue attribution from the facilitator's settlement header.
    const settled = decodeSettlement(c.res.headers.get('PAYMENT-RESPONSE'));
    if (settled?.success !== false && settled?.transaction) {
      stats.paidCalls += 1;
      stats.revenueAtomicUsdc += BigInt(c.req.path === '/v1/build' ? d.cfg.x402.buildPriceAtomic : d.cfg.x402.quotePriceAtomic);
      if (settled.payer) stats.payers.set(settled.payer.toLowerCase(), (stats.payers.get(settled.payer.toLowerCase()) ?? 0) + 1);
    }
  });

  app.onError((err, c) => {
    if (err instanceof QuoteError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  const s = () => d.state();

  app.get('/health', (c) => {
    const st = s();
    return c.json(
      json({
        ok: st.updatedMs > 0 && now() - st.updatedMs < d.cfg.edgeMaxAgeMs * 2 && !st.rpc?.degraded,
        block: st.block,
        graphAgeMs: st.updatedMs ? now() - st.updatedMs : null,
        edges: st.graph.size(),
        venues: st.lastRefresh,
        chain: chain.key,
        chainId: chain.id,
        chainName: chain.name,
        executionEnabled: d.cfg.executionEnabled,
        serviceFeeBps: feeBps,
        rpcDegraded: st.rpc?.degraded ?? false,
      }),
    );
  });

  app.get('/.well-known/agent-registration.json', (c) => c.json(registrationFile(d.cfg)));

  app.get('/v1/pairs', (c) =>
    c.json({
      chainId: chain.id,
      chain: chain.key,
      tokens: d.tokens.usable().map((t) => ({ symbol: t.symbol, legacySymbol: t.legacySymbol, address: t.address, decimals: t.decimals, fiat: t.fiat, issuer: t.issuer })),
      corridors: corridors.map(([a, b]) => `${a}-${b}`),
    }),
  );

  /** Free FX board: best rate per corridor at $10 / $100 / $1,000, which venue wins, and the venue spread. */
  app.get('/v1/board', (c) => {
    const t = now();
    if (boardCache && t - boardCache.at < 2_000) return c.json(boardCache.body);
    const st = s();
    const rows = corridors.map(([a, b]) => {
      const tin = d.tokens.bySymbol(a).address;
      const tout = d.tokens.bySymbol(b).address;
      const dIn = d.tokens.decimals(tin);
      const dOut = d.tokens.decimals(tout);
      const sizes = SAMPLE_USD.slice(0, 3).map((usd) => {
        const amountIn = st.pricer.amountForUsd(tin, usd, t);
        if (!amountIn) return { usd, rate: null };
        const r = bestRoute(st.graph, st.pricer, { tokenIn: tin, tokenOut: tout, amountIn, nowMs: t, maxAgeMs: d.cfg.edgeMaxAgeMs, gasPriceWei: st.gasPriceWei, nativeUsd: st.nativeUsd });
        if (!r) return { usd, rate: null };
        // Direct single-hop rate per venue at this size, for the venue-spread column.
        const directByVenue = st.graph.between(tin, tout, t, d.cfg.edgeMaxAgeMs).flatMap((e) => {
          const out = curveOut(e.points, amountIn);
          return out ? [{ venue: e.venue, pool: e.poolId, rate: Number(out) / 10 ** dOut / (Number(amountIn) / 10 ** dIn) }] : [];
        });
        return {
          usd,
          rate: Number(r.amountOut) / 10 ** dOut / (Number(amountIn) / 10 ** dIn),
          venues: r.venues,
          hops: Math.max(...r.paths.map((p) => p.edges.length)),
          split: r.paths.length > 1,
          execution: r.execution,
          firm: r.allFirm,
          directByVenue,
        };
      });
      const r100 = sizes[1];
      // Spread between venues = best direct rate per venue, compared across at least two different venues.
      // (Several pools of one venue are not a venue spread, and a dust pool is not a price.)
      const direct: { venue: string; rate: number }[] = r100 && 'directByVenue' in r100 && r100.directByVenue ? r100.directByVenue : [];
      const bestPerVenue = new Map<string, number>();
      for (const x of direct) bestPerVenue.set(x.venue, Math.max(bestPerVenue.get(x.venue) ?? 0, x.rate));
      // A venue quoting >20% below the best is a broken or dust pool, not a tradable price; leave it out.
      const top = Math.max(0, ...bestPerVenue.values());
      const rates = [...bestPerVenue.values()].filter((r) => r >= top * 0.8);
      const spreadBps = rates.length > 1 ? ((Math.max(...rates) - Math.min(...rates)) / Math.max(...rates)) * 10_000 : null;
      return { corridor: `${a}-${b}`, from: a, to: b, sizes, spreadBps };
    });
    const body = json({ chain: chain.key, chainId: chain.id, asOf: new Date(st.updatedMs).toISOString(), block: st.block, gasPriceWei: st.gasPriceWei, nativeUsd: st.nativeUsd, rows });
    boardCache = { at: t, body };
    return c.json(body);
  });

  // ---- paid: quote. Free-tier API keys skip payment (quotes only).
  const isInternal = (c: { req: { header: (k: string) => string | undefined } }) => {
    const k = c.req.header('x-api-key');
    return !!k && d.cfg.internalKeys.has(k);
  };

  app.use('/v1/quote', async (c, next) => {
    if (isInternal(c)) return next();
    const key = c.req.header('x-api-key');
    if (key && d.cfg.freeTierKeys.has(key)) {
      const day = new Date(now()).toISOString().slice(0, 10);
      const u = freeUse.get(key);
      const n = u && u.day === day ? u.n : 0;
      if (n >= d.cfg.freeTierDailyLimit) return c.json({ error: 'free tier daily limit reached; pay per call with x402 instead' }, 429);
      freeUse.set(key, { day, n: n + 1 });
      stats.freeTierCalls += 1;
      return next();
    }
    return d.paymentGate(c, next);
  });

  app.post('/v1/quote', async (c) => {
    const body = (await c.req.json().catch(() => null)) as QuoteRequest | null;
    if (!body?.tokenIn || !body.tokenOut || !body.amount) throw new QuoteError(400, 'body must include tokenIn, tokenOut, amount');
    const q = quotes.quote(s(), d.tokens, body, { feeBps, defaultSlippageBps: d.cfg.defaultSlippageBps, maxAgeMs: d.cfg.edgeMaxAgeMs, nowMs: now() });
    return c.json({ chain: chain.key, chainId: chain.id, ...quoteView(q, d.tokens) });
  });

  // ---- paid: build. Gate on configuration BEFORE payment, so nobody pays for a 503.
  app.use('/v1/build', async (c, next) => {
    if (!d.cfg.executionEnabled) return c.json({ error: 'transaction building is disabled on this deployment (quote-only mode)' }, 503);
    if (isInternal(c)) return next();
    return d.paymentGate(c, next);
  });

  app.post('/v1/build', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { quoteId?: string; taker?: string; recipient?: string } | null;
    const addr = /^0x[0-9a-fA-F]{40}$/;
    if (!body?.quoteId || !body.taker || !addr.test(body.taker) || (body.recipient && !addr.test(body.recipient))) {
      throw new QuoteError(400, 'body must include quoteId and taker (and optionally recipient) addresses');
    }
    const q = quotes.get(body.quoteId, now());
    if (!q) throw new QuoteError(404, 'quote not found or expired; request a new quote');
    const taker = body.taker.toLowerCase() as Address;
    const recipient = (body.recipient ?? body.taker).toLowerCase() as Address;
    const deadlineSec = Math.floor(now() / 1000) + 120;
    const r = q.route;

    // 1. Executor (Celo): any atomic route, split and multi-hop included, in one all-or-nothing transaction.
    if (executor && r.execution === 'atomic') {
      const { txs, minOut } = buildClientTxs(r, {
        executor,
        taker,
        recipient,
        slippageBps: q.slippageBps,
        feeBps: q.feeBps,
        feeTo: d.cfg.feeTo ?? '0x0000000000000000000000000000000000000000',
        deadlineSec,
        routeId: routeIdFor(q.id),
        chainId: chain.id,
      });
      return c.json(json({ chain: chain.key, quoteId: q.id, routeId: routeIdFor(q.id), mode: 'executor', deadline: deadlineSec, minOut, txs, quote: quoteView(q, d.tokens) }));
    }

    // 2. Textile RFQ, straight from the client's wallet: a firm quote bound to the client as taker.
    if (r.execution === 'textile-direct') {
      if (!d.textile) throw new QuoteError(503, 'Textile trades need TEXTILE_API_KEY on this deployment');
      if (recipient !== taker) throw new QuoteError(400, 'Textile settles to the taker; omit recipient or set it to the taker');
      const e = r.paths[0]!.edges[0]!;
      const minOut = (r.grossOut * BigInt(10_000 - q.slippageBps)) / 10_000n;
      const fq = await d.textile.firmQuote({ sellToken: e.tokenIn, buyToken: e.tokenOut, sellAmount: r.amountIn, taker }, now());
      if (fq.status !== 'quoted') throw new QuoteError(422, `Textile gave no firm quote (${fq.reason}); try again or a smaller size`);
      const allowed = new Set([chain.textile?.reactor, chain.textile?.vaultOrderExecutor].filter(Boolean).map((x) => x!.toLowerCase()));
      if (!allowed.has(fq.swap.to.toLowerCase()) || !allowed.has(fq.spender.toLowerCase())) throw new QuoteError(502, 'Textile response points at an unknown contract; refusing to build it');
      if (fq.swap.value !== 0n) throw new QuoteError(502, 'Textile swap asks for native value; refusing to build it');
      if (fq.takerPays > r.amountIn) throw new QuoteError(422, 'Textile asked for more than the quoted input');
      if (fq.buyAmount < minOut) throw new QuoteError(422, 'the firm price moved past your slippage limit; request a new quote');
      const txs: UnsignedTx[] = [
        {
          to: e.tokenIn,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [fq.spender, fq.takerPays] }),
          value: '0',
          chainId: chain.id,
          description: 'Approve exactly the input amount to Textile (skip if allowance already covers it)',
        },
        { to: fq.swap.to, data: fq.swap.data, value: '0', chainId: chain.id, description: `Fill Textile firm quote ${fq.rfqId}; broadcast before ${new Date(fq.expiresAt).toISOString()}` },
      ];
      q.direct = { target: fq.swap.to.toLowerCase() as Address, recipient: taker, rfqId: fq.rfqId };
      return c.json(json({ chain: chain.key, quoteId: q.id, mode: 'textile', rfqId: fq.rfqId, firmOut: fq.buyAmount, expiresAt: new Date(fq.expiresAt).toISOString(), minOut: fq.buyAmount, txs, quote: quoteView(q, d.tokens) }));
    }

    // 3. No executor here: a single-hop AMM route goes straight to the DEX router, client as recipient.
    if (r.execution === 'atomic') {
      let built;
      try {
        built = buildDirectTxs(r, chain.v3Dexes, { recipient, slippageBps: q.slippageBps, deadlineSec, chainId: chain.id });
      } catch (e) {
        throw new QuoteError(422, `${(e as Error).message}; request a smaller size or a direct pair`);
      }
      q.direct = { target: built.txs.at(-1)!.to.toLowerCase() as Address, recipient };
      return c.json(json({ chain: chain.key, quoteId: q.id, mode: 'direct', deadline: deadlineSec, minOut: built.minOut, txs: built.txs, quote: quoteView(q, d.tokens) }));
    }
    throw new QuoteError(422, `this route needs ${r.txCount} transactions across venues; it cannot be signed as one swap yet`);
  });

  // ---- receipts (free): client reports its tx hash; we verify the Executed event on-chain.
  app.post('/v1/receipts', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { quoteId?: string; txHash?: string } | null;
    if (!body?.quoteId || !body.txHash || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) throw new QuoteError(400, 'body must include quoteId and txHash');
    const q = quotes.getAny(body.quoteId);
    if (!q) throw new QuoteError(404, 'unknown quote');
    if (!q.direct && !executor) throw new QuoteError(409, 'this quote was never built into transactions');
    // Textile wants the hash of a filled firm quote reported back.
    if (q.direct?.rfqId && d.textile) void d.textile.submit(q.direct.rfqId, body.txHash);
    const tx = await d.getTxReceipt(body.txHash as Hex);
    if (!tx) throw new QuoteError(404, 'transaction not found yet; retry after it is mined');
    let r;
    try {
      r = makeReceipt(
        q,
        body.txHash as Hex,
        tx,
        q.direct ? { kind: 'direct', target: q.direct.target, recipient: q.direct.recipient, explorer: chain.explorer } : { kind: 'executor', executor: executor!, explorer: chain.explorer },
        d.tokens,
      );
    } catch (e) {
      throw new QuoteError(422, (e as Error).message);
    }
    receipts.add(r);
    return c.json(r);
  });
  app.get('/v1/receipts', (c) => c.json(receipts.latest(Number(c.req.query('limit') ?? 50))));
  app.get('/v1/receipts/:id', (c) => {
    const r = receipts.get(c.req.param('id'));
    return r ? c.json(r) : c.json({ error: 'not found' }, 404);
  });

  app.get('/v1/stats', (c) =>
    c.json({
      uptimeSec: Math.round((now() - stats.startedMs) / 1000),
      calls: stats.calls,
      paidCalls: stats.paidCalls,
      revenueUsdc: Number(stats.revenueAtomicUsdc) / 1e6,
      freeTierCalls: stats.freeTierCalls,
      topPayers: [...stats.payers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([payer, calls]) => ({ payer, calls })),
    }),
  );

  app.get('/v1/arb', async (c) => {
    if (live.statusFile) {
      const raw = await readFile(live.statusFile, 'utf8').catch(() => null);
      if (!raw) return c.json({ error: `${chain.name} live trader has not written a status yet` }, 503);
      return c.json({ chain: chain.key, ...liveView(JSON.parse(raw), live.killFile) });
    }
    return d.arb ? c.json(json(d.arb.status())) : c.json({ error: 'arb engine not running' }, 404);
  });
  app.get('/v1/heatmap', (c) => c.json(d.heatmap ? { samples: d.heatmap.samples.slice(-Number(c.req.query('limit') ?? 240)) } : { samples: [] }));

  // ---- admin (kill switch). Constant-time-ish bearer check; disabled entirely without ADMIN_TOKEN.
  app.use('/v1/admin/*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const want = d.cfg.adminToken ? `Bearer ${d.cfg.adminToken}` : null;
    if (!want || auth.length !== want.length || !timingSafeEqualStr(auth, want)) return c.json({ error: 'unauthorized' }, 401);
    return next();
  });
  app.get('/v1/admin/state', (c) => c.json({ chain: chain.key, arbKilled: live.killFile ? existsSync(live.killFile) : (d.arb?.killed ?? null), executionEnabled: d.cfg.executionEnabled }));
  app.post('/v1/admin/kill', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { on?: boolean; clearHalt?: boolean };
    if (live.killFile) {
      // LIVE: the trader stops starting new cycles as soon as this file exists.
      if (body.on !== false) await writeFile(live.killFile, `stopped from dashboard ${new Date().toISOString()}\n`);
      else await unlink(live.killFile).catch(() => undefined);
      console.warn(`[admin] ${chain.name} LIVE kill switch ${body.on !== false ? 'ON' : 'off'}`);
      return c.json({ arbKilled: body.on !== false, note: 'Live trader stops starting new cycles; a cycle in progress finishes first.' });
    }
    if (!d.arb) return c.json({ error: 'arb engine not running' }, 404);
    d.arb.killed = body.on !== false;
    if (body.clearHalt) d.arb.clearHalt();
    console.warn(`[admin] arb kill switch ${d.arb.killed ? 'ON' : 'off'}${body.clearHalt ? ', halt cleared' : ''}`);
    return c.json({ arbKilled: d.arb.killed, note: 'LIVE executor pause is a separate on-chain call from the guardian key' });
  });

  app.get('/openapi.json', (c) => c.json(openapi(d.cfg, chain)));

  return { app, quotes, receipts, stats };
}

function openapi(cfg: ApiConfig, chain: ChainConfig) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'fisika FX API',
      version: '1',
      description: `Best-execution stablecoin FX on ${chain.name}. Celo routes live at /v1/*, BNB Chain at /bsc/v1/*; GET /v1/chains lists them. Paid routes use x402 (USDC on Celo, eip155:42220) for every chain.`,
    },
    servers: [{ url: chain.key === 'celo' ? cfg.publicUrl : `${cfg.publicUrl}/${chain.key}` }],
    paths: {
      '/v1/board': { get: { summary: 'Free FX board: best rate per corridor at $10/$100/$1,000' } },
      '/v1/pairs': { get: { summary: 'Supported tokens and corridors' } },
      '/v1/quote': {
        post: {
          summary: `Best route quote (x402: ${Number(cfg.x402.quotePriceAtomic) / 1e6} USDC)`,
          requestBody: { content: { 'application/json': { example: { tokenIn: 'cNGN', tokenOut: 'USDT', amount: '50000', slippageBps: 30 } } } },
        },
      },
      '/v1/build': {
        post: {
          summary: `Unsigned approve + execute transactions for a quote (x402: ${Number(cfg.x402.buildPriceAtomic) / 1e6} USDC)`,
          requestBody: { content: { 'application/json': { example: { quoteId: 'q_…', taker: '0x…', recipient: '0x…' } } } },
        },
      },
      '/v1/receipts': { post: { summary: 'Report a tx hash; returns a verifiable receipt (quoted vs realized)' }, get: { summary: 'Latest receipts' } },
      '/v1/receipts/{id}': { get: { summary: 'Receipt by id or tx hash' } },
      '/v1/stats': { get: { summary: 'Calls served, x402 revenue, top payers' } },
    },
  };
}

/**
 * One API for several chains: /<chain>/v1/... goes to that chain's app (/bsc/v1/board), plain /v1/... goes to the
 * default chain (Celo), and GET /v1/chains lists what this deployment serves.
 */
export function multiChainFetch(apps: Partial<Record<string, { fetch: (req: Request) => Response | Promise<Response> }>>, chains: ChainConfig[], defaultKey = 'celo') {
  const list = chains.map((c) => ({ key: c.key, chainId: c.id, name: c.name, nativeSymbol: c.nativeSymbol, explorer: c.explorer, prefix: c.key === defaultKey ? '' : `/${c.key}` }));
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === '/v1/chains') return Response.json({ default: defaultKey, chains: list }, { headers: { 'Access-Control-Allow-Origin': '*' } });
    const m = /^\/([a-z0-9]+)(\/.*)$/.exec(url.pathname);
    const target = m && apps[m[1]!] ? m[1]! : null;
    if (!target) return apps[defaultKey]!.fetch(req);
    url.pathname = m![2]!;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const inner = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? await req.arrayBuffer() : undefined });
    return apps[target]!.fetch(inner);
  };
}
