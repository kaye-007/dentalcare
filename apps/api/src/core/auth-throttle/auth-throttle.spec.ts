import { HttpStatus } from '@nestjs/common';
import { isLoopback, signInKeys, signInLocked } from './auth-throttle.service';

/** The keys the database stores, and the refusal a locked sign-in gets (0025). */

const SECRET = Buffer.from('test-secret-for-the-throttle-keys');
const SHAPE = /^[a-z]+:[0-9a-f]{64}$/; // auth_throttle_key_shape

describe('signInKeys', () => {
  it('produces keys the table accepts, and never the address or email itself', () => {
    const k = signInKeys(SECRET, 'clinic', 'tenant-1:ana@klinika.al', '203.0.113.7');
    expect(k.account).toMatch(SHAPE);
    expect(k.address).toMatch(SHAPE);
    expect(k.account).not.toContain('ana');
    expect(k.address).not.toContain('203');
  });

  it('ignores email case and surrounding space, as sign-in does', () => {
    const a = signInKeys(SECRET, 'clinic', 'tenant-1:Ana@Klinika.AL ', null);
    const b = signInKeys(SECRET, 'clinic', 'tenant-1:ana@klinika.al', null);
    expect(a.account).toBe(b.account);
  });

  it('keeps clinics and the console apart', () => {
    const clinic = signInKeys(SECRET, 'clinic', 'x@y.al', null);
    const console_ = signInKeys(SECRET, 'platform', 'x@y.al', null);
    expect(clinic.account.startsWith('clinic:')).toBe(true);
    expect(console_.account.startsWith('platform:')).toBe(true);
    expect(clinic.account.slice(7)).toBe(console_.account.slice(9));
  });

  it('keeps the same email at two clinics apart', () => {
    expect(signInKeys(SECRET, 'clinic', 't1:x@y.al', null).account).not.toBe(
      signInKeys(SECRET, 'clinic', 't2:x@y.al', null).account,
    );
  });

  it('depends on the secret, so the table cannot be matched against a list', () => {
    expect(signInKeys(SECRET, 'clinic', 'x@y.al', null).account).not.toBe(
      signInKeys(Buffer.from('another'), 'clinic', 'x@y.al', null).account,
    );
  });

  it.each(['127.0.0.1', '127.8.9.1', '::1', '::ffff:127.0.0.1'])(
    'counts no address for loopback %s',
    (ip) => {
      expect(isLoopback(ip)).toBe(true);
      expect(signInKeys(SECRET, 'clinic', 'x@y.al', ip).address).toBeNull();
    },
  );

  it.each(['203.0.113.7', '10.0.0.1', '2001:db8::1', '::ffff:198.51.100.2'])(
    'counts the address %s',
    (ip) => {
      expect(isLoopback(ip)).toBe(false);
      expect(signInKeys(SECRET, 'clinic', 'x@y.al', ip).address).toMatch(SHAPE);
    },
  );

  it('counts no address when none is known', () => {
    expect(signInKeys(SECRET, 'clinic', 'x@y.al', null).address).toBeNull();
  });
});

describe('signInLocked', () => {
  const now = Date.parse('2026-09-28T10:00:00Z');

  it('is a 429 that says how long to wait, rounded up', () => {
    const err = signInLocked(new Date(now + 14 * 60_000 + 1), now);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.getResponse()).toMatchObject({
      code: 'sign_in_locked',
      message: 'Too many failed sign-ins. Try again in 15 minutes.',
      retryAfterSeconds: 900,
    });
  });

  it('never says zero minutes', () => {
    expect(signInLocked(new Date(now + 5_000), now).getResponse()).toMatchObject({
      message: 'Too many failed sign-ins. Try again in 1 minute.',
    });
  });
});
