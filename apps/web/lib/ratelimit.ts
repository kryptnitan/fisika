/**
 * Fixed-window rate limits for the public site, per visitor IP and overall. In memory: the web server is one
 * process, so this is exact; a restart just resets the windows.
 *
 * The internal API key lets the dashboard quote without paying, so without these limits the public site would be
 * a free, unmetered copy of the paid agent API. Builds are capped hardest: each Textile build holds one of the
 * few live firm quotes Textile allows per key.
 */
export interface Rule {
  perIp: number;
  global: number;
}

export const RULES: Record<string, Rule> = {
  read: { perIp: 240, global: 6_000 }, // board, heatmap, health, arb, ... (the pages poll every few seconds)
  quote: { perIp: 30, global: 600 },
  build: { perIp: 6, global: 30 },
  receipts: { perIp: 30, global: 600 },
  admin: { perIp: 10, global: 30 },
  agentRead: { perIp: 120, global: 600 },
  agentAction: { perIp: 20, global: 60 },
};

const WINDOW_MS = 60_000;
const hits = new Map<string, { start: number; n: number }>();

function take(key: string, limit: number, now: number): boolean {
  const w = hits.get(key);
  if (!w || now - w.start >= WINDOW_MS) {
    hits.set(key, { start: now, n: 1 });
    return true;
  }
  if (w.n >= limit) return false;
  w.n += 1;
  return true;
}

/** Returns seconds to wait, or 0 when the request may go ahead. */
export function limit(kind: keyof typeof RULES, ip: string, now = Date.now()): number {
  const r = RULES[kind]!;
  if (hits.size > 50_000) for (const [k, w] of hits) if (now - w.start >= WINDOW_MS) hits.delete(k);
  const okIp = take(`${kind}:${ip}`, r.perIp, now);
  const okAll = okIp && take(`${kind}:*`, r.global, now);
  if (okIp && okAll) return 0;
  const w = hits.get(okIp ? `${kind}:*` : `${kind}:${ip}`)!;
  return Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000));
}

/**
 * The visitor's IP. In production the site sits behind Caddy on the same machine (Next listens on 127.0.0.1 only),
 * and Caddy writes the client address into X-Forwarded-For, so the last entry is the one Caddy saw.
 */
export function clientIp(h: Headers): string {
  const xff = h.get('x-forwarded-for');
  const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return last || h.get('x-real-ip') || 'local';
}
