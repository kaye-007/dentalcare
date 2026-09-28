import { RequestMethod } from '@nestjs/common';

/**
 * Which routes run WITHOUT a clinic.
 *
 * ── Why this is a deny-list ───────────────────────────────────────────────
 *
 * TenantMiddleware used to be applied by naming controllers — thirty-five of
 * them, by hand. That list is a promise that every future clinic controller
 * gets added to it, and the failure mode when someone forgets is silent: the
 * routes work, they return data, and the data is whichever clinic's rows the
 * connection happened to be able to see. Nothing fails, nothing logs, and the
 * bug is a cross-tenant leak.
 *
 * So the default is inverted. Every route is tenant-resolved, and the ones
 * that must not be are listed here with a reason each. A controller added
 * next month is protected by existing; opting out is an edit to this file,
 * which is a visible act in review.
 *
 * ── Each exclusion ───────────────────────────────────────────────────────
 *
 * `health` answers before anything is known about the caller. It is what the
 * compose healthcheck and any uptime probe hit, and it must not depend on a
 * clinic existing — a deployment with no clinics yet is still a working
 * deployment.
 *
 * `platform/*` is the other plane entirely. The console operates ACROSS
 * clinics — listing them, suspending one, extending a trial — so resolving a
 * single clinic for it is meaningless, and TenantMiddleware would 404 every
 * console request for want of a subdomain. Its own PlatformJwtGuard is the
 * boundary there, and the integration suite asserts the two planes cannot be
 * crossed with each other's tokens.
 *
 * The three Google routes are the subtle ones, and the reason this list is
 * not simply "health and platform". They are clinic routes, but the callback
 * arrives on the API host, which has no clinic subdomain to read: Google
 * permits one exact redirect URI per client, and clinics live on wildcard
 * subdomains. The clinic is carried in a signed `state` parameter and
 * resolved inside OAuthController instead. Tenant middleware here would 404
 * every Google sign-in before the handler could read that state — which is
 * precisely what the old controller-list configuration avoided by omission,
 * and what this list now avoids on purpose.
 *
 * Note what is NOT excluded: `auth/login`, `auth/refresh`, `auth/password`
 * and `auth/me`. They share the `auth` prefix with the Google routes and they
 * all need a clinic.
 */
export interface TenantExclusion {
  path: string;
  method: RequestMethod;
  /** Why this route may run without a clinic. Kept next to the exclusion. */
  because: string;
}

export const TENANT_MIDDLEWARE_EXCLUSIONS: readonly TenantExclusion[] = [
  {
    path: 'health',
    method: RequestMethod.ALL,
    because: 'answers before a clinic is known, and before any clinic exists',
  },
  {
    // Nest 11 matches exclusions with path-to-regexp v8, which has no unnamed
    // `(.*)` group. Nest would auto-convert the old spelling to exactly this —
    // an optional named splat, so bare `platform` still matches as it did —
    // but it logs an "Unsupported route path" warning on every boot to do so.
    path: 'platform/{*path}',
    method: RequestMethod.ALL,
    because: 'the console operates across clinics, not within one',
  },
  {
    path: 'auth/providers',
    method: RequestMethod.ALL,
    because: 'tells a login screen whether to draw the Google button at all',
  },
  {
    path: 'auth/google',
    method: RequestMethod.ALL,
    because: 'names its clinic in ?clinic=, which the guard signs into the state',
  },
  {
    path: 'auth/google/callback',
    method: RequestMethod.ALL,
    because: 'arrives on the API host; the clinic comes from the signed state',
  },
  {
    // POST only. The SMS provider reports delivery from its own servers, with
    // no clinic subdomain. The URL this API gave it names the clinic, the
    // provider's signature covers that URL, and ReminderDeliveryController
    // checks the signature before reading anything.
    path: 'reminders/delivery/twilio',
    method: RequestMethod.POST,
    because:
      'called by the SMS provider; the clinic is named in a URL its signature covers',
  },
  {
    // GET only. Downloads of files kept on the API's own disk. The link was
    // minted inside a clinic request; its HMAC signature covers the key —
    // which starts with that clinic's id — and an expiry, as an S3
    // pre-signed URL would. It needs no clinic of its own to be resolved.
    path: 'files/{*path}',
    method: RequestMethod.GET,
    because: 'a signed, expiring download link; the signature names the clinic’s file',
  },
];

/** The shape Nest's `.exclude()` wants. */
export function tenantMiddlewareExclusions(): { path: string; method: RequestMethod }[] {
  return TENANT_MIDDLEWARE_EXCLUSIONS.map(({ path, method }) => ({ path, method }));
}
