import * as fs from 'node:fs';
import * as path from 'node:path';
import { call, startApi, TestApi } from './api';
import { closePools } from './db';
import { TENANT_MIDDLEWARE_EXCLUSIONS } from '@/core/tenancy/tenant-routes';

/**
 * Tenant resolution is the DEFAULT, and the exclusions are the whole list.
 *
 * TenantMiddleware used to be applied by naming thirty-five controllers by
 * hand. That list was correct. The problem is the shape: a clinic controller
 * added without being added to it keeps working, keeps returning rows, and
 * nothing fails — the routes simply run with no clinic established, which is
 * the one condition under which the isolation model has nothing to isolate by.
 *
 * These tests assert the inversion holds, from the outside, over the real
 * route table. Every request below names a clinic that does not exist. A route
 * that IS tenant-resolved answers 404 with the unknown-clinic message, before
 * its controller runs. A route that is excluded gets past the middleware and
 * answers something else — 200, or the 401 its own guard produces.
 *
 * "Answers something other than the tenant 404" is the assertion for excluded
 * routes rather than a specific status, because what they answer is their own
 * business; what matters here is only whether the middleware stopped them.
 */

const ABSENT_CLINIC = 'no-such-clinic-in-this-database';

/** The middleware's 404, which is distinctive enough to test for. */
function isTenantRefusal(status: number, body: unknown): boolean {
  if (status !== 404) return false;
  const message = (body as { message?: string } | null)?.message ?? '';
  return /No clinic with subdomain|Clinic not found/.test(message);
}

let api: TestApi;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.close();
  await closePools();
});

describe('clinic routes are tenant-protected by default', () => {
  /**
   * One route per clinic controller prefix. Not exhaustive over methods —
   * the middleware does not discriminate by method — but exhaustive over the
   * prefixes, which is where a new controller would appear.
   */
  it.each([
    ['/api/auth/me'],
    ['/api/patients'],
    ['/api/appointments'],
    ['/api/operatories'],
    ['/api/availability'],
    ['/api/staff'],
    ['/api/treatments'],
    ['/api/tooth-conditions/00000000-0000-0000-0000-000000000000'],
    ['/api/procedure-codes'],
    ['/api/procedures'],
    ['/api/perio-exams/00000000-0000-0000-0000-000000000000'],
    ['/api/treatment-plans'],
    ['/api/treatment-plan-items/00000000-0000-0000-0000-000000000000'],
    ['/api/settings'],
    ['/api/invoices'],
    ['/api/payments'],
    ['/api/expenses'],
    ['/api/finance/summary'],
    ['/api/reports/revenue'],
    ['/api/billing/summary'],
    ['/api/analytics/overview'],
    ['/api/reminders'],
    ['/api/audit'],
    ['/api/documents/00000000-0000-0000-0000-000000000000'],
    ['/api/patients/00000000-0000-0000-0000-000000000000/chart'],
    ['/api/patients/00000000-0000-0000-0000-000000000000/allergies'],
    ['/api/patients/00000000-0000-0000-0000-000000000000/documents'],
    ['/api/patients/00000000-0000-0000-0000-000000000000/ledger'],
  ])('%s stops at the tenant middleware', async (route) => {
    const res = await call(api, 'GET', route, { subdomain: ABSENT_CLINIC });

    expect(isTenantRefusal(res.status, res.body)).toBe(true);
  });

  /**
   * The point of the inversion, stated directly: a path nobody has ever
   * registered still goes through tenant resolution. A new controller is
   * therefore protected the moment it exists, before anyone remembers it.
   */
  it('a route that does not exist yet is still tenant-resolved', async () => {
    const res = await call(api, 'GET', '/api/a-feature-nobody-has-built-yet', {
      subdomain: ABSENT_CLINIC,
    });

    expect(isTenantRefusal(res.status, res.body)).toBe(true);
  });
});

