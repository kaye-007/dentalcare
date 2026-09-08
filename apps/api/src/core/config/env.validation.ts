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

  // Which host this process is running on. 'workers' switches DatabaseService
  // to per-request connections (Hyperdrive owns the pool), silences the
  // in-process reminder scheduler in favour of the Cron Trigger, and routes
  // pino at console instead of a file descriptor. Set by wrangler.jsonc.
  RUNTIME: z.enum(['node', 'workers']).default('node'),

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
  /**
   * Signs platform console tokens. Separate from JWT_SECRET because a
   * platform token is authority over every clinic in the deployment, and
   * sharing one key means a leak from the clinic plane hands that over too.
   *
   * Optional here and required in production (below) — development falls
   * back to JWT_SECRET so an existing .env keeps working. See
   * modules/platform/auth/platform-secret.ts.
   */
  PLATFORM_JWT_SECRET: z
    .string()
    .min(16, 'PLATFORM_JWT_SECRET must be at least 16 characters')
    .optional(),
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  REMINDER_SCAN_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  JWT_REFRESH_TTL: z.string().min(1).default('7d'),

  // ── Google sign-in (optional) ─────────────────────────────────────────
  // All three or none. A partial set would offer a "Continue with Google"
  // button that lands on a Google error page, which is worse than no button.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  /** Must match a redirect URI registered on the Google client, exactly. */
  GOOGLE_CALLBACK_URL: z.string().url().optional(),

  // ── Where the browser is sent after a Google callback ─────────────────
  // The clinic host is derived from this by prefixing the subdomain, because
  // the callback arrives on the API host and cannot read it from the request.
  APP_BASE_URL: z.string().url().optional(),
  ADMIN_BASE_URL: z.string().url().optional(),

  // ── Object storage for patient documents (S3-compatible) ──────────────
  // Cloudflare R2, AWS S3, MinIO or Spaces. The bucket MUST be private:
  // downloads are served as short-lived pre-signed URLs, never public reads.
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** Omit for AWS S3; set for R2/MinIO/Spaces. */
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).default('auto'),
  /** '1' for R2 and MinIO, which address buckets by path. */
  S3_FORCE_PATH_STYLE: z.enum(['0', '1']).optional(),
  /** Lifetime of a download link. Long enough to click, short enough to leak. */
  S3_SIGNED_URL_TTL: z.coerce.number().int().min(30).max(3600).default(300),
  /** Largest single upload. A panoramic X-ray is comfortably under 40MB. */
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(100 * 1024 * 1024)
    .default(40 * 1024 * 1024),
})
  .superRefine((val, ctx) => {
    // Google credentials come as a set. A partial set would register the
    // strategy without a secret, or advertise a button with no strategy
    // behind it — both fail at the worst moment, in front of a user.
    const google = {
      GOOGLE_CLIENT_ID: val.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: val.GOOGLE_CLIENT_SECRET,
      GOOGLE_CALLBACK_URL: val.GOOGLE_CALLBACK_URL,
    };
    const set = Object.entries(google).filter(([, v]) => v);
    if (set.length > 0 && set.length < 3) {
      for (const [key, v] of Object.entries(google)) {
        if (!v) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message:
              'required when Google sign-in is configured — set all of GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL, or none of them to disable it',
          });
        }
      }
    }

    // Storage credentials come as a set — a partial set silently disables
    // uploads at runtime, so catch it at boot in every environment.
    const s3 = {
      S3_BUCKET: val.S3_BUCKET,
      S3_ACCESS_KEY_ID: val.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: val.S3_SECRET_ACCESS_KEY,
    };
    const present = Object.entries(s3).filter(([, v]) => v);
    if (present.length > 0 && present.length < 3) {
      for (const [key, value] of Object.entries(s3)) {
        if (!value) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message:
              'required when object storage is configured — set all of S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or none of them to disable document upload',
          });
        }
      }
    }

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

    // The platform plane gets its own key in production. Development may
    // fall back to JWT_SECRET; a deployment may not, and a value equal to
    // JWT_SECRET is that fallback wearing a different name.
    if (!val.PLATFORM_JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PLATFORM_JWT_SECRET'],
        message:
          'required in production — the platform console signs cross-tenant ' +
          'tokens and must not share a key with the clinic plane',
      });
    } else {
      if (val.PLATFORM_JWT_SECRET === val.JWT_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PLATFORM_JWT_SECRET'],
          message: 'must not be the same value as JWT_SECRET',
        });
      }
      if (val.PLATFORM_JWT_SECRET.includes('dev-only-change-me')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PLATFORM_JWT_SECRET'],
          message: 'must not be the development placeholder from .env.example',
        });
      }
      if (val.PLATFORM_JWT_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PLATFORM_JWT_SECRET'],
          message: 'must be at least 32 characters in production',
        });
      }
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

/**
 * In a .env file, "unset" is written as an empty value — `S3_BUCKET=` with
 * nothing after it. dotenv reports that as `''`, and zod's `.optional()`
 * admits only `undefined`, so every commented-out-by-blanking variable failed
 * `.min(1)` and the API refused to boot. `.env.example` shipped in exactly
 * that state: copying it verbatim, which is the documented first step, gave a
 * config that could not start.
 *
 * Blank means absent. Applied before parsing so defaults still apply.
 */
function blankToUndefined(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(blankToUndefined(config));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
