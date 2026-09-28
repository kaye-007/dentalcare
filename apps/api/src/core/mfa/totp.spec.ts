import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpAt,
  totpStep,
  verifyTotp,
} from './totp';

/** The shared secret both RFCs use: ASCII "12345678901234567890". */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_BASE32 = base32Encode(RFC_SECRET);

describe('HOTP — RFC 4226 appendix D', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('counter %i -> %s', (counter, expected) => {
    expect(hotp(RFC_SECRET, counter)).toBe(expected);
  });
});

describe('TOTP — RFC 6238 appendix B (SHA-1)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('T=%i -> %s', (seconds, expected) => {
    expect(hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(expected);
  });
});

describe('base32', () => {
  it('matches RFC 4648 for the RFC secret', () => {
    expect(RFC_SECRET_BASE32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('round-trips random secrets and tolerates how people type them', () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    const typed = secret.toLowerCase().replace(/(.{4})/g, '$1 ');
    expect(base32Encode(base32Decode(typed))).toBe(secret);
  });

  it('refuses characters outside the alphabet', () => {
    expect(() => base32Decode('ABC1')).toThrow(RangeError);
  });
});

describe('verifyTotp', () => {
  const now = 1_757_844_000_000; // an arbitrary instant, on a step boundary
  const secret = RFC_SECRET_BASE32;

  it('accepts the current code and reports its step', () => {
    expect(verifyTotp(secret, totpAt(secret, now), { nowMs: now })).toBe(totpStep(now));
  });

  it('accepts one step of drift either side, and no more', () => {
    expect(
      verifyTotp(secret, totpAt(secret, now - 30_000), { nowMs: now }),
    ).not.toBeNull();
    expect(
      verifyTotp(secret, totpAt(secret, now + 30_000), { nowMs: now }),
    ).not.toBeNull();
    expect(verifyTotp(secret, totpAt(secret, now - 60_000), { nowMs: now })).toBeNull();
  });

  it('refuses a code that was already used, and any older one', () => {
    const step = totpStep(now);
    const code = totpAt(secret, now);
    expect(verifyTotp(secret, code, { nowMs: now, lastUsedStep: step })).toBeNull();
    expect(
      verifyTotp(secret, totpAt(secret, now - 30_000), {
        nowMs: now,
        lastUsedStep: step,
      }),
    ).toBeNull();
  });

  it('accepts spaces the way an app displays the code', () => {
    const code = totpAt(secret, now);
    expect(
      verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { nowMs: now }),
    ).not.toBeNull();
  });

  it.each(['', '12345', '1234567', 'abcdef', '12 34 5'])('refuses %p', (code) => {
    expect(verifyTotp(secret, code, { nowMs: now })).toBeNull();
  });
});

describe('otpauthUri', () => {
  it('carries everything an authenticator needs, escaped', () => {
    const uri = otpauthUri({
      secret: 'ABC',
      account: 'dr.x@clinic.al',
      issuer: 'DentalCare (Vita)',
    });
    expect(uri.startsWith('otpauth://totp/DentalCare%20(Vita):dr.x%40clinic.al?')).toBe(
      true,
    );
    const params = new URL(uri.replace('otpauth://', 'https://')).searchParams;
    expect(params.get('secret')).toBe('ABC');
    expect(params.get('issuer')).toBe('DentalCare (Vita)');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });
});
