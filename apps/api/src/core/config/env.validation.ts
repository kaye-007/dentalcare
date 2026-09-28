import { z } from 'zod';
import { parseKeyring } from '@/core/mfa/secret-box';

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
  /**
   * How long one reminder pass may run before it stops and leaves the
   * remaining clinics first in line for the next. Keep it under the cron
   * interval on Workers.
   */
  REMINDER_SCAN_BUDGET_MS: z.coerce.number().int().min(1000).default(45_000),
  /**
   * Absolute lifetime of a sign-in (migration 0005). Refreshing rotates the
   * token but never extends this; after it, everyone signs in again.
   */
  JWT_REFRESH_TTL: z
    .string()
    .regex(/^\s*\d+\s*(ms|s|m|h|d)?\s*$/, 'must be a duration like 12h or 7d')
    .default('7d'),

  // ── Multi-factor authentication ───────────────────────────────────────
  /**
   * 'required': administrators and every console account must enrol, and a
   * clinic may extend that to all staff. 'optional': nobody is forced to
   * enrol, although anyone who has enrolled is still challenged. Optional
   * exists for local development and the integration suite; production
   * refuses it (below).
   */
  MFA_ENFORCEMENT: z.enum(['required', 'optional']).default('required'),
  /**
   * The keys that seal TOTP secrets at rest: "k2:<base64>,k1:<base64>", each
   * 32 bytes. The first seals, all of them open. Required in production;
   * development derives a key from JWT_SECRET when unset.
   * Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  MFA_ENCRYPTION_KEYS: z.string().optional(),

  // ── WhatsApp Cloud API, each clinic's own account (0017) ──────────────
  /**
   * The keys that seal each clinic's WhatsApp access token: same format as
   * MFA_ENCRYPTION_KEYS, and deliberately separate keys. Required in
   * production; development derives one from JWT_SECRET.
   */
  WHATSAPP_ENCRYPTION_KEYS: z.string().optional(),
  /** Meta's Graph API. Overridden only by the integration suite's fake. */
  WHATSAPP_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .regex(/^v\d{2,3}\.\d$/, 'looks like v25.0')
    .default('v25.0'),

  // ── Reminder delivery (optional) ──────────────────────────────────────
  /**
   * 'log' records reminders for staff to act on and sends nothing. 'twilio'
   * sends SMS and needs the account SID, auth token, and a sender — a number
   * or a messaging service.
   */
  SMS_PROVIDER: z.enum(['log', 'twilio']).default('log'),
  TWILIO_ACCOUNT_SID: z
    .string()
    .regex(/^AC[0-9a-fA-F]{32}$/, 'must be a Twilio Account SID: AC followed by 32 hex characters')
    .optional(),
  /** A secret: wrangler secret put TWILIO_AUTH_TOKEN. */
  TWILIO_AUTH_TOKEN: z.string().min(16).optional(),
  TWILIO_FROM: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, 'must be an E.164 number such as +355691234567')
    .optional(),
  TWILIO_MESSAGING_SERVICE_SID: z
    .string()
    .regex(/^MG[0-9a-fA-F]{32}$/, 'must be a Messaging Service SID: MG followed by 32 hex characters')
    .optional(),
  TWILIO_API_BASE_URL: z.string().url().default('https://api.twilio.com'),

  /**
   * WhatsApp Business reminders through the same Twilio account. Needs an
   * approved WhatsApp sender and a Content template per language with five
   * variables: first name, date, time, dentist, clinic.
   */
  WHATSAPP_PROVIDER: z.enum(['none', 'twilio']).default('none'),
  TWILIO_WHATSAPP_FROM: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, 'must be the E.164 number of the approved WhatsApp sender')
    .optional(),
  TWILIO_WHATSAPP_CONTENT_SIDS: z
    .string()
    .regex(
      /^\s*(?:(?:reminder|followup|balance)\.)?[a-z]{2}\s*:\s*HX[0-9a-fA-F]{32}\s*(,\s*(?:(?:reminder|followup|balance)\.)?[a-z]{2}\s*:\s*HX[0-9a-fA-F]{32}\s*)*$/,
      'must be written as sq:HX…,followup.sq:HX…,balance.sq:HX… — an optional message kind, a language and a Content template SID',
    )
    .optional(),

  /** Viber Business Messages through the Vonage Messages API. */
  VIBER_PROVIDER: z.enum(['none', 'vonage']).default('none'),
  VONAGE_API_KEY: z.string().min(1).optional(),
  /** A secret: wrangler secret put VONAGE_API_SECRET. */
  VONAGE_API_SECRET: z.string().min(1).optional(),
  VONAGE_VIBER_SENDER: z.string().min(1).max(40).optional(),
  VONAGE_API_BASE_URL: z.string().url().default('https://api.nexmo.com'),

  // ── Albanian fiscalization (optional) ─────────────────────────────────
  /**
   * The software code the tax authority issued to the maker of this
   * software. Every fiscal invoice carries it, for every clinic. Without it
   * fiscalization is unavailable and the settings screen says so.
   */
  FISCAL_SOFTWARE_CODE: z
    .string()
    .regex(/^[a-z]{2}[0-9]{3}[a-z]{2}[0-9]{3}$/, 'must be the code issued by the tax authority, e.g. ab123cd456')
    .optional(),
  /**
   * Published exchange rates for the second currency on estimates. {base} is
   * replaced with the currency quoted (EUR); the answer must carry
   * rates[CODE] in the ExchangeRate-API open-access shape. A clinic can use a
   * fixed rate of its own instead (Settings → Finance).
   */
  FX_RATES_URL: z.string().url().default('https://open.er-api.com/v6/latest/{base}'),

  /** CIS endpoints. Defaults are the published ones; confirm against DPT's current documentation. */
  FISCAL_CIS_URL_TEST: z.string().url().default('https://efiskalizimi-test.tatime.gov.al/FiscalizationService'),
  FISCAL_CIS_URL_PRODUCTION: z.string().url().default('https://efiskalizimi.tatime.gov.al/FiscalizationService'),
  FISCAL_VERIFY_URL_TEST: z
    .string()
    .url()
    .default('https://efiskalizimi-app-test.tatime.gov.al/invoice-check/#/verify'),
  FISCAL_VERIFY_URL_PRODUCTION: z
    .string()
    .url()
    .default('https://efiskalizimi-app.tatime.gov.al/invoice-check/#/verify'),
  /**
   * The API's public origin, e.g. https://api.dentalcare.com. Delivery
   * receipts are sent here, and their signatures are checked against it.
   */
  PUBLIC_API_URL: z
    .string()
    .url()
    .refine((u) => {
      const parsed = new URL(u);
      return (parsed.pathname === '/' || parsed.pathname === '') && !parsed.search;
    }, 'must be an origin such as https://api.dentalcare.com, with no path')
    .optional(),

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
  /**
   * Where uploads go. Unset: the S3 bucket when one is configured, otherwise
   * this server's own disk (STORAGE_DIR). 'off' disables uploads.
   */
  STORAGE_DRIVER: z.enum(['s3', 'local', 'off']).optional(),
  /** The folder files are kept in on the local backend. Relative to the working directory. */
  STORAGE_DIR: z.string().min(1).optional(),
  /** Signs local download links. Derived from JWT_SECRET when unset. */
  STORAGE_SIGNING_SECRET: z.string().min(32).optional(),
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

    // A malformed keyring is a boot failure everywhere: the alternative is
    // discovering it on the first enrollment, or never being able to open a
    // secret sealed under a key that parsed differently.
    for (const key of ['MFA_ENCRYPTION_KEYS', 'WHATSAPP_ENCRYPTION_KEYS'] as const) {
      const spec = val[key];
      if (!spec) continue;
      try {
        parseKeyring(spec);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: err instanceof Error ? err.message : 'is not a valid keyring',
        });
      }
    }

    // An SMS provider without its credentials would queue every reminder for
    // a channel that cannot send. Refuse to boot instead.
    if (val.SMS_PROVIDER === 'twilio') {
      for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] as const) {
        if (!val[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'required when SMS_PROVIDER=twilio',
          });
        }
      }
      if (!val.TWILIO_FROM && !val.TWILIO_MESSAGING_SERVICE_SID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TWILIO_FROM'],
          message:
            'required when SMS_PROVIDER=twilio — set TWILIO_FROM to a number, or TWILIO_MESSAGING_SERVICE_SID',
        });
      }
    }

    if (val.WHATSAPP_PROVIDER === 'twilio') {
      for (const key of [
        'TWILIO_ACCOUNT_SID',
        'TWILIO_AUTH_TOKEN',
        'TWILIO_WHATSAPP_FROM',
        'TWILIO_WHATSAPP_CONTENT_SIDS',
      ] as const) {
        if (!val[key]) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when WHATSAPP_PROVIDER=twilio' });
        }
      }
    }
    if (val.VIBER_PROVIDER === 'vonage') {
      for (const key of ['VONAGE_API_KEY', 'VONAGE_API_SECRET', 'VONAGE_VIBER_SENDER'] as const) {
        if (!val[key]) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when VIBER_PROVIDER=vonage' });
        }
      }
    }

    if (val.NODE_ENV !== 'production') return;

    // Without a public origin no delivery receipt can come back, and the
    // reminder log could only ever say a message was accepted. Development
    // may live with that; a deployment should not.
    if (val.SMS_PROVIDER === 'twilio' && !val.PUBLIC_API_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBLIC_API_URL'],
        message: 'required in production with SMS_PROVIDER=twilio — delivery receipts are sent to it',
      });
    }

    // The development key is derived from JWT_SECRET, so a leak of that secret
    // would also open every second factor. Production keeps them apart.
    if (!val.MFA_ENCRYPTION_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MFA_ENCRYPTION_KEYS'],
        message:
          'required in production — TOTP secrets are sealed with these keys, and the development fallback derives them from JWT_SECRET',
      });
    }
    if (!val.WHATSAPP_ENCRYPTION_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WHATSAPP_ENCRYPTION_KEYS'],
        message:
          'required in production — clinics’ WhatsApp access tokens are sealed with these keys, and the development fallback derives them from JWT_SECRET',
      });
    }
    if (val.MFA_ENFORCEMENT !== 'required') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MFA_ENFORCEMENT'],
        message: 'must be "required" in production — optional MFA is for development and tests',
      });
    }

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
