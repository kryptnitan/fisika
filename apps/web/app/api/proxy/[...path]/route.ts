import { type NextRequest, NextResponse } from 'next/server';

/**
 * Server-side proxy to the fisika API. The internal key (no x402 charge for fisika's own UI) never reaches the
 * browser. Admin calls forward the operator's own bearer token, which the server does not store.
 */
const API = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const INTERNAL = process.env.INTERNAL_API_KEY ?? '';

const GET_ALLOWED = [/^health$/, /^v1\/(board|pairs|heatmap|arb|stats|chains)$/, /^v1\/receipts(\/[\w-]+)?$/, /^v1\/admin\/state$/];
const POST_ALLOWED = [/^v1\/(quote|build|receipts)$/, /^v1\/admin\/kill$/];

async function forward(req: NextRequest, path: string[], method: 'GET' | 'POST') {
  const p = path.join('/');
  // Optional chain prefix (bsc/v1/board); Celo is unprefixed.
  const bare = p.replace(/^bsc\//, '');
  const allowed = (method === 'GET' ? GET_ALLOWED : POST_ALLOWED).some((r) => r.test(bare));
  if (!allowed) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bare.startsWith('v1/admin/')) {
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
      body: method === 'POST' ? await req.text() : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    return new NextResponse(await res.text(), { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
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
