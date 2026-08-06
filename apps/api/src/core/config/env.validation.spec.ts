import { validateEnv } from './env.validation';

/**
 * Regression tests for the config gate.
 *
 * The dangerous case is a production deploy that omits APP_DATABASE_URL: the
 * tenant pool then falls back to the privileged DATABASE_URL, which bypasses
 * RLS unconditionally, and every clinic can read every other clinic's data.
 * The app used to log a warning and boot anyway.
 */
const STRONG_SECRET = 'a'.repeat(40);

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/dentalcare',
  JWT_SECRET: STRONG_SECRET,
};

describe('validateEnv', () => {
  describe('development', () => {
    it('boots without APP_DATABASE_URL (dev convenience is preserved)', () => {
      expect(() => validateEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
    });

    it('accepts the .env.example placeholder secret', () => {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'development',
          JWT_SECRET: 'dev-only-change-me-please-32chars-min',
        }),
      ).not.toThrow();
    });

    it('defaults NODE_ENV to development', () => {
      expect(validateEnv({ ...base }).NODE_ENV).toBe('development');
    });
  });

  describe('production', () => {
    const prod = { ...base, NODE_ENV: 'production' };

    it('refuses to boot without APP_DATABASE_URL', () => {
      expect(() => validateEnv(prod)).toThrow(/APP_DATABASE_URL/);
    });

    it('boots when APP_DATABASE_URL is supplied', () => {
      expect(() =>
        validateEnv({
          ...prod,
          APP_DATABASE_URL: 'postgres://app_user:p@localhost:5432/dentalcare',
        }),
      ).not.toThrow();
    });

    it('rejects the development placeholder secret', () => {
      expect(() =>
        validateEnv({
          ...prod,
          APP_DATABASE_URL: 'postgres://app_user:p@localhost:5432/dentalcare',
          JWT_SECRET: 'dev-only-change-me-please-32chars-min',
        }),
      ).toThrow(/JWT_SECRET/);
    });

    it('rejects a secret shorter than 32 characters', () => {
      expect(() =>
        validateEnv({
          ...prod,
          APP_DATABASE_URL: 'postgres://app_user:p@localhost:5432/dentalcare',
          JWT_SECRET: 'short-but-over-16-chars',
        }),
      ).toThrow(/at least 32 characters/);
    });
  });

  it('rejects a JWT_SECRET under 16 characters in any environment', () => {
    expect(() => validateEnv({ ...base, JWT_SECRET: 'tiny' })).toThrow(/JWT_SECRET/);
  });

  it('requires DATABASE_URL', () => {
    expect(() => validateEnv({ JWT_SECRET: STRONG_SECRET })).toThrow(/DATABASE_URL/);
  });

  it('only accepts 0 or 1 for ALLOW_TENANT_HEADER', () => {
    expect(() => validateEnv({ ...base, ALLOW_TENANT_HEADER: '1' })).not.toThrow();
    expect(() => validateEnv({ ...base, ALLOW_TENANT_HEADER: 'yes' })).toThrow();
  });
});