describe('the excluded routes, and only those', () => {
  it('health answers without a clinic', async () => {
    const res = await call(api, 'GET', '/api/health', { subdomain: ABSENT_CLINIC });

    expect(isTenantRefusal(res.status, res.body)).toBe(false);
    expect([200, 503]).toContain(res.status);
  });

  /**
   * The console operates across clinics. Resolving one for it is meaningless,
   * and the middleware would 404 every console request for want of a
   * subdomain. Its own guard is the boundary — hence 401 here, not 404.
   */
  it.each([
    ['/api/platform/tenants'],
    ['/api/platform/plans'],
    ['/api/platform/auth/me'],
  ])('%s gets past the tenant middleware to its own guard', async (route) => {
    const res = await call(api, 'GET', route, { subdomain: ABSENT_CLINIC });

    expect(isTenantRefusal(res.status, res.body)).toBe(false);
    expect(res.status).toBe(401);
  });

  /**
   * The subtle ones. Google permits one exact redirect URI per client and
   * clinics live on wildcard subdomains, so the callback arrives on the API
   * host with no clinic to read; the clinic travels in a signed state
   * parameter instead. Tenant middleware here would 404 every Google sign-in
   * before the handler could read it.
   */
  it('auth/providers answers without a clinic', async () => {
    const res = await call<{ google: boolean }>(api, 'GET', '/api/auth/providers', {
      subdomain: ABSENT_CLINIC,
    });

    expect(res.status).toBe(200);
    expect(typeof res.body.google).toBe('boolean');
  });

  it.each([['/api/auth/google'], ['/api/auth/google/callback']])(
    '%s gets past the tenant middleware',
    async (route) => {
      const res = await call(api, 'GET', route, { subdomain: ABSENT_CLINIC });

      expect(isTenantRefusal(res.status, res.body)).toBe(false);
    },
  );

  /**
   * The SMS provider's delivery receipts come from its servers, with no
   * clinic. Excluded for POST only: the reminder log under the same prefix
   * still needs a clinic.
   */
  it('the SMS delivery receipt gets past the tenant middleware to its own check', async () => {
    const res = await call(api, 'POST', '/api/reminders/delivery/twilio', {
      subdomain: ABSENT_CLINIC,
      body: {},
    });

    expect(isTenantRefusal(res.status, res.body)).toBe(false);
  });

  /**
   * auth/google shares its prefix with auth/login, auth/refresh,
   * auth/password and auth/me — and those all need a clinic. Excluding the
   * whole `auth` prefix instead of the three Google paths would take tenant
   * resolution off the login route itself.
   */
  it.each([['/api/auth/login'], ['/api/auth/refresh'], ['/api/auth/password']])(
    '%s is NOT excluded despite sharing the auth prefix',
    async (route) => {
      const res = await call(api, 'POST', route, {
        subdomain: ABSENT_CLINIC,
        body: {},
      });

      expect(isTenantRefusal(res.status, res.body)).toBe(true);
    },
  );
});

describe('the exclusion list itself', () => {
  /**
   * Pinned. Every entry is a route that runs with no clinic established, so
   * adding one is a security decision and should read as a deliberate change
   * in review rather than a line in a larger diff.
   */
  it('is exactly the six known exclusions', () => {
    expect(TENANT_MIDDLEWARE_EXCLUSIONS.map((e) => e.path).sort()).toEqual([
      'auth/google',
      'auth/google/callback',
      'auth/providers',
      'health',
      'platform/{*path}',
      'reminders/delivery/twilio',
    ]);
  });

  it('records why each one is excluded', () => {
    for (const exclusion of TENANT_MIDDLEWARE_EXCLUSIONS) {
      expect(exclusion.because).toEqual(expect.any(String));
      expect(exclusion.because.length).toBeGreaterThan(20);
    }
  });

  /**
   * A wildcard that swallowed more than intended is the way this list would
   * fail quietly. `platform/{*path}` is the only pattern, and it is scoped to
   * the other plane.
   */
  it('has no exclusion that could match a clinic route', () => {
    for (const { path: pattern } of TENANT_MIDDLEWARE_EXCLUSIONS) {
      if (!pattern.includes('*')) continue;
      expect(pattern.startsWith('platform/')).toBe(true);
    }
  });
});

describe('no controller is left out by accident', () => {
  /**
   * The old configuration could drift because it named controllers. This one
   * cannot — `forRoutes('{*path}')` covers everything — but the source is
   * checked anyway, so that a future change back to a named list fails here
   * rather than in production.
   */
  it('AppModule applies the middleware to every route', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/app.module.ts'),
      'utf8',
    );

    expect(source).toMatch(/\.forRoutes\(\s*'\{\*path\}'\s*\)/);
    expect(source).toContain('tenantMiddlewareExclusions()');
    // The old shape: a controller named in forRoutes.
    expect(source).not.toMatch(/forRoutes\(\s*\n?\s*[A-Z]\w*Controller/);
  });
});
