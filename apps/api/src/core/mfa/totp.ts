import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), by hand.
 *
 * Why not a library: the whole algorithm is an HMAC-SHA1 and a truncation,
 * the popular packages pull in more than that, and the API bundle has a size
 * ceiling on Cloudflare Workers. node:crypto's HMAC runs unchanged on Node and
 * under nodejs_compat. The spec file checks this against the RFC test vectors,
 * which is the only verification that matters for code like this.
 *
 * Parameters are the ones every authenticator app assumes when a QR code says
 * nothing else: SHA-1, six digits, thirty-second steps.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** One step either side: clock drift on a phone, and the second it takes to type. */
export const TOTP_WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerates what people type: lower case, spaces, and trailing padding. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new RangeError('Not a base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, the length RFC 4226 recommends for SHA-1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpAt(secretBase32: string, nowMs: number): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

/**
 * The step a code matched, or null.
 *
 * `lastUsedStep` is replay protection: a code that matched once cannot match
 * again, and neither can any code from an earlier step. Without it, a code
 * read over someone's shoulder is good for another minute and a half.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { nowMs: number; lastUsedStep?: number | null; window?: number },
): number | null {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;

  const secret = base32Decode(secretBase32);
  const current = totpStep(opts.nowMs);
  const window = opts.window ?? TOTP_WINDOW;
  const presented = Buffer.from(normalized);

  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset++) {
    const step = current + offset;
    if (step < 0) continue;
    if (opts.lastUsedStep != null && step <= opts.lastUsedStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    // Every candidate is compared, match or not, so timing does not reveal
    // which offset matched.
    if (timingSafeEqual(expected, presented) && matched === null) matched = step;
  }
  return matched;
}

/** The otpauth:// URI an authenticator app reads from a QR code. */
export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
