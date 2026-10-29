import { buildClientTxs, routeIdFor } from '@fisika/core/build';
import type { GraphState } from '@fisika/core/setup';
import { bestRoute, curveOut, SAMPLE_USD, type TokenRegistry } from '@fisika/core';
import { Hono, type MiddlewareHandler } from 'hono';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import type { Hex } from 'viem';
import type { ApiConfig } from './config.ts';
import { QuoteBook, QuoteError, quoteView, type QuoteRequest } from './quotes.ts';
import { makeReceipt, ReceiptStore, type TxReceiptLike } from './receipts.ts';
import type { PaperArbRunner } from './arb.ts';
import type { Heatmap } from './heatmap.ts';
import { registrationFile } from './registration.ts';

export const CORRIDORS: [string, string][] = [
  ['USDT', 'USDC'], ['USDC', 'USDT'], ['USDT', 'USDm'], ['USDm', 'USDT'], ['USDC', 'USDm'],
  ['USDT', 'cNGN'], ['cNGN', 'USDT'], ['USDT', 'NGNm'], ['NGNm', 'USDT'],
  ['USDT', 'KESm'], ['KESm', 'USDT'], ['USDT', 'GHSm'], ['GHSm', 'USDT'], ['USDT', 'XOFm'], ['USDT', 'ZARm'],
  ['USDT', 'wBRL'], ['wBRL', 'USDT'], ['USDT', 'wARS'], ['wARS', 'USDT'], ['USDT', 'BRLA'], ['USDT', 'COPM'],
  ['cNGN', 'KESm'], ['cNGN', 'GHSm'], ['wBRL', 'wARS'], ['cNGN', 'NGNm'],
];

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
        executionEnabled: d.cfg.executionEnabled,
        serviceFeeBps: d.cfg.serviceFeeBps,
        rpcDegraded: st.rpc?.degraded ?? false,
      }),
    );
  });

  app.get('/.well-known/agent-registration.json', (c) => c.json(registrationFile(d.cfg)));

  app.get('/v1/pairs', (c) =>
    c.json({
      chainId: 42220,
      tokens: d.tokens.usable().map((t) => ({ symbol: t.symbol, legacySymbol: t.legacySymbol, address: t.address, decimals: t.decimals, fiat: t.fiat, issuer: t.issuer })),
      corridors: CORRIDORS.map(([a, b]) => `${a}-${b}`),
    }),
  );

  /** Free FX board: best rate per corridor at $10 / $100 / $1,000, which venue wins, and the venue spread. */
  app.get('/v1/board', (c) => {
    const t = now();
    if (boardCache && t - boardCache.at < 2_000) return c.json(boardCache.body);
    const st = s();
    const rows = CORRIDORS.map(([a, b]) => {
      const tin = d.tokens.bySymbol(a).address;
      const tout = d.tokens.bySymbol(b).address;
      const dIn = d.tokens.decimals(tin);
      const dOut = d.tokens.decimals(tout);
      const sizes = SAMPLE_USD.slice(0, 3).map((usd) => {
        const amountIn = st.pricer.amountForUsd(tin, usd, t);
        if (!amountIn) return { usd, rate: null };
        const r = bestRoute(st.graph, st.pricer, { tokenIn: tin, tokenOut: tout, amountIn, nowMs: t, maxAgeMs: d.cfg.edgeMaxAgeMs, gasPriceWei: st.gasPriceWei, celoUsd: st.celoUsd });
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
    const body = json({ asOf: new Date(st.updatedMs).toISOString(), block: st.block, gasPriceWei: st.gasPriceWei, celoUsd: st.celoUsd, rows });
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
    const q = quotes.quote(s(), d.tokens, body, { feeBps: d.cfg.serviceFeeBps, defaultSlippageBps: d.cfg.defaultSlippageBps, maxAgeMs: d.cfg.edgeMaxAgeMs, nowMs: now() });
    return c.json(quoteView(q, d.tokens));
  });

  // ---- paid: build. Gate on configuration BEFORE payment, so nobody pays for a 503.
  app.use('/v1/build', async (c, next) => {
    if (!d.cfg.executionEnabled || !d.cfg.executor) return c.json({ error: 'transaction building is disabled on this deployment (quote-only mode)' }, 503);
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
    if (q.route.execution !== 'atomic') {
      throw new QuoteError(422, `this route needs ${q.route.txCount} transaction(s) including a Textile RFQ leg, which needs a taker-bound firm quote; only atomic routes are built today`);
    }
    const deadlineSec = Math.floor(now() / 1000) + 120;
    const { txs, minOut } = buildClientTxs(q.route, {
      executor: d.cfg.executor!,
      taker: body.taker as Hex,
      recipient: (body.recipient ?? body.taker) as Hex,
      slippageBps: q.slippageBps,
      feeBps: q.feeBps,
      feeTo: d.cfg.feeTo ?? '0x0000000000000000000000000000000000000000',
      deadlineSec,
      routeId: routeIdFor(q.id),
    });
    return c.json(json({ quoteId: q.id, routeId: routeIdFor(q.id), deadline: deadlineSec, minOut, txs, quote: quoteView(q, d.tokens) }));
  });

  // ---- receipts (free): client reports its tx hash; we verify the Executed event on-chain.
  app.post('/v1/receipts', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { quoteId?: string; txHash?: string } | null;
    if (!body?.quoteId || !body.txHash || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) throw new QuoteError(400, 'body must include quoteId and txHash');
    if (!d.cfg.executor) throw new QuoteError(503, 'no executor configured');
    const q = quotes.getAny(body.quoteId);
    if (!q) throw new QuoteError(404, 'unknown quote');
    const tx = await d.getTxReceipt(body.txHash as Hex);
    if (!tx) throw new QuoteError(404, 'transaction not found yet; retry after it is mined');
    let r;
    try {
      r = makeReceipt(q, body.txHash as Hex, tx, d.cfg.executor, d.tokens);
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
    if (d.cfg.live.statusFile) {
      const raw = await readFile(d.cfg.live.statusFile, 'utf8').catch(() => null);
      if (!raw) return c.json({ error: 'live trader has not written a status yet' }, 503);
      return c.json(liveView(JSON.parse(raw), d.cfg.live.killFile));
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
  app.get('/v1/admin/state', (c) => c.json({ arbKilled: d.cfg.live.killFile ? existsSync(d.cfg.live.killFile) : (d.arb?.killed ?? null), executionEnabled: d.cfg.executionEnabled }));
  app.post('/v1/admin/kill', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { on?: boolean; clearHalt?: boolean };
    if (d.cfg.live.killFile) {
      // LIVE: the trader stops starting new cycles as soon as this file exists.
      if (body.on !== false) await writeFile(d.cfg.live.killFile, `stopped from dashboard ${new Date().toISOString()}\n`);
      else await unlink(d.cfg.live.killFile).catch(() => undefined);
      console.warn(`[admin] LIVE kill switch ${body.on !== false ? 'ON' : 'off'}`);
      return c.json({ arbKilled: body.on !== false, note: 'Live trader stops starting new cycles; a cycle in progress finishes first.' });
    }
    if (!d.arb) return c.json({ error: 'arb engine not running' }, 404);
    d.arb.killed = body.on !== false;
    if (body.clearHalt) d.arb.clearHalt();
    console.warn(`[admin] arb kill switch ${d.arb.killed ? 'ON' : 'off'}${body.clearHalt ? ', halt cleared' : ''}`);
    return c.json({ arbKilled: d.arb.killed, note: 'LIVE executor pause is a separate on-chain call from the guardian key' });
  });

  app.get('/openapi.json', (c) => c.json(openapi(d.cfg)));

  return { app, quotes, receipts, stats };
}

function openapi(cfg: ApiConfig) {
  return {
    openapi: '3.1.0',
    info: { title: 'fisika FX API', version: '1', description: 'Best-execution stablecoin FX on Celo. Paid routes use x402 (USDC on Celo, eip155:42220).' },
    servers: [{ url: cfg.publicUrl }],
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
