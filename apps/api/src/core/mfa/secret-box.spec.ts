import { randomBytes } from 'node:crypto';
import {
  developmentKeyring,
  keyedHash,
  open,
  parseKeyring,
  seal,
} from './secret-box';
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from './recovery-codes';

const key = () => randomBytes(32).toString('base64');

describe('parseKeyring', () => {
  it('takes the first key as current and keeps the rest for opening', () => {
    const ring = parseKeyring(`k2:${key()}, k1:${key()}`);
    expect(ring.currentId).toBe('k2');
    expect([...ring.keys.keys()]).toEqual(['k2', 'k1']);
  });

  it.each([
    ['nothing', ''],
    ['no id', key()],
    ['a short key', `k1:${randomBytes(16).toString('base64')}`],
    ['a duplicate id', `k1:${key()},k1:${key()}`],
    ['a bad id', `k 1:${key()}`],
  ])('refuses %s', (_label, spec) => {
    expect(() => parseKeyring(spec)).toThrow(RangeError);
  });
});

describe('seal / open', () => {
  const ring = parseKeyring(`k1:${key()}`);

  it('round-trips a secret', () => {
    const sealed = seal(ring, 'JBSWY3DPEHPK3PXP', 'user_mfa_factors:u1');
    expect(sealed.keyId).toBe('k1');
    expect(sealed.ciphertext).not.toContain('JBSWY3DPEHPK3PXP');
    expect(open(ring, sealed, 'user_mfa_factors:u1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a fresh IV every time', () => {
    const a = seal(ring, 'same', 'aad');
    const b = seal(ring, 'same', 'aad');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  /** Copying a factor row onto another account must not produce a working factor. */
  it('refuses a ciphertext moved to another owner', () => {
    const sealed = seal(ring, 'secret', 'user_mfa_factors:u1');
    expect(() => open(ring, sealed, 'user_mfa_factors:u2')).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const sealed = seal(ring, 'secret', 'aad');
    const raw = Buffer.from(sealed.ciphertext, 'base64');
    raw[raw.length - 1]! ^= 1;
    expect(() => open(ring, { ...sealed, ciphertext: raw.toString('base64') }, 'aad')).toThrow();
  });

  it('opens secrets sealed under a key that has since been rotated out of first place', () => {
    const k1 = key();
    const old = parseKeyring(`k1:${k1}`);
    const sealed = seal(old, 'secret', 'aad');
    const rotated = parseKeyring(`k2:${key()},k1:${k1}`);
    expect(open(rotated, sealed, 'aad')).toBe('secret');
    expect(seal(rotated, 'x', 'aad').keyId).toBe('k2');
  });

  it('says which key is missing when one has been removed too early', () => {
    const sealed = seal(parseKeyring(`k1:${key()}`), 'secret', 'aad');
    expect(() => open(parseKeyring(`k2:${key()}`), sealed, 'aad')).toThrow(/k1/);
  });

  it('derives a stable development key from JWT_SECRET', () => {
    const a = developmentKeyring('dev-only-change-me-please-32chars!!');
    const b = developmentKeyring('dev-only-change-me-please-32chars!!');
    expect(open(b, seal(a, 'secret', 'aad'), 'aad')).toBe('secret');
  });
});

describe('recovery codes', () => {
  it('issues ten distinct codes in the displayed shape', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  });

  it('normalises what someone types back', () => {
    expect(normalizeRecoveryCode('abcde fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ABCDE-FGHJK')).toBe('ABCDEFGHJK');
  });

  it.each(['', 'ABCDE', 'ABCDE-FGHJK-L', 'ABCDE-FGH10'])('refuses %p', (input) => {
    expect(normalizeRecoveryCode(input)).toBeNull();
  });

  it('hashes under a key, so the same code under another key does not match', () => {
    const ring = parseKeyring(`k2:${key()},k1:${key()}`);
    expect(keyedHash(ring, 'k1', 'ABCDEFGHJK')).toBe(keyedHash(ring, 'k1', 'ABCDEFGHJK'));
    expect(keyedHash(ring, 'k1', 'ABCDEFGHJK')).not.toBe(keyedHash(ring, 'k2', 'ABCDEFGHJK'));
  });
});
