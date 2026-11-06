import { type NextRequest, NextResponse } from 'next/server';
import { clientIp, limit, type RULES } from '@/lib/ratelimit';

/**
 * Server-side proxy to the fisika API. The internal key (no x402 charge for fisika's own UI) never reaches the
 * browser. Admin calls forward the operator's own bearer token, which the server does not store.
 */
const API = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const INTERNAL = process.env.INTERNAL_API_KEY ?? '';

const GET_ALLOWED = [
  /^health$/,
  /^v1\/(board|pairs|heatmap|arb|stats|chains)$/,
  /^v1\/receipts(\/[\w-]+)?$/,
  /^v1\/admin\/state$/,
  /^v1\/agent\/(nonce|session|config|state|balances|trades|activity)$/,
  /^v1\/agent\/withdrawals\/(celo|bsc)\/w_[0-9a-z-]{8,64}$/,
];
const POST_ALLOWED = [/^v1\/(quote|build|receipts)$/, /^v1\/admin\/kill$/, /^v1\/agent\/(login|logout|control|deposits|withdraw)$/];
const AGENT_COOKIE = 'fisika_agent';

async function forward(req: NextRequest, path: string[], method: 'GET' | 'POST') {
  const p = path.join('/');
  // Optional chain prefix (bsc/v1/board); Celo is unprefixed.
  const bare = p.replace(/^bsc\//, '');
  const allowed = (method === 'GET' ? GET_ALLOWED : POST_ALLOWED).some((r) => r.test(bare));
  if (!allowed) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const agent = p.startsWith('v1/agent/');
  // The console's state-changing calls must come from this site's own pages (the session cookie is also SameSite=Strict).
  if (agent && method === 'POST') {
    const origin = req.headers.get('origin');
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    if (!origin || !host || new URL(origin).host !== host) return NextResponse.json({ error: 'cross-site request refused' }, { status: 403 });
  }
  const kind: keyof typeof RULES = agent
    ? method === 'GET'
      ? 'agentRead'
      : 'agentAction'
    : bare.startsWith('v1/admin/')
    ? 'admin'
    : method === 'GET'
      ? 'read'
      : bare === 'v1/quote'
        ? 'quote'
        : bare === 'v1/build'
          ? 'build'
          : 'receipts';
  const wait = limit(kind, clientIp(req.headers));
  if (wait) return NextResponse.json({ error: `Too many requests. Try again in ${wait}s.` }, { status: 429, headers: { 'retry-after': String(wait) } });
  const body = method === 'POST' ? await req.text() : undefined;
  if (body && body.length > 4_096) return NextResponse.json({ error: 'request body too large' }, { status: 413 });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (agent) {
    // Only the console's own session cookie is passed on; the API checks it on every call.
    const c = req.cookies.get(AGENT_COOKIE)?.value;
    if (c) headers.cookie = `${AGENT_COOKIE}=${c}`;
  } else if (bare.startsWith('v1/admin/')) {
    const auth = req.headers.get('authorization');
    if (auth) headers.authorization = auth;
  } else if (INTERNAL) {
    headers['x-api-key'] = INTERNAL;
  }
  const qs = req.nextUrl.search;
  try {
    const res = await fetch(`${API}/${p}${qs}`, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    const out: Record<string, string> = { 'content-type': res.headers.get('content-type') ?? 'application/json' };
    if (agent) {
      out['cache-control'] = 'no-store';
      const disp = res.headers.get('content-disposition');
      if (disp) out['content-disposition'] = disp;
    }
    const r = new NextResponse(await res.text(), { status: res.status, headers: out });
    if (agent) {
      const set = res.headers.get('set-cookie');
      if (set && set.startsWith(`${AGENT_COOKIE}=`)) r.headers.set('set-cookie', set);
    }
    return r;
  } catch {
    return NextResponse.json({ error: 'The fisika API is unreachable. Check API_URL on the web server.' }, { status: 502 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path, 'GET');
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path, 'POST');
}
