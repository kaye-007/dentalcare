import { randomBytes } from 'node:crypto';

/**
 * One-time recovery codes: what gets someone back in when the phone with the
 * authenticator on it is lost.
 *
 * Ten codes of ten characters from a 32-symbol alphabet — 50 bits each. They
 * are stored as keyed hashes (secret-box.keyedHash), not bcrypt: 50 random
 * bits are not guessable online past the login throttle and factor lockout,
 * and a keyed hash is useless offline to anyone who has the database without
 * the key.
 *
 * The alphabet drops I, O, 0 and 1. These get read aloud to a colleague and
 * copied off paper.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

function code(): string {
  // 32 symbols, so the low five bits of a random byte are uniform — no modulo bias.
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(code());
  return [...codes];
}

/** "abcde fghjk", "ABCDE-FGHJK" -> "ABCDEFGHJK"; null if it cannot be a code. */
export function normalizeRecoveryCode(input: string): string | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, '');
  if (clean.length !== 10) return null;
  for (const ch of clean) if (!ALPHABET.includes(ch)) return null;
  return clean;
}
