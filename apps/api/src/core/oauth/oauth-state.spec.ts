import {
  createState,
  readState,
  safeReturnPath,
  InvalidOAuthState,
  STATE_TTL_SECONDS,
} from './oauth-state';

const SECRET = 'a-test-secret-of-more-than-32-characters!!';
const NOW = 1_800_000_000;

describe('OAuth state', () => {
  it('round-trips the plane, clinic and return path', () => {
    const s = createState(
      { plane: 'clinic', tenant: 'avicena', next: '/patients' },
      SECRET,
      NOW,
    );
    const back = readState(s, SECRET, NOW);
    expect(back.plane).toBe('clinic');
    expect(back.tenant).toBe('avicena');
    expect(back.next).toBe('/patients');
  });

  it('gives every sign-in its own nonce', () => {
    const a = createState({ plane: 'platform' }, SECRET, NOW);
    const b = createState({ plane: 'platform' }, SECRET, NOW);
    expect(a).not.toEqual(b);
    expect(readState(a, SECRET, NOW).nonce).not.toBe(readState(b, SECRET, NOW).nonce);
  });

  /**
   * The load-bearing test. If the clinic in the state could be edited, an
   * attacker could point somebody's genuine Google login at a clinic they do
   * not belong to — the state is the ONLY thing carrying that decision across
   * the redirect.
   */
  it('refuses a state whose clinic has been edited', () => {
    const s = createState({ plane: 'clinic', tenant: 'avicena' }, SECRET, NOW);
    const [body] = s.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    decoded.tenant = 'someone-elses-clinic';
    const forgedBody = Buffer.from(JSON.stringify(decoded)).toString('base64url');

    expect(() => readState(`${forgedBody}.${s.split('.')[1]}`, SECRET, NOW)).toThrow(
      InvalidOAuthState,
    );
  });

  it('refuses a state signed with a different secret', () => {
    const s = createState({ plane: 'clinic', tenant: 'avicena' }, 'other-secret', NOW);
    expect(() => readState(s, SECRET, NOW)).toThrow(/failed verification/);
  });

  it('refuses a truncated or malformed state', () => {
    expect(() => readState('nonsense', SECRET, NOW)).toThrow(InvalidOAuthState);
    expect(() => readState('', SECRET, NOW)).toThrow(/Missing/);
    expect(() => readState(undefined, SECRET, NOW)).toThrow(/Missing/);
  });

  it('expires', () => {
    const s = createState({ plane: 'platform' }, SECRET, NOW);
    expect(() => readState(s, SECRET, NOW + STATE_TTL_SECONDS - 1)).not.toThrow();
    expect(() => readState(s, SECRET, NOW + STATE_TTL_SECONDS + 1)).toThrow(
      /took too long/,
    );
  });

  it('refuses a clinic sign-in that names no clinic', () => {
    // Forged by hand, since createState would never produce it.
    const body = Buffer.from(
      JSON.stringify({ plane: 'clinic', nonce: 'x', exp: NOW + 60 }),
    ).toString('base64url');
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(() => readState(`${body}.${sig}`, SECRET, NOW)).toThrow(/names no clinic/);
  });
});

describe('safeReturnPath', () => {
  it('keeps an ordinary in-app path', () => {
    expect(safeReturnPath('/invoices/42')).toBe('/invoices/42');
  });

  /**
   * The callback ends in a redirect, so an unchecked return target is an open
   * redirect on our own domain — aimed at someone who has just authenticated,
   * which is exactly when they are least suspicious of where they land.
   */
  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '/ok\nLocation: https://evil.example',
  ])('discards %s', (bad) => {
    expect(safeReturnPath(bad)).toBeUndefined();
  });

  it('discards it rather than trying to repair it', () => {
    // A "fix it up" branch is where open-redirect bypasses live.
    expect(safeReturnPath('evil.example/path')).toBeUndefined();
  });

  it('caps the length', () => {
    expect(safeReturnPath('/' + 'a'.repeat(9999))!.length).toBe(512);
  });
});
