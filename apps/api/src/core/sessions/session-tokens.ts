import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Refresh tokens, as opaque strings rather than JWTs.
 *
 * A refresh token used to be a JWT: self-contained, seven days long, and
 * impossible to revoke — logout was the browser forgetting it, and a stolen
 * one kept working after a password change. Now it is
 *
 *     <session id>.<secret>
 *
 * The id finds the row; the secret proves possession. Only a SHA-256 of the
 * secret is stored, so reading the sessions table — through an injection, a
 * backup, a replica — yields nothing that can be presented back. SHA-256 and
 * not bcrypt because the secret is 256 random bits, not a password: there is
 * no dictionary to slow down.
 *
 * Pure functions, no Nest and no database, for the same reason billing-engine
 * is: the rules that decide whether a session is valid should be provable by a
 * unit test that needs nothing running.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 32 bytes, base64url, unpadded. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * How long a token that has just been exchanged may still be exchanged again.
 *
 * Two browser tabs share one refresh token in localStorage. When both notice
 * an expired access token in the same moment, both refresh with the same
 * token; without a grace period the second looks exactly like a stolen token
 * being replayed, the whole session is revoked, and the user is signed out of
 * every tab for doing nothing. Thirty seconds covers that race. A replay after
 * it is treated as theft.
 */
export const REUSE_GRACE_MS = 30_000;

export interface ParsedRefreshToken {
  sessionId: string;
  secret: string;
}

export function newRefreshSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

/** Null for anything that is not shaped like a refresh token. Never throws. */
export function parseRefreshToken(token: unknown): ParsedRefreshToken | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!UUID.test(sessionId) || !SECRET.test(secret)) return null;
  return { sessionId: sessionId.toLowerCase(), secret };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison of a presented secret against a stored hash. */
export function secretMatches(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashSecret(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/**
 * "7d", "15m", "3600" (seconds) -> milliseconds.
 *
 * The same forms jsonwebtoken accepts for JWT_ACCESS_TTL, so the two TTLs in
 * the environment read the same way. Throws on anything else: a session length
 * that silently parsed as zero would sign everyone out on every request.
 */
export function durationMs(value: string): number {
  const match = /^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/.exec(value);
  if (!match) throw new RangeError(`"${value}" is not a duration like 15m, 12h or 7d`);
  const n = Number(match[1]);
  const unit = match[2] ?? 's';
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  const ms = n * factor;
  if (ms <= 0) throw new RangeError(`"${value}" must be longer than zero`);
  return ms;
}

export type ReuseVerdict = 'fresh' | 'grace' | 'replayed';

/**
 * Classify a token presented for exchange by when (if ever) it was exchanged.
 * Pulled out so the grace boundary is tested, not just described.
 */
export function reuseVerdict(rotatedAt: Date | null, now: Date): ReuseVerdict {
  if (!rotatedAt) return 'fresh';
  return now.getTime() - rotatedAt.getTime() <= REUSE_GRACE_MS ? 'grace' : 'replayed';
}
