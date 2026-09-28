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
const PLATFORM_SECRET = 'b'.repeat(40);
const MFA_KEYS = `k1:${Buffer.alloc(32, 7).toString('base64')}`;
const WHATSAPP_KEYS = `w1:${Buffer.alloc(32, 9).toString('base64')}`;

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
    // A production config that is complete apart from whatever each test
    // takes away. PLATFORM_JWT_SECRET belongs here because production
    // requires it — the development fallback to JWT_SECRET stops at the
    // production boundary.
    const prod = {
      ...base,
      NODE_ENV: 'production',
      PLATFORM_JWT_SECRET: PLATFORM_SECRET,
      MFA_ENCRYPTION_KEYS: MFA_KEYS,
      WHATSAPP_ENCRYPTION_KEYS: WHATSAPP_KEYS,
      // Storage is its own test; these are about other settings.
      STORAGE_DRIVER: 'off',
    };

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

  describe('platform secret', () => {
    const prodBase = {
      ...base,
      NODE_ENV: 'production',
      APP_DATABASE_URL: 'postgres://app_user:p@localhost:5432/dentalcare',
      MFA_ENCRYPTION_KEYS: MFA_KEYS,
      WHATSAPP_ENCRYPTION_KEYS: WHATSAPP_KEYS,
      // Storage is its own test; these are about other settings.
      STORAGE_DRIVER: 'off',
    };

    // The clinic plane and the platform plane shared one key. A leak of the
    // secret held by the process that serves every clinic request was also a
    // leak of the key that signs cross-tenant authority.
    it('requires PLATFORM_JWT_SECRET in production', () => {
      expect(() => validateEnv(prodBase)).toThrow(/PLATFORM_JWT_SECRET/);
    });

    it('accepts a distinct platform secret', () => {
      expect(() =>
        validateEnv({ ...prodBase, PLATFORM_JWT_SECRET: PLATFORM_SECRET }),
      ).not.toThrow();
    });

    // Setting it to the same string is the development fallback wearing a
    // different name, and would make the split look done while changing
    // nothing.
    it('rejects a platform secret equal to JWT_SECRET', () => {
      expect(() =>
        validateEnv({ ...prodBase, PLATFORM_JWT_SECRET: STRONG_SECRET }),
      ).toThrow(/must not be the same value as JWT_SECRET/);
    });

    it('rejects a platform secret shorter than 32 characters', () => {
      expect(() =>
        validateEnv({ ...prodBase, PLATFORM_JWT_SECRET: 'short-but-over-16-chars' }),
      ).toThrow(/at least 32 characters/);
    });

    it('rejects the development placeholder as the platform secret', () => {
      expect(() =>
        validateEnv({
          ...prodBase,
          PLATFORM_JWT_SECRET: 'dev-only-change-me-please-32chars-min',
        }),
      ).toThrow(/PLATFORM_JWT_SECRET/);
    });

    // Development must not need a second secret generated before the app
    // will start; platformJwtSecret() falls back to JWT_SECRET there.
    it('does not require it outside production', () => {
      expect(() => validateEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
    });
  });

  describe('multi-factor authentication', () => {
    const prodBase = {
      ...base,
      NODE_ENV: 'production',
      APP_DATABASE_URL: 'postgres://app_user:p@localhost:5432/dentalcare',
      PLATFORM_JWT_SECRET: PLATFORM_SECRET,
      // Storage is its own test; these are about other settings.
      STORAGE_DRIVER: 'off',
    };

    it('requires MFA_ENCRYPTION_KEYS in production', () => {
      expect(() => validateEnv(prodBase)).toThrow(/MFA_ENCRYPTION_KEYS/);
    });

    it('requires WHATSAPP_ENCRYPTION_KEYS in production', () => {
      expect(() => validateEnv({ ...prodBase, MFA_ENCRYPTION_KEYS: MFA_KEYS })).toThrow(
        /WHATSAPP_ENCRYPTION_KEYS/,
      );
    });

    it('refuses optional MFA in production', () => {
      expect(() =>
        validateEnv({
          ...prodBase,
          MFA_ENCRYPTION_KEYS: MFA_KEYS,
          MFA_ENFORCEMENT: 'optional',
        }),
      ).toThrow(/MFA_ENFORCEMENT/);
    });

    it('defaults to required', () => {
      expect(validateEnv({ ...base }).MFA_ENFORCEMENT).toBe('required');
    });

    it('refuses a malformed WhatsApp keyring in any environment', () => {
      expect(() =>
        validateEnv({ ...base, WHATSAPP_ENCRYPTION_KEYS: 'k1:short' }),
      ).toThrow(/WHATSAPP_ENCRYPTION_KEYS/);
    });

    it('refuses a malformed keyring in any environment', () => {
      expect(() =>
        validateEnv({ ...base, MFA_ENCRYPTION_KEYS: 'k1:not-thirty-two-bytes' }),
      ).toThrow(/MFA_ENCRYPTION_KEYS/);
    });

    it('needs no keyring outside production', () => {
      expect(() => validateEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
    });
  });

  it('refuses a refresh lifetime that is not a duration', () => {
    expect(() => validateEnv({ ...base, JWT_REFRESH_TTL: 'a week' })).toThrow(
      /JWT_REFRESH_TTL/,
    );
    expect(validateEnv({ ...base, JWT_REFRESH_TTL: '12h' }).JWT_REFRESH_TTL).toBe('12h');
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

  /**
   * Where patient documents live has to be decided in production. With no
   * bucket they used to go to the server's own disk without a word, which on
   * a container without a volume loses them at the next deploy.
   */
  describe('document storage', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      APP_DATABASE_URL: 'postgres://app_user:p@localhost:5432/dentalcare',
      PLATFORM_JWT_SECRET: PLATFORM_SECRET,
      MFA_ENCRYPTION_KEYS: MFA_KEYS,
      WHATSAPP_ENCRYPTION_KEYS: WHATSAPP_KEYS,
    };
    const bucket = {
      S3_BUCKET: 'docs',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'key',
    };

    it('refuses production with no bucket and no decision', () => {
      expect(() => validateEnv(prod)).toThrow(/STORAGE_DRIVER/);
    });

    it('boots production with a bucket', () => {
      expect(() => validateEnv({ ...prod, ...bucket })).not.toThrow();
    });

    it('boots production with uploads explicitly off', () => {
      expect(() => validateEnv({ ...prod, STORAGE_DRIVER: 'off' })).not.toThrow();
    });

    it('boots production on the server disk only with a named directory', () => {
      expect(() => validateEnv({ ...prod, STORAGE_DRIVER: 'local' })).toThrow(
        /STORAGE_DIR/,
      );
      expect(() =>
        validateEnv({ ...prod, STORAGE_DRIVER: 'local', STORAGE_DIR: '/app/storage' }),
      ).not.toThrow();
    });

    it('refuses the server disk on Workers, which have none', () => {
      expect(() =>
        validateEnv({
          ...prod,
          RUNTIME: 'workers',
          STORAGE_DRIVER: 'local',
          STORAGE_DIR: '/app/storage',
        }),
      ).toThrow(/Worker has no disk/);
    });

    it('refuses STORAGE_DRIVER=s3 without a bucket, in development too', () => {
      expect(() => validateEnv({ ...base, STORAGE_DRIVER: 's3' })).toThrow(
        /s3 needs a bucket/,
      );
      expect(() =>
        validateEnv({ ...base, STORAGE_DRIVER: 's3', ...bucket }),
      ).not.toThrow();
    });

    it('leaves development free to use the disk without saying so', () => {
      expect(() => validateEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
    });
  });
});
