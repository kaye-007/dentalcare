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

  REDIS_URL: z.string().min(1).optional(),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  REMINDER_SCAN_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  JWT_REFRESH_TTL: z.string().min(1).default('7d'),
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
