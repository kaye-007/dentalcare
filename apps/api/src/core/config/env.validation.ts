import { z } from 'zod';

/**
 * Single source of truth for environment variables.
 * Validation runs at boot — the app refuses to start with a bad config.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Admin connection — used by migrations and seed (privileged, bypasses RLS).
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Runtime connection — the non-superuser app_user role (RLS enforced).
  // Optional so dev still boots, but required for real isolation.
  APP_DATABASE_URL: z.string().min(1).optional(),

  // Local-dev tenant fallback when there is no subdomain (M3).
  DEV_TENANT_SUBDOMAIN: z.string().min(1).optional(),
  // Opt-in for the X-Tenant-Subdomain request header, which lets the caller
  // choose its clinic. Required for localhost development; ignored outright
  // when NODE_ENV=production. Set to '1' to enable.
  ALLOW_TENANT_HEADER: z.enum(['0', '1']).optional(),

  // Comma-separated origins allowed to call the API cross-origin, e.g.
  // "https://app.dentalcare.app,https://*.dentalcare.app". localhost is
  // always allowed. Leave unset when the SPAs are same-origin with the API.
  CORS_ORIGINS: z.string().optional(),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  REMINDER_SCAN_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  JWT_REFRESH_TTL: z.string().min(1).default('7d'),
})
  .superRefine((val, ctx) => {
    if (val.NODE_ENV !== 'production') return;

    // Without APP_DATABASE_URL the tenant plane silently falls back to the
    // privileged DATABASE_URL, which bypasses RLS unconditionally — including
    // FORCE. Since tenant services deliberately never filter by tenant_id and
    // rely entirely on RLS, that fallback would expose every clinic's data to
    // every other clinic. Refuse to boot rather than run unisolated.
    if (!val.APP_DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_DATABASE_URL'],
        message:
          'required in production — the tenant plane must use the non-superuser app_user role so Row-Level Security is enforced',
      });
    }

    // The shipped example secret must never reach production.
    if (val.JWT_SECRET.includes('dev-only-change-me')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'must not be the development placeholder from .env.example',
      });
    }
    if (val.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'must be at least 32 characters in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
