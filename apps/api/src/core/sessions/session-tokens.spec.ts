import {
  REUSE_GRACE_MS,
  durationMs,
  formatRefreshToken,
  hashSecret,
  newRefreshSecret,
  parseRefreshToken,
  reuseVerdict,
  secretMatches,
} from './session-tokens';

const SESSION = '3f1c2b0a-9d8e-4c7b-a6f5-e4d3c2b1a098';

describe('refresh token format', () => {
  it('round-trips a freshly minted token', () => {
    const secret = newRefreshSecret();
    const parsed = parseRefreshToken(formatRefreshToken(SESSION, secret));
    expect(parsed).toEqual({ sessionId: SESSION, secret });
  });

  it('mints 256 bits of secret, differently every time', () => {
    const a = newRefreshSecret();
    const b = newRefreshSecret();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it.each([
    ['nothing', undefined],
    ['a number', 42],
    ['no separator', `${SESSION}${newRefreshSecret()}`],
    ['a JWT from before this change', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2ln'],
    ['a short secret', `${SESSION}.abc`],
    ['a bad session id', `not-a-uuid.${newRefreshSecret()}`],
    ['an absurd length', 'x'.repeat(5000)],
  ])('rejects %s without throwing', (_label, token) => {
    expect(parseRefreshToken(token)).toBeNull();
  });
});

describe('secret verification', () => {
  it('matches only the secret that was hashed', () => {
    const secret = newRefreshSecret();
    const stored = hashSecret(secret);
    expect(secretMatches(secret, stored)).toBe(true);
    expect(secretMatches(newRefreshSecret(), stored)).toBe(false);
  });

  it('never stores the secret itself', () => {
    const secret = newRefreshSecret();
    expect(hashSecret(secret)).not.toContain(secret);
    expect(hashSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a stored value of the wrong length rather than throwing', () => {
    expect(secretMatches(newRefreshSecret(), 'abcd')).toBe(false);
  });
});

describe('durationMs', () => {
  it.each([
    ['15m', 900_000],
    ['12h', 43_200_000],
    ['7d', 604_800_000],
    ['3600', 3_600_000],
    ['250ms', 250],
  ])('%s', (input, expected) => {
    expect(durationMs(input)).toBe(expected);
  });

  it.each(['', 'soon', '7 days', '-1d', '0', '1.5h'])('rejects %p', (input) => {
    expect(() => durationMs(input)).toThrow(RangeError);
  });
});

describe('reuse detection', () => {
  const now = new Date('2026-09-14T10:00:00Z');

  it('treats a never-exchanged token as fresh', () => {
    expect(reuseVerdict(null, now)).toBe('fresh');
  });

  it('allows the two-tab race inside the grace period', () => {
    const rotated = new Date(now.getTime() - REUSE_GRACE_MS);
    expect(reuseVerdict(rotated, now)).toBe('grace');
  });

  it('treats anything after the grace period as a replay', () => {
    const rotated = new Date(now.getTime() - REUSE_GRACE_MS - 1);
    expect(reuseVerdict(rotated, now)).toBe('replayed');
  });
});
