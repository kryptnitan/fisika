/**
 * Sign-In With Ethereum (EIP-4361) for the agent console, owner only.
 *
 * - The server issues a random single-use nonce (5 minutes).
 * - The browser asks the wallet to sign a standard SIWE message for this site's domain with that nonce.
 * - The server checks the message (domain, nonce, issued time, expiry), recovers the signer, and only if it is
 *   OWNER_ADDRESS opens a session: a random token in an HttpOnly, SameSite=Strict cookie, valid 30 minutes.
 *
 * Sessions live in memory: a restart signs everyone out, which is the safe direction.
 */
import { randomBytes } from 'node:crypto';
import { verifyMessage, type Hex } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';

export const SESSION_COOKIE = 'fisika_agent';
const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 30 * 60_000;

export interface Session {
  address: string;
  expiresMs: number;
}

export class AgentAuth {
  private nonces = new Map<string, number>();
  private sessions = new Map<string, Session>();
  readonly owner: string | null;
  readonly domains: string[];
  private readonly now: () => number;

  constructor(owner: string | null, domains: string[], now: () => number = Date.now) {
    this.owner = owner ? owner.toLowerCase() : null;
    this.domains = domains;
    this.now = now;
  }

  nonce(): string {
    const t = this.now();
    if (this.nonces.size > 1_000) for (const [n, exp] of this.nonces) if (exp < t) this.nonces.delete(n);
    if (this.nonces.size > 5_000) throw new Error('too many pending sign-ins');
    const n = randomBytes(16).toString('hex');
    this.nonces.set(n, t + NONCE_TTL_MS);
    return n;
  }

  /** Verify a signed SIWE message. Returns a session token, or throws with a reason safe to show. */
  async login(message: string, signature: string): Promise<{ token: string; session: Session }> {
    if (!this.owner) throw new AuthError(503, 'the agent console is not set up on this server (OWNER_ADDRESS is empty)');
    if (typeof message !== 'string' || message.length > 2_000 || !/^0x[0-9a-fA-F]{130}$/.test(signature ?? '')) throw new AuthError(400, 'malformed sign-in');
    const parsed = parseSiweMessage(message);
    if (!parsed.nonce || !parsed.address || !parsed.domain) throw new AuthError(400, 'not a sign-in message');
    // Single use: consumed even if the rest fails.
    const exp = this.nonces.get(parsed.nonce);
    this.nonces.delete(parsed.nonce);
    if (!exp || exp < this.now()) throw new AuthError(401, 'sign-in expired; try again');
    if (!this.domains.includes(parsed.domain)) throw new AuthError(401, 'sign-in is for a different site');
    const issued = parsed.issuedAt?.getTime() ?? 0;
    if (Math.abs(this.now() - issued) > NONCE_TTL_MS) throw new AuthError(401, 'sign-in is too old; try again');
    if (!validateSiweMessage({ message: parsed, domain: parsed.domain, nonce: parsed.nonce, time: new Date(this.now()) })) throw new AuthError(401, 'sign-in is not valid now');
    const ok = await verifyMessage({ address: parsed.address, message, signature: signature as Hex }).catch(() => false);
    if (!ok) throw new AuthError(401, 'signature does not match the address');
    if (parsed.address.toLowerCase() !== this.owner) throw new AuthError(403, 'this wallet is not the owner of this agent');
    const token = randomBytes(32).toString('base64url');
    const session = { address: this.owner, expiresMs: this.now() + SESSION_TTL_MS };
    this.sessions.set(token, session);
    return { token, session };
  }

  session(token: string | undefined): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresMs < this.now() || s.address !== this.owner) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

export class AuthError extends Error {
  readonly status: 400 | 401 | 403 | 503;
  constructor(status: 400 | 401 | 403 | 503, message: string) {
    super(message);
    this.status = status;
  }
}

/** Fixed-window limiter for the console's action endpoints. */
export class Limiter {
  private w = new Map<string, { start: number; n: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  /** True if allowed. */
  take(key: string, perMinute: number): boolean {
    const t = this.now();
    const cur = this.w.get(key);
    if (!cur || t - cur.start >= 60_000) {
      this.w.set(key, { start: t, n: 1 });
      return true;
    }
    if (cur.n >= perMinute) return false;
    cur.n += 1;
    return true;
  }
}
