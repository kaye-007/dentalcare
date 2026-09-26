import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Envelope for MFA secrets at rest: AES-256-GCM with keys that never touch
 * the database.
 *
 * The baseline once carried `users.totp_secret text`. A TOTP secret in plain
 * text, in a table the tenant role can SELECT, means one SQL injection yields
 * every clinic's second factor — the thing a second factor exists to survive.
 * So the ciphertext lives in the database and the key lives in the
 * environment (a Worker secret, a container secret), and neither is useful
 * alone.
 *
 * ── Rotation ──────────────────────────────────────────────────────────────
 *
 * MFA_ENCRYPTION_KEYS is an ordered list, `k2:<base64>,k1:<base64>`. The first
 * key seals new secrets; every listed key can open old ones, found by the
 * `key_id` stored beside each ciphertext. Rotating is: prepend a new key,
 * deploy, and remove the old one once nothing references it.
 *
 * ── Binding ───────────────────────────────────────────────────────────────
 *
 * Each ciphertext is sealed with associated data naming its table and owner.
 * Copying a factor row onto another account in the database produces a
 * ciphertext that fails authentication, not a working second factor for
 * someone else.
 */

export interface Keyring {
  currentId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface Sealed {
  ciphertext: string;
  keyId: string;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Parse MFA_ENCRYPTION_KEYS. Throws with a message fit for a boot failure. */
export function parseKeyring(spec: string): Keyring {
  const keys = new Map<string, Buffer>();
  let currentId: string | undefined;
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const colon = part.indexOf(':');
    if (colon < 1) throw new RangeError('each key must be written as <id>:<base64 key>');
    const id = part.slice(0, colon);
    if (!KEY_ID.test(id)) throw new RangeError(`key id "${id}" must be 1-32 letters, digits, _ or -`);
    if (keys.has(id)) throw new RangeError(`key id "${id}" appears twice`);
    const key = Buffer.from(part.slice(colon + 1), 'base64');
    if (key.length !== 32) {
      throw new RangeError(`key "${id}" must decode to exactly 32 bytes (it is ${key.length})`);
    }
    keys.set(id, key);
    currentId ??= id;
  }
  if (!currentId) throw new RangeError('at least one key is required');
  return { currentId, keys };
}

/**
 * Development only: a key derived from JWT_SECRET, so a fresh checkout works
 * without generating a second secret. env.validation refuses to let
 * production reach this.
 */
export function developmentKeyring(jwtSecret: string): Keyring {
  const key = createHmac('sha256', jwtSecret).update('dentalcare/mfa/development-key').digest();
  return { currentId: 'dev', keys: new Map([['dev', key]]) };
}

export function seal(keyring: Keyring, plaintext: string, associatedData: string): Sealed {
  const key = keyring.keys.get(keyring.currentId)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([iv, tag, body]).toString('base64'),
    keyId: keyring.currentId,
  };
}

/** Throws if the key is gone, the data was altered, or it belongs to someone else. */
export function open(keyring: Keyring, sealed: Sealed, associatedData: string): string {
  const key = keyring.keys.get(sealed.keyId);
  if (!key) throw new Error(`MFA key "${sealed.keyId}" is not configured`);
  const raw = Buffer.from(sealed.ciphertext, 'base64');
  if (raw.length < 12 + 16 + 1) throw new Error('MFA ciphertext is truncated');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * A keyed hash for recovery codes, under the key named by `keyId`. Stored with
 * that id so a rotated keyring still verifies codes issued before rotation.
 */
export function keyedHash(keyring: Keyring, keyId: string, value: string): string {
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error(`MFA key "${keyId}" is not configured`);
  return createHmac('sha256', key).update('recovery-code:').update(value).digest('hex');
}
