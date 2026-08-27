import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The OAuth `state` parameter — signed, because it carries a decision.
 *
 * ── Why state does more work here than usual ──────────────────────────────
 *
 * Google requires an exact, pre-registered redirect URI. Clinics live on
 * wildcard subdomains (`avicena.dentalcare.app`), and a wildcard cannot be
 * registered. So every sign-in, for every clinic, comes back to ONE callback
 * on the API host — and that callback has no host, no cookie and no session
 * telling it which clinic the person started from.
 *
 * `state` is the only channel that survives the round trip. It therefore
 * carries the clinic, and it must be signed: an attacker who could edit it
 * would redirect a valid Google login at a clinic of their choosing.
 *
 * It is also the CSRF token, which is the parameter's original purpose. Both
 * jobs are served by the same signature.
 *
 * Signed rather than encrypted on purpose: nothing in here is secret — a
 * subdomain is public — and integrity is the whole requirement.
 */

export type OAuthPlane = 'clinic' | 'platform';

export interface OAuthState {
  plane: OAuthPlane;
  /** Clinic subdomain. Absent for the platform console, which has one host. */
  tenant?: string;
  /** In-app path to land on afterwards. Never an absolute URL — see below. */
  next?: string;
  /** Single-use randomness, so two parallel sign-ins never share a state. */
  nonce: string;
  /** Unix seconds. */
  exp: number;
}

/**
 * How long a sign-in may take. Long enough to type a password and clear a
 * second factor on Google's side, short enough that a state lifted from a
 * browser history or a proxy log is already dead.
 */
export const STATE_TTL_SECONDS = 600;

const b64url = (b: Buffer) => b.toString('base64url');

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** Constant-time compare that cannot throw on a length mismatch. */
function sameSignature(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function createState(
  input: Omit<OAuthState, 'nonce' | 'exp'>,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const state: OAuthState = {
    ...input,
    next: safeReturnPath(input.next),
    nonce: b64url(randomBytes(12)),
    exp: nowSeconds + STATE_TTL_SECONDS,
  };
  const body = b64url(Buffer.from(JSON.stringify(state), 'utf8'));
  return `${body}.${sign(body, secret)}`;
}

export class InvalidOAuthState extends Error {}

export function readState(
  raw: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): OAuthState {
  if (!raw) throw new InvalidOAuthState('Missing sign-in state.');

  const dot = raw.lastIndexOf('.');
  if (dot <= 0) throw new InvalidOAuthState('Malformed sign-in state.');

  const body = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);

  // Signature first, always. Nothing inside an unverified body is trusted
  // enough to parse, let alone to act on.
  if (!sameSignature(signature, sign(body, secret))) {
    throw new InvalidOAuthState('Sign-in state failed verification.');
  }

  let parsed: OAuthState;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidOAuthState('Malformed sign-in state.');
  }

  if (parsed.plane !== 'clinic' && parsed.plane !== 'platform') {
    throw new InvalidOAuthState('Unknown sign-in plane.');
  }
  if (parsed.plane === 'clinic' && !parsed.tenant) {
    throw new InvalidOAuthState('Sign-in state names no clinic.');
  }
  if (typeof parsed.exp !== 'number' || parsed.exp <= nowSeconds) {
    throw new InvalidOAuthState('This sign-in took too long. Please try again.');
  }

  // Re-narrowed on the way out as well as on the way in: the value was signed
  // by us, but a bug in a future writer must not become an open redirect.
  return { ...parsed, next: safeReturnPath(parsed.next) };
}

/**
 * Reduce a caller-supplied return target to a same-app path.
 *
 * The callback ends in a redirect, so an unchecked `next` is an open redirect
 * wearing our domain — the classic phishing primitive, and worth more to an
 * attacker here because the user has just proved who they are. Anything that
 * is not a single-slash-rooted path is discarded rather than repaired.
 */
export function safeReturnPath(next: string | undefined): string | undefined {
  if (!next) return undefined;
  // Rejects "//evil.com" (protocol-relative), "https://evil.com", and
  // "/\evil.com", which some browsers normalise into a host.
  if (!next.startsWith('/')) return undefined;
  if (next.startsWith('//') || next.startsWith('/\\')) return undefined;
  if (next.includes('\n') || next.includes('\r')) return undefined;
  return next.slice(0, 512);
}
