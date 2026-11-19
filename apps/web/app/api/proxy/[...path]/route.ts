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
  /^v1\/agent\/(nonce|session|config|state|balances|trades|activity|meme|meme\/trades|executor|identity)$/,
  /^v1\/agent\/withdrawals\/(celo|bsc)\/w_[0-9a-z-]{8,64}$/,
];
const POST_ALLOWED = [/^v1\/(quote|build|receipts)$/, /^v1\/admin\/kill$/, /^v1\/agent\/(login|logout|control|deposits|withdraw|request\/(unwind|clear-halt)|identity)$/];
const AGENT_COOKIE = 'fisika_agent';

/**
 * Who may see what through the website. Nothing but signing in is open to a visitor without a session.
 * - public: the sign-in flow and the chain status dot.
 * - member: a wallet on MEMBER_ADDRESSES (future subscribers): live rates, quoting and swapping from their own wallet.
 * - owner: everything else — the bot's balances, P&L, trades, API revenue, the console and the kill switch.
 * The API checks the console routes again itself; the bot's private data routes also need the internal key below.
 */
type Role = 'owner' | 'member';
const PUBLIC = [/^health$/, /^v1\/agent\/(nonce|login|logout|session)$/];
const MEMBER = [/^v1\/(board|pairs|heatmap|chains)$/, /^v1\/(quote|build)$/, /^v1\/receipts\/[\w-]+$/];
const MEMBER_POST_RECEIPT = /^v1\/receipts$/;

function needs(bare: string, method: 'GET' | 'POST'): 'public' | Role {
  if (PUBLIC.some((r) => r.test(bare))) return 'public';
  if (MEMBER.some((r) => r.test(bare))) return 'member';
  if (method === 'POST' && MEMBER_POST_RECEIPT.test(bare)) return 'member';
  return 'owner';
}

/** The visitor's role, asked of the API (which holds the sessions); cached briefly per session cookie. */
const roles = new Map<string, { role: Role | null; until: number }>();
async function roleOf(req: NextRequest): Promise<Role | null> {
  const c = req.cookies.get(AGENT_COOKIE)?.value;
  if (!c || c.length > 200) return null;
  const hit = roles.get(c);
  if (hit && hit.until > Date.now()) return hit.role;
  let role: Role | null = null;
  try {
    const res = await fetch(`${API}/v1/agent/session`, { headers: { cookie: `${AGENT_COOKIE}=${c}` }, cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      const r = ((await res.json()) as { role?: string }).role;
      role = r === 'owner' || r === 'member' ? r : null;
    }
  } catch {
    return null;
  }
  if (roles.size > 2_000) roles.clear();
  roles.set(c, { role, until: Date.now() + 15_000 });
  return role;
}

async function forward(req: NextRequest, path: string[], method: 'GET' | 'POST') {
  const p = path.join('/');
  // Optional chain prefix (bsc/v1/board); Celo is unprefixed.
  const bare = p.replace(/^bsc\//, '');
  const allowed = (method === 'GET' ? GET_ALLOWED : POST_ALLOWED).some((r) => r.test(bare));
  if (!allowed) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const need = needs(bare, method);
  if (need !== 'public') {
    const role = await roleOf(req);
    if (!role) return NextResponse.json({ error: 'sign in to see this' }, { status: 401 });
    if (need === 'owner' && role !== 'owner') return NextResponse.json({ error: 'only the owner wallet can see this' }, { status: 403 });
  }
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
      if (bare === 'v1/agent/logout' || bare === 'v1/agent/login') {
        const c = req.cookies.get(AGENT_COOKIE)?.value;
        if (c) roles.delete(c);
      }
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
