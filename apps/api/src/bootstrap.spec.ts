import { corsOrigins } from './bootstrap';

/**
 * CORS is the one place where a development convenience can survive into a
 * deployment and quietly widen it, so the localhost allowance is asserted in
 * both directions rather than assumed from a reading of the function.
 */
describe('corsOrigins', () => {
  const matches = (origins: (string | RegExp)[], origin: string) =>
    origins.some((o) => (typeof o === 'string' ? o === origin : o.test(origin)));

  describe('outside production', () => {
    it('allows a Vite dev server on any port', () => {
      const origins = corsOrigins(undefined, true);
      expect(matches(origins, 'http://localhost:5173')).toBe(true);
      expect(matches(origins, 'http://localhost:5174')).toBe(true);
    });

    it('still allows the configured origins', () => {
      const origins = corsOrigins('https://app.dentalcare.com', true);
      expect(matches(origins, 'https://app.dentalcare.com')).toBe(true);
    });
  });

  describe('in production', () => {
    it('refuses localhost on every port', () => {
      const origins = corsOrigins('https://admin.dentalcare.com', false);
      expect(matches(origins, 'http://localhost:5173')).toBe(false);
      expect(matches(origins, 'http://localhost:1')).toBe(false);
      expect(matches(origins, 'http://localhost:65535')).toBe(false);
    });

    it('allows exactly the configured origins and nothing else', () => {
      const origins = corsOrigins('https://admin.dentalcare.com', false);
      expect(matches(origins, 'https://admin.dentalcare.com')).toBe(true);
      expect(matches(origins, 'https://evil.example')).toBe(false);
    });

    it('allows no origin at all when CORS_ORIGINS is unset', () => {
      // The same-origin deployment: the SPA Workers reach /api over a service
      // binding, so nothing legitimate is cross-origin and the list is empty.
      expect(corsOrigins(undefined, false)).toEqual([]);
      expect(corsOrigins('', false)).toEqual([]);
    });
  });

  describe('wildcard entries', () => {
    it('matches one subdomain label, which is what per-clinic hosting needs', () => {
      const origins = corsOrigins('https://*.dentalcare.com', false);
      expect(matches(origins, 'https://avicena.dentalcare.com')).toBe(true);
      expect(matches(origins, 'https://elezi.dentalcare.com')).toBe(true);
    });

    it('does not match a deeper name, so a.b.dentalcare.com is refused', () => {
      const origins = corsOrigins('https://*.dentalcare.com', false);
      expect(matches(origins, 'https://a.b.dentalcare.com')).toBe(false);
    });

    it('does not let the wildcard escape the domain', () => {
      const origins = corsOrigins('https://*.dentalcare.com', false);
      expect(matches(origins, 'https://avicena.dentalcare.com.evil.example')).toBe(false);
      expect(matches(origins, 'https://dentalcare.com')).toBe(false);
    });
  });

  it('trims whitespace and ignores empty entries', () => {
    const origins = corsOrigins(' https://a.example , , https://b.example ', false);
    expect(matches(origins, 'https://a.example')).toBe(true);
    expect(matches(origins, 'https://b.example')).toBe(true);
    expect(origins).toHaveLength(2);
  });
});
